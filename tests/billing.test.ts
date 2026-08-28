import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDb, type DB } from '../src/db/index.js';
import { id, now } from '../src/util/ids.js';
import { assertPriceAllowed, PriceBelowFloorError, retailCentsForSeconds } from '../src/billing/pricing.js';
import { balanceSeconds, debitSeconds, getWallet, topUp, CrossCreatorCreditError } from '../src/billing/wallet.js';
import { createBudget, grantTrialMinutes } from '../src/billing/promotional.js';

function makeCreator(db: DB, price = 75): string {
  const creatorId = id('creator');
  db.prepare(
    `INSERT INTO creators (id, slug, business_name, coach_name, price_per_minute_cents, created_at, updated_at)
     VALUES (?, ?, 'Co', 'Coach', ?, ?, ?)`,
  ).run(creatorId, `slug-${creatorId}`, price, now(), now());
  return creatorId;
}

function makeCustomer(db: DB, creatorId: string): string {
  const customerId = id('cust');
  db.prepare(
    `INSERT INTO customers (id, creator_id, name, phone_e164, verified_at, created_at)
     VALUES (?, ?, 'C', ?, ?, ?)`,
  ).run(customerId, creatorId, `+1555${Math.floor(Math.random() * 10_000_000)}`, now(), now());
  return customerId;
}

describe('price floor', () => {
  it('accepts the floor and above', () => {
    expect(() => assertPriceAllowed(50)).not.toThrow();
    expect(() => assertPriceAllowed(200)).not.toThrow();
  });

  it('rejects anything below it', () => {
    expect(() => assertPriceAllowed(49)).toThrow(PriceBelowFloorError);
    expect(() => assertPriceAllowed(0)).toThrow(PriceBelowFloorError);
    expect(() => assertPriceAllowed(-100)).toThrow(PriceBelowFloorError);
  });
});

describe('wallet', () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it('credits a manual top-up and records it in the ledger', () => {
    const creatorId = makeCreator(db);
    const customerId = makeCustomer(db, creatorId);

    topUp(db, { customerId, creatorId, seconds: 1800, paidCents: 2250 });
    expect(balanceSeconds(db, customerId, creatorId)).toBe(1800);

    const entries = db.prepare('SELECT * FROM ledger WHERE creator_id = ?').all(creatorId) as {
      kind: string;
      cents_delta: number;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('topup');
    expect(entries[0]!.cents_delta).toBe(2250);
  });

  it('keeps balances scoped to one creator', () => {
    const creatorA = makeCreator(db);
    const creatorB = makeCreator(db);
    const customerId = makeCustomer(db, creatorA);
    // The same person, enrolled with a second creator.
    const customerB = makeCustomer(db, creatorB);

    topUp(db, { customerId, creatorId: creatorA, seconds: 600, paidCents: 750 });

    expect(balanceSeconds(db, customerId, creatorA)).toBe(600);
    expect(balanceSeconds(db, customerB, creatorB)).toBe(0);

    // Spending against creator A never touches creator B's books.
    debitSeconds(db, { customerId, creatorId: creatorA, seconds: 60, callId: 'call_1', centsPerMinute: 75 });
    expect(balanceSeconds(db, customerB, creatorB)).toBe(0);
  });

  it('refuses a debit routed to the wrong creator', () => {
    const creatorA = makeCreator(db);
    const creatorB = makeCreator(db);
    const customerId = makeCustomer(db, creatorA);
    topUp(db, { customerId, creatorId: creatorA, seconds: 600, paidCents: 750 });

    // A wallet for (customer, creatorB) is created empty rather than reaching
    // into creator A's balance.
    const res = debitSeconds(db, {
      customerId,
      creatorId: creatorB,
      seconds: 60,
      callId: 'call_x',
      centsPerMinute: 75,
    });
    expect(res.fromPaid).toBe(0);
    expect(res.shortfall).toBe(60);
    expect(balanceSeconds(db, customerId, creatorA)).toBe(600);
  });

  it('spends promotional credit before paid credit', () => {
    const creatorId = makeCreator(db);
    const customerId = makeCustomer(db, creatorId);
    createBudget(db, { creatorId, name: 'Launch', fundedSeconds: 6000, perCustomerSecondsCap: 600 });

    grantTrialMinutes(db, { creatorId, customerId });
    topUp(db, { customerId, creatorId, seconds: 600, paidCents: 750 });

    const res = debitSeconds(db, {
      customerId,
      creatorId,
      seconds: 300,
      callId: 'call_1',
      centsPerMinute: 75,
    });

    expect(res.fromPromotional).toBe(300);
    expect(res.fromPaid).toBe(0);
    expect(res.retailCents).toBe(0); // trial minutes are not revenue

    const wallet = getWallet(db, customerId, creatorId);
    expect(wallet.promotional_seconds).toBe(300);
    expect(wallet.paid_seconds).toBe(600);
  });

  it('reports a shortfall instead of going negative mid-call', () => {
    const creatorId = makeCreator(db);
    const customerId = makeCustomer(db, creatorId);
    topUp(db, { customerId, creatorId, seconds: 30, paidCents: 40 });

    const res = debitSeconds(db, {
      customerId,
      creatorId,
      seconds: 90,
      callId: 'call_1',
      centsPerMinute: 75,
    });

    expect(res.fromPaid).toBe(30);
    expect(res.shortfall).toBe(60);
    expect(res.remainingSeconds).toBe(0);
    expect(balanceSeconds(db, customerId, creatorId)).toBe(0);
  });

  it('prices usage at the creator\'s rate', () => {
    expect(retailCentsForSeconds(60, 75)).toBe(75);
    expect(retailCentsForSeconds(1800, 50)).toBe(1500);
  });
});

