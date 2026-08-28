import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { wrapD1 } from '../db/d1-adapter.js';
import { buildResponseCreate, buildSeedItem, buildSessionUpdate, type SessionToolSet } from '../coach/session-config.js';
import { buildNudgeInstructions } from '../../src/coach/prompt.js';
import { debitSeconds } from '../billing/wallet.js';
import { estimateCostCents, retailCentsForSeconds } from '../billing/pricing.js';
import { referCall, hangupCall, telUri } from '../xai/client.js';
import { revokeCallTokens } from '../mcp/auth.js';
import { id, now } from '../../src/util/ids.js';
import { triggerQualificationFollowup } from '../telephony/qualification-followup.js';

export interface StartCallParams {
  callId: string; // our internal id — also the DO's name
  xaiCallId: string;
  creatorId: string;
  creatorVoice: string;
  customerId: string | null;
  instructions: string;
  seedText: string;
  mcpToken: string;
  meterWallet: boolean;
  initialBalanceSeconds: number;
  centsPerMinute: number;
  audioCostPerMinuteCents: number;
  maxSessionSeconds: number;
  lowBalanceWarningSeconds: number;
  finalWarningSeconds: number;
  idleTimeoutMs: number;
  /** Which MCP tools this call is allowed to see. Omitted means the coach's own default set. */
  toolSet?: SessionToolSet;
}

const METER_INTERVAL_MS = 15_000;

/**
 * One live coaching call, as a Durable Object.
 *
 * This is the direct port of src/telephony/call-session.ts. The concepts carry
 * over exactly — control channel only, wall-clock metering, exempt
 * steering — but the mechanics differ in two places worth knowing:
 *
 * 1. The outbound WebSocket to xAI is opened via `fetch()` with an
 *    `Upgrade: websocket` header (Workers' documented client pattern), using
 *    an https:// URL even though xAI publishes this as wss:// — a WebSocket
 *    upgrade is an HTTP mechanism over TLS either way. Unverified against a
 *    live call; see docs/XAI-API-NOTES.md.
 * 2. Metering runs on the Durable Object Alarm API instead of `setInterval`.
 *    An outbound WebSocket keeps a DO resident for up to 15 minutes on its
 *    own; alarms are the documented, eviction-safe way to guarantee the next
 *    tick regardless. For a call under 15 minutes — any test call — this
 *    distinction will not actually matter, but it is the correct primitive to
 *    reach for and costs nothing extra to use.
 */
