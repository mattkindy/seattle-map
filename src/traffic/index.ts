// A speed provider reports road speed conditions across a set of sample
// points. For each point it returns the slowdown factor (free-flow time
// over current time's inverse: >= 1) of the nearest road, plus the two
// speeds when the source measures them. applyTraffic (roadRouter)
// interpolates the factors onto edge weights. Measured sources (TomTom
// now, HERE or WSDOT later) fill in speeds; the modeled fallback
// supplies only the factor.
//
// Providers see only coordinates; that the points are the embedding's
// anchor grid is the caller's business (scripts/fetchTraffic.ts). Two
// known limits of this contract, both extendable without breaking it:
// readings are point-sampled (a segment-native source like WSDOT route
// times would project onto points; per-edge attribution would arrive as
// an optional readSegments capability), and a read reflects conditions
// at call time (the captured slice is named and stamped by the caller;
// a historical source would take a requested moment via its own config).

import type { Provider, ProviderCtx } from "../lib/providers.ts";
import { tomtom } from "./tomtom.ts";
import { modeled } from "./modeled.ts";

export interface Reading {
  lat: number;
  lng: number;
  /** Slowdown versus free-flow near this point; always >= 1. */
  factor: number;
  currentKmh: number | null;
  freeFlowKmh: number | null;
}

export interface SpeedProvider extends Provider {
  read(
    points: ReadonlyArray<{ lat: number; lng: number }>,
    ctx: ProviderCtx,
  ): Promise<Reading[]>;
}

// Measured sources first; the modeled fallback is always available and
// therefore last. TRAFFIC_PROVIDER overrides by name.
export const SPEED_PROVIDERS: readonly SpeedProvider[] = [tomtom, modeled];

// A slowdown factor is >= 1 (traffic never speeds you up) and capped so a
// single stalled or closed sensor cannot blow up a whole route.
export function clampFactor(x: number, cap = 4): number {
  if (!Number.isFinite(x) || x < 1) {
    return 1;
  }
  return Math.min(x, cap);
}
