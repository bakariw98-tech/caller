/**
 * Live calls, keyed by our internal call id.
 *
 * The MCP endpoint needs to act on a call it did not open — a transfer arrives
 * as an HTTP request from xAI, not as an event on the socket — so active
 * sessions register themselves here for the duration of the call.
 */

export interface ActiveCall {
  callId: string;
  xaiCallId: string;
  transferTo(targetE164: string): Promise<void>;
  hangup(reason: string): Promise<void>;
}

const active = new Map<string, ActiveCall>();

export function registerActiveCall(call: ActiveCall): void {
  active.set(call.callId, call);
}

export function getActiveCall(callId: string): ActiveCall | undefined {
  return active.get(callId);
}

export function unregisterActiveCall(callId: string): void {
  active.delete(callId);
}

export function activeCallCount(): number {
  return active.size;
}