export class CallSessionDO extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private params: StartCallParams | null = null;

  private connectedAt: number | null = null;
  private lastMeterAtMs = 0;
  private billedSeconds = 0;
  private promoSeconds = 0;
  private retailCents = 0;
  private audioInMs = 0;
  private audioOutMs = 0;
  private remainingSeconds = 0;

  private lowWarned = false;
  private finalWarned = false;
  private ended = false;
  private endReason: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/start' && request.method === 'POST') {
      if (this.params) return new Response('already started', { status: 409 });
      const params = (await request.json()) as StartCallParams;
      this.params = params;
      this.remainingSeconds = params.initialBalanceSeconds;
      // Fire-and-forget: the caller (the webhook handler) only needs to know
      // the session accepted the job, not that xAI has answered yet.
      this.startCall(params).catch((err) => console.error('call session failed to start', err));
      return new Response('started', { status: 202 });
    }

    if (url.pathname === '/transfer' && request.method === 'POST') {
      const { targetE164 } = (await request.json()) as { targetE164: string };
      try {
        await this.transferTo(targetE164);
        return new Response('ok');
      } catch (err) {
        return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
      }
    }

    if (url.pathname === '/hangup' && request.method === 'POST') {
      const { reason } = (await request.json().catch(() => ({ reason: 'requested' }))) as { reason?: string };
      await this.hangup(reason ?? 'requested');
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  private db() {
    return wrapD1(this.env.DB);
  }

  private async startCall(params: StartCallParams): Promise<void> {
    // xAI publishes this host as wss://; fetch() only accepts http(s) schemes,
    // and the Upgrade header is what actually negotiates the WebSocket — same
    // wire protocol, different JS-level scheme requirement. XAI_REALTIME_HOST
    // is just the bare host (e.g. "api.x.ai"), separate from XAI_API_BASE
    // (the https:// REST base) since this one request needs http(s) forced
    // regardless of how the realtime endpoint is documented elsewhere.
    const target = `https://${this.env.XAI_REALTIME_HOST}/v1/realtime?call_id=${encodeURIComponent(params.xaiCallId)}`;

    const resp = await fetch(target, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${this.env.XAI_API_KEY}`,
      },
    });

    const ws = resp.webSocket;
    if (!ws) {
      console.error('xAI did not accept the WebSocket upgrade', resp.status, await resp.text().catch(() => ''));
      await this.finish('connect_failed');
      return;
    }

    ws.accept();
    this.ws = ws;

    ws.addEventListener('message', (evt) => this.onMessage(evt));
    ws.addEventListener('close', () => void this.finish(this.endReason ?? 'socket_closed'));
    ws.addEventListener('error', (evt) => {
      console.error('realtime socket error', evt);
      void this.finish('socket_error');
    });

    this.connectedAt = now();
    this.lastMeterAtMs = Date.now();

    await this.db()
      .prepare("UPDATE calls SET status = 'active', connected_at = ? WHERE id = ?")
      .run(this.connectedAt, params.callId);

    const mcpUrl = `${this.env.PUBLIC_BASE_URL}/mcp`;
    this.send(
      buildSessionUpdate({
        instructions: params.instructions,
        voice: params.creatorVoice,
        mcpToken: params.mcpToken,
        mcpUrl,
        reasoningEffort: 'none',
        idleTimeoutMs: params.idleTimeoutMs,
        toolSet: params.toolSet,
      }),
    );

    this.send(buildSeedItem(params.seedText));
    this.send(buildResponseCreate());

    await this.ctx.storage.setAlarm(Date.now() + METER_INTERVAL_MS);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws) this.ws.send(JSON.stringify(payload));
  }

  private onMessage(evt: MessageEvent): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(typeof evt.data === 'string' ? evt.data : '');
    } catch {
      return;
    }

    switch (msg.type) {
      case 'error':
        console.error('realtime error event', msg.error);
        break;
      case 'response.audio.done':
      case 'response.output_audio.done':
        if (typeof msg.duration_ms === 'number') this.audioOutMs += msg.duration_ms;
        break;
      case 'input_audio_buffer.committed':
        if (typeof msg.duration_ms === 'number') this.audioInMs += msg.duration_ms;
        break;
      case 'input_audio_buffer.timeout_triggered':
        this.send(buildResponseCreate(buildNudgeInstructions('idle_check')));
        break;
      default:
        break;
    }
  }

  /** Fired by the DO Alarm API roughly every METER_INTERVAL_MS while the call is live. */
  async alarm(): Promise<void> {
    if (this.ended || !this.params || !this.connectedAt) return;
    await this.meter();
    if (!this.ended) await this.ctx.storage.setAlarm(Date.now() + METER_INTERVAL_MS);
  }

  private async meter(): Promise<void> {
    const params = this.params!;
    const elapsedMs = Date.now() - this.lastMeterAtMs;
    const seconds = Math.floor(elapsedMs / 1000);
    if (seconds <= 0) return;
    this.lastMeterAtMs += seconds * 1000;
    this.billedSeconds += seconds;

    if (params.meterWallet && params.customerId) {
      const res = await debitSeconds(this.db(), {
        customerId: params.customerId,
        creatorId: params.creatorId,
        seconds,
        callId: params.callId,
        centsPerMinute: params.centsPerMinute,
      });
      this.promoSeconds += res.fromPromotional;
      this.retailCents += res.retailCents;
      this.remainingSeconds = res.remainingSeconds;
    } else {
      this.remainingSeconds = Math.max(0, this.remainingSeconds - seconds);
    }

    const totalElapsed = now() - this.connectedAt!;
    if (totalElapsed >= params.maxSessionSeconds) {
      await this.hangup('session_cap');
      return;
    }
    if (this.remainingSeconds <= 0) {
      await this.hangup('out_of_credit');
      return;
    }

    if (!this.finalWarned && this.remainingSeconds <= params.finalWarningSeconds) {
      this.finalWarned = true;
      this.send(buildResponseCreate(buildNudgeInstructions('final_warning')));
      return;
    }
    if (!this.lowWarned && this.remainingSeconds <= params.lowBalanceWarningSeconds) {
      this.lowWarned = true;
      this.send(buildResponseCreate(buildNudgeInstructions('low_balance', Math.max(1, Math.floor(this.remainingSeconds / 60)))));
    }
  }

  async transferTo(targetE164: string): Promise<void> {
    if (!this.params) throw new Error('call not started');
    this.endReason = 'transferred';
    await referCall(this.env.XAI_API_BASE, this.env.XAI_API_KEY, this.params.xaiCallId, telUri(targetE164));
  }

  async hangup(reason: string): Promise<void> {
    if (this.ended || !this.params) return;
    this.endReason = reason;
    try {
      await hangupCall(this.env.XAI_API_BASE, this.env.XAI_API_KEY, this.params.xaiCallId);
    } catch (err) {
      console.error('hangup request failed', err);
    }
    await this.finish(reason);
  }

  /**
   * Always writes a terminal record, even when the call never connected — a
   * caller whose only event was `startCall` failing the WebSocket upgrade
   * (bad key, xAI outage, whatever) must not be left stuck at `status:
   * 'ringing'` forever. Billing math only runs for a call that actually
   * reached `connectedAt`, since nothing was ever metered before that.
   */
  private async finish(reason: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.ctx.storage.deleteAlarm();

    const params = this.params;
    if (!params) return; // /start was never called on this object at all

    if (this.connectedAt) {
      const trailing = Math.floor((Date.now() - this.lastMeterAtMs) / 1000);
      if (trailing > 0) {
        this.billedSeconds += trailing;
        if (params.meterWallet && params.customerId) {
          const res = await debitSeconds(this.db(), {
            customerId: params.customerId,
            creatorId: params.creatorId,
            seconds: trailing,
            callId: params.callId,
            centsPerMinute: params.centsPerMinute,
          });
          this.promoSeconds += res.fromPromotional;
          this.retailCents += res.retailCents;
        }
      }
    }

    const costCents =
      this.audioInMs + this.audioOutMs > 0
        ? estimateCostCents({
            audioInMs: this.audioInMs,
            audioOutMs: this.audioOutMs,
            centsPerAudioMinute: params.audioCostPerMinuteCents,
          })
        : retailCentsForSeconds(this.billedSeconds, params.audioCostPerMinuteCents);

    const enrollmentRow = await this.db()
      .prepare('SELECT enrollment_id AS enrollmentId FROM calls WHERE id = ?')
      .get<{ enrollmentId: string | null }>(params.callId);
    const exitStep = enrollmentRow?.enrollmentId
      ? await this.db()
          .prepare('SELECT current_step_id AS s FROM enrollments WHERE id = ?')
          .get<{ s: string | null }>(enrollmentRow.enrollmentId)
      : undefined;

    await this.db()
      .prepare(
        `UPDATE calls
            SET status = ?, ended_at = ?, end_reason = ?, billable_seconds = ?,
                seconds_from_promo = ?, retail_cents = ?, audio_in_ms = ?, audio_out_ms = ?,
                billed_text_items = ?, cost_cents_estimate = ?, exit_step_id = ?
          WHERE id = ?`,
      )
      .run(
        this.connectedAt ? 'ended' : 'rejected',
        now(),
        reason,
        this.billedSeconds,
        this.promoSeconds,
        this.retailCents,
        this.audioInMs,
        this.audioOutMs,
        this.connectedAt ? 1 : 0,
        costCents,
        exitStep?.s ?? null,
        params.callId,
      );

    await this.db()
      .prepare(
        `INSERT INTO call_events (id, call_id, creator_id, type, payload_json, created_at)
         VALUES (?, ?, ?, 'call_ended', ?, ?)`,
      )
      .run(id('ev'), params.callId, params.creatorId, JSON.stringify({ reason, billedSeconds: this.billedSeconds }), now());

    await revokeCallTokens(this.db(), params.callId);

    // Best-effort: a follow-up email failing must never block the call
    // itself from cleanly finishing and releasing its tokens/socket above.
    await triggerQualificationFollowup(this.db(), this.env, params.callId, params.creatorId).catch((err) =>
      console.error('qualification follow-up failed', params.callId, err),
    );

    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }
}
