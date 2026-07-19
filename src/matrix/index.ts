// A matrix provider produces the anchor-to-anchor drive-time matrix for
// one time slice. Same registry pattern as the speed providers: each
// source is one file implementing the interface, selection is by
// availability in registry order, MATRIX_PROVIDER overrides by name.
//
// The slice's traffic readings (null for the freeflow baseline) are part
// of the build context. The road provider applies them to edge weights;
// google would map a slice to a departure_time instead; synthetic
// ignores them.

import type { Provider, ProviderCtx } from "../lib/providers.ts";
import type { Anchor } from "../types.ts";
import type { Reading } from "../traffic/index.ts";
import { google } from "./google.ts";
import { road } from "./road.ts";
import { synthetic } from "./synthetic.ts";
import { transit } from "./transit.ts";

export interface MatrixCtx extends ProviderCtx {
  slice: string;
  traffic: { provider: string; readings: Reading[] } | null;
}

export interface MatrixProvider extends Provider {
  build(anchors: Anchor[], ctx: MatrixCtx): Promise<(number | null)[][]>;
}

// Preference order: paid measured source, then routing over fetched OSM
// data, then the synthetic model (always available, keeps the pipeline
// runnable with zero setup).
export const DRIVE_PROVIDERS: readonly MatrixProvider[] = [
  google,
  road,
  synthetic,
];

export const TRANSIT_PROVIDERS: readonly MatrixProvider[] = [transit];

export function providersFor(mode: string): readonly MatrixProvider[] {
  return mode === "transit" ? TRANSIT_PROVIDERS : DRIVE_PROVIDERS;
}
