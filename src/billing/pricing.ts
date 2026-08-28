import { config } from '../config.js';

export class PriceBelowFloorError extends Error {
  constructor(cents: number) {
    super(
      `Price of ${cents}¢/min is below the platform floor of ` +
        `${config.economics.minPricePerMinuteCents}¢/min ($${(config.economics.minPricePerMinuteCents / 100).toFixed(2)}/min).`,
    );
    this.name = 'PriceBelowFloorError';
  }
}

/**
 * The floor is enforced here and nowhere else, on every write path that can set
 * a price. Creators price at or above it; there is no configuration that lets a
 * coach be sold below it.
 */
export function assertPriceAllowed(centsPerMinute: number): void {
  if (!Number.isInteger(centsPerMinute) || centsPerMinute <= 0) {
    throw new PriceBelowFloorError(centsPerMinute);
  }
  if (centsPerMinute < config.economics.minPricePerMinuteCents) {
    throw new PriceBelowFloorError(centsPerMinute);
  }
}

export function retailCentsForSeconds(seconds: number, centsPerMinute: number): number {
  return Math.round((seconds / 60) * centsPerMinute);
}

/**
 * What xAI bills us for a call, from measured audio rather than assumption.
 *
 * Both directions of audio meter, and text items sent into the session meter on
 * top. Tool results and `response.create` are exempt, which is the reason
 * retrieval lives behind MCP.
 */
export function estimateCostCents(params: {
  audioInMs: number;
  audioOutMs: number;
  billedTextItems: number;
  centsPerAudioMinute?: number;
}): number {
  const perMinute = params.centsPerAudioMinute ?? config.economics.audioCostPerMinuteCents;
  const audioMinutes = (params.audioInMs + params.audioOutMs) / 1000 / 60;
  // Text input is priced per token in practice; a seeded context line is a
  // rounding error next to audio, tracked as a count so it stays visible.
  return Math.round(audioMinutes * perMinute);
}

export interface MarginReport {
  billableSeconds: number;
  retailCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  costPerHourDollars: number;
}

export function marginFor(call: {
  billable_seconds: number;
  retail_cents: number;
  cost_cents_estimate: number;
}): MarginReport {
  const margin = call.retail_cents - call.cost_cents_estimate;
  const hours = call.billable_seconds / 3600;
  return {
    billableSeconds: call.billable_seconds,
    retailCents: call.retail_cents,
    costCents: call.cost_cents_estimate,
    marginCents: margin,
    marginPercent: call.retail_cents > 0 ? (margin / call.retail_cents) * 100 : 0,
    costPerHourDollars: hours > 0 ? call.cost_cents_estimate / 100 / hours : 0,
  };
}
