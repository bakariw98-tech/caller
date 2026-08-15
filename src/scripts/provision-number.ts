/**
 * Provisions a phone number for a creator's coach.
 *
 *   npm run provision -- --creator creator_abc --area 415
 *
 * The webhook signing secret comes back exactly once. It is written to the
 * database inside the same call that creates the number, because a lost secret
 * means every future webhook fails verification and the number has to be
 * provisioned again.
 */
import { applySchema, getDb } from '../db/index.js';
import { config } from '../config.js';
import { id, now } from '../util/ids.js';
import { createPhoneNumber } from '../xai/client.js';
import type { Creator } from '../domain/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  applySchema(getDb());
  const db = getDb();

  const creatorId = arg('creator');
  if (!creatorId) throw new Error('Usage: npm run provision -- --creator <creator_id> [--area 415]');

  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(creatorId) as Creator | undefined;
  if (!creator) throw new Error(`No creator with id ${creatorId}`);

  if (!config.xai.apiKey) throw new Error('XAI_API_KEY is required');
  if (!config.publicBaseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must be a public https URL — xAI has to reach the webhook');
  }

  const webhookUrl = `${config.publicBaseUrl}/webhooks/xai`;
  console.log(`Provisioning a number for ${creator.business_name}, webhook -> ${webhookUrl}`);

  const result = await createPhoneNumber({
    name: `${creator.business_name} — ${creator.coach_name}`,
    webhookUrl,
    areaCode: arg('area'),
  });

  const e164 =
    (result.phone_number as string | undefined) ??
    (result.e164 as string | undefined) ??
    (result.number as string | undefined);
  if (!e164) {
    console.error('Response did not contain a phone number:', JSON.stringify(result, null, 2));
    throw new Error('Could not read the provisioned number from the response');
  }

  const secret = result.signing_secret ?? config.xai.webhookSigningSecret;
  if (!secret) {
    console.error(JSON.stringify(result, null, 2));
    throw new Error(
      'No signing secret in the response. It is returned only once — refusing to store an unverifiable number.',
    );
  }

  db.prepare(
    `INSERT INTO phone_numbers
       (id, creator_id, xai_phone_number_id, e164, sip_host, webhook_id, origin, signing_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'xai_provisioned', ?, ?)`,
  ).run(
    id('pn'),
    creator.id,
    result.phone_number_id,
    e164,
    result.sip_host ?? null,
    result.webhook_id ?? null,
    secret,
    now(),
  );

  console.log(`\n  ${creator.coach_name} is reachable on ${e164}`);
  console.log(`  Signing secret stored for ${e164}. It cannot be retrieved from xAI again.\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
