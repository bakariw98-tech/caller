import WebSocket from 'ws';
import type { DB } from '../db/index.js';
import { config } from '../config.js';
import { id, now } from '../util/ids.js';
import type { Creator } from '../domain/types.js';
import { buildResponseCreate, buildSeedItem, buildSessionUpdate } from '../coach/session-config.js';
import { buildNudgeInstructions } from '../coach/prompt.js';
import { debitSeconds } from '../billing/wallet.js';
import { estimateCostCents, retailCentsForSeconds } from '../billing/pricing.js';
import { hangupCall, referCall, telUri } from '../xai/client.js';
import { revokeCallTokens } from '../mcp/auth.js';
import { registerActiveCall, unregisterActiveCall, type ActiveCall } from './registry.js';

export interface CallSessionParams {
  db: DB;
  callId: string;
  xaiCallId: string;
  creator: Creator;
  customerId: string | null;
  instructions: string;
  seedText: string;
  mcpToken: string;
  /** Null for an unidentified caller, who is not metered against a wallet. */
  meterWallet: boolean;
  initialBalanceSeconds: number;
  reasoningEffort?: 'high' | 'none';
  logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}

const METER_INTERVAL_MS = 15_000;

/**
 * One live coaching call.
 *
 * The socket carries control only. xAI terminates the phone leg itself for a
 * SIP `call_id` session, so no audio crosses this connection — what happens
 * here is configuration, steering, metering and teardown.
 */
export class CallSession implements ActiveCall {
  readonly callId: string;
  readonly xaiCallId: string;

  private ws: WebSocket | null = null;
  private readonly db: DB;
  private readonly params: CallSessionParams;
  private meterTimer: NodeJS.Timeout | null = null;

  private connectedAt: number | null = null;
  private lastMeterAt = 0;
  private billedSeconds = 0;
  private promoSeconds = 0;
  private retailCents = 0;
  private audioInMs = 0;
  private audioOutMs = 0;
  private billedTextItems = 0;
  private remainingSeconds: number;

  private lowWarned = false;
  private finalWarned = false;
  private ended = false;
  private endReason: string | null = null;

  constructor(params: CallSessionParams) {
    this.params = params;
    this.db = params.db;
    this.callId = params.callId;
    this.xaiCallId = params.xaiCallId;
    this.remainingSeconds = params.initialBalanceSeconds;
  }

  private log(obj: Record<string, unknown>, msg: string): void {
    this.params.logger?.info({ callId: this.callId, ...obj }, msg);
  }