describe('promotional budgets', () => {
  let db: DB;
  beforeEach(() => {
    db = createTestDb();
  });

  it('grants nothing when the creator has not funded a trial', () => {
    const creatorId = makeCreator(db);
    const customerId = makeCustomer(db, creatorId);

    const res = grantTrialMinutes(db, { creatorId, customerId });
    expect(res.reason).toBe('no_funding');
    expect(res.granted).toBe(0);
    expect(balanceSeconds(db, customerId, creatorId)).toBe(0);
  });

  it('grants once per account, however many times they call', () => {
    const creatorId = makeCreator(db);
    const customerId = makeCustomer(db, creatorId);
    createBudget(db, { creatorId, name: 'Launch', fundedSeconds: 6000, perCustomerSecondsCap: 600 });

    expect(grantTrialMinutes(db, { creatorId, customerId }).granted).toBe(600);
    const second = grantTrialMinutes(db, { creatorId, customerId });
    expect(second.reason).toBe('already_granted');
    expect(balanceSeconds(db, customerId, creatorId)).toBe(600);
  });

  it('never over-promises a pool across many customers', () => {
    const creatorId = makeCreator(db);
    createBudget(db, { creatorId, name: 'Small', fundedSeconds: 1200, perCustomerSecondsCap: 600 });

    const granted = [0, 1, 2, 3].map(() => grantTrialMinutes(db, { creatorId, customerId: makeCustomer(db, creatorId) }).granted);

    expect(granted.filter((g) => g > 0)).toHaveLength(2);
    expect(granted.reduce((a, b) => a + b, 0)).toBe(1200);
  });

  it('keeps one creator\'s pool away from another\'s customers', () => {
    const funded = makeCreator(db);
    const unfunded = makeCreator(db);
    createBudget(db, { creatorId: funded, name: 'Launch', fundedSeconds: 6000, perCustomerSecondsCap: 600 });

    const theirCustomer = makeCustomer(db, unfunded);
    const res = grantTrialMinutes(db, { creatorId: unfunded, customerId: theirCustomer });

    expect(res.reason).toBe('no_funding');
    expect(balanceSeconds(db, theirCustomer, unfunded)).toBe(0);
  });

  it('charges promotional usage back to the funding pool', () => {
    const creatorId = makeCreator(db);
    const customerId = makeCustomer(db, creatorId);
    const budget = createBudget(db, {
      creatorId,
      name: 'Launch',
      fundedSeconds: 6000,
      perCustomerSecondsCap: 600,
    });

    grantTrialMinutes(db, { creatorId, customerId });
    debitSeconds(db, { customerId, creatorId, seconds: 120, callId: 'call_1', centsPerMinute: 75 });

    const after = db.prepare('SELECT * FROM promotional_budgets WHERE id = ?').get(budget.id) as {
      consumed_seconds: number;
    };
    expect(after.consumed_seconds).toBe(120);
  });
});
