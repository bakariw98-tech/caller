/**
 * Same math as src/billing/pricing.ts. Reimplemented rather than imported
 * because the Node version reads thresholds off the process.env-backed config
 * singleton; here they come from the per-request Env instead.
 */

export class PriceBelowFloorError extends Error {
  constructor(cents: number, floorCents: number) {
    super(
      `Price of ${cents}¢/min is below the platform floor of ${floorCents}¢/min ($${(floorCents / 100).toFixed(2)}/min).`,
    );
    this.name = 'PriceBelowFloorError';
  }
}

export function assertPriceAllowed(centsPerMinute: number, floorCents: number): void {
  if (!Number.isInteger(centsPerMinute) || centsPerMinute <= 0 || centsPerMinute < floorCents) {
    throw new PriceBelowFloorError(centsPerMinute, floorCents);
  }
}

export function retailCentsForSeconds(seconds: number, centsPerMinute: number): number {
  return Math.round((seconds / 60) * centsPerMinute);
}

export function estimateCostCents(params: {
  audioInMs: number;
  audioOutMs: number;
  centsPerAudioMinute: number;
}): number {
  const audioMinutes = (params.audioInMs + params.audioOutMs) / 1000 / 60;
  return Math.round(audioMinutes * params.centsPerAudioMinute);
}