  async start(): Promise<void> {
    const url = `${config.xai.realtimeUrl}?call_id=${encodeURIComponent(this.xaiCallId)}`;
    // SIP call_id sessions authenticate with the account key; ephemeral client
    // secrets are for browser sessions and are rejected here.
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${config.xai.apiKey}` },
    });
    this.ws = ws;
    registerActiveCall(this);

    ws.on('open', () => this.onOpen());
    ws.on('message', (raw) => this.onMessage(raw));
    ws.on('error', (err) => {
      this.params.logger?.error({ callId: this.callId, err }, 'realtime socket error');
      void this.finish('socket_error');
    });
    ws.on('close', () => {
      void this.finish(this.endReason ?? 'socket_closed');
    });
  }

  private onOpen(): void {
    this.connectedAt = now();
    this.lastMeterAt = Date.now();

    this.db
      .prepare("UPDATE calls SET status = 'active', connected_at = ? WHERE id = ?")
      .run(this.connectedAt, this.callId);

    this.send(
      buildSessionUpdate({
        instructions: this.params.instructions,
        voice: this.params.creator.coach_voice,
        mcpToken: this.params.mcpToken,
        reasoningEffort: this.params.reasoningEffort ?? 'none',
      }),
    );

    // Exactly one billable text item for the whole call.
    this.send(buildSeedItem(this.params.seedText));
    this.billedTextItems++;

    this.send(buildResponseCreate());

    this.meterTimer = setInterval(() => this.meter(), METER_INTERVAL_MS);
    this.log({ xaiCallId: this.xaiCallId }, 'call connected');
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private onMessage(raw: WebSocket.RawData): void {
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (evt.type) {
      case 'error':
        this.params.logger?.error({ callId: this.callId, error: evt.error }, 'realtime error event');
        break;

      // Audio duration, where the server reports it. Wall clock remains the
      // authoritative meter; these figures are for verifying real cost against
      // the assumed rate rather than for billing the customer.
      case 'response.audio.done':
      case 'response.output_audio.done':
        if (typeof evt.duration_ms === 'number') this.audioOutMs += evt.duration_ms;
        break;
      case 'input_audio_buffer.committed':
        if (typeof evt.duration_ms === 'number') this.audioInMs += evt.duration_ms;
        break;

      case 'input_audio_buffer.timeout_triggered':
        // The caller has gone quiet, which on a coaching call usually means they
        // are doing the step rather than that they have left.
        this.send(buildResponseCreate(buildNudgeInstructions('idle_check')));
        break;

      case 'session.updated':
        this.log({}, 'session configured');
        break;

      default:
        break;
    }
  }

  /**
   * Charges elapsed wall-clock time and decides whether the call can continue.
   *
   * Warnings are delivered through `response.create` instructions rather than a
   * seeded conversation item: steering is exempt from the text meter, so a
   * warning costs nothing beyond the audio it produces.
   */
  private meter(): void {
    if (this.ended || !this.connectedAt) return;

    const elapsedMs = Date.now() - this.lastMeterAt;
    const seconds = Math.floor(elapsedMs / 1000);
    if (seconds <= 0) return;
    this.lastMeterAt += seconds * 1000;
    this.billedSeconds += seconds;

    if (this.params.meterWallet && this.params.customerId) {
      const res = debitSeconds(this.db, {
        customerId: this.params.customerId,
        creatorId: this.params.creator.id,
        seconds,
        callId: this.callId,
        centsPerMinute: this.params.creator.price_per_minute_cents,
      });
      this.promoSeconds += res.fromPromotional;
      this.retailCents += res.retailCents;
      this.remainingSeconds = res.remainingSeconds;
    } else {
      this.remainingSeconds = Math.max(0, this.remainingSeconds - seconds);
    }

    const totalElapsed = now() - this.connectedAt;
    if (totalElapsed >= config.call.maxSessionSeconds) {
      void this.hangup('session_cap');
      return;
    }

    if (this.remainingSeconds <= 0) {
      // The final warning has already been spoken by this point in the normal
      // path; hanging up mid-sentence is the thing being avoided here.
      void this.hangup('out_of_credit');
      return;
    }

    if (!this.finalWarned && this.remainingSeconds <= config.call.finalWarningSeconds) {
      this.finalWarned = true;
      this.send(buildResponseCreate(buildNudgeInstructions('final_warning')));
      this.log({ remaining: this.remainingSeconds }, 'final credit warning');
      return;
    }

    if (!this.lowWarned && this.remainingSeconds <= config.call.lowBalanceWarningSeconds) {
      this.lowWarned = true;
      this.send(
        buildResponseCreate(
          buildNudgeInstructions('low_balance', Math.max(1, Math.floor(this.remainingSeconds / 60))),
        ),
      );
      this.log({ remaining: this.remainingSeconds }, 'low balance warning');
    }
  }

  async transferTo(targetE164: string): Promise<void> {
    this.endReason = 'transferred';
    await referCall(this.xaiCallId, telUri(targetE164));
    this.log({ target: targetE164 }, 'call transferred via SIP REFER');
    // The socket closes once the REFER completes; finish() runs from there.
  }

  async hangup(reason: string): Promise<void> {
    if (this.ended) return;
    this.endReason = reason;
    try {
      await hangupCall(this.xaiCallId);
    } catch (err) {
      this.params.logger?.error({ callId: this.callId, err }, 'hangup request failed');
    }
    await this.finish(reason);
  }

  /** Idempotent teardown: settles the final seconds, writes totals, revokes tokens. */
  private async finish(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    if (this.meterTimer) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }

    // Charge the sliver since the last tick so a short call is not free.
    if (this.connectedAt) {
      const trailing = Math.floor((Date.now() - this.lastMeterAt) / 1000);
      if (trailing > 0) {
        this.billedSeconds += trailing;
        if (this.params.meterWallet && this.params.customerId) {
          const res = debitSeconds(this.db, {
            customerId: this.params.customerId,
            creatorId: this.params.creator.id,
            seconds: trailing,
            callId: this.callId,
            centsPerMinute: this.params.creator.price_per_minute_cents,
          });
          this.promoSeconds += res.fromPromotional;
          this.retailCents += res.retailCents;
        }
      }
    }

    const costCents = estimateCostCents({
      audioInMs: this.audioInMs,
      audioOutMs: this.audioOutMs,
      billedTextItems: this.billedTextItems,
    });

    // Audio events are not guaranteed on a SIP session, where media never
    // crosses this socket. Falling back to wall clock keeps the margin report
    // honest rather than reporting a cost of zero.
    const measuredCost =
      this.audioInMs + this.audioOutMs > 0
        ? costCents
        : retailCentsForSeconds(this.billedSeconds, config.economics.audioCostPerMinuteCents);

    const enrollmentRow = this.db
      .prepare('SELECT enrollment_id FROM calls WHERE id = ?')
      .get(this.callId) as { enrollment_id: string | null } | undefined;
    const exitStep = enrollmentRow?.enrollment_id
      ? (this.db
          .prepare('SELECT current_step_id AS s FROM enrollments WHERE id = ?')
          .get(enrollmentRow.enrollment_id) as { s: string | null } | undefined)
      : undefined;

    this.db
      .prepare(
        `UPDATE calls
            SET status = 'ended', ended_at = ?, end_reason = ?, billable_seconds = ?,
                seconds_from_promo = ?, retail_cents = ?, audio_in_ms = ?, audio_out_ms = ?,
                billed_text_items = ?, cost_cents_estimate = ?, exit_step_id = ?
          WHERE id = ?`,
      )
      .run(
        now(),
        reason,
        this.billedSeconds,
        this.promoSeconds,
        this.retailCents,
        this.audioInMs,
        this.audioOutMs,
        this.billedTextItems,
        measuredCost,
        exitStep?.s ?? null,
        this.callId,
      );

    this.db
      .prepare(
        `INSERT INTO call_events (id, call_id, creator_id, type, payload_json, created_at)
         VALUES (?, ?, ?, 'call_ended', ?, ?)`,
      )
      .run(
        id('ev'),
        this.callId,
        this.params.creator.id,
        JSON.stringify({ reason, billedSeconds: this.billedSeconds }),
        now(),
      );

    revokeCallTokens(this.db, this.callId);
    unregisterActiveCall(this.callId);

    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }

    this.log({ reason, seconds: this.billedSeconds, retailCents: this.retailCents }, 'call ended');
  }
}
