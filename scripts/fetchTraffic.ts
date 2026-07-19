// fetchTraffic.ts: capture a named traffic time slice for the anchor
// grid. Output: data/traffic-<slice>.json with a speed reading per
// anchor (see src/traffic for the provider contract).
//
//   npx tsx scripts/fetchTraffic.ts friday-evening "Friday evening"
//
// The slice id names the files downstream (matrix-<slice>.json,
// embedding-<slice>.json); the label is what the site shows. "freeflow"
// is reserved for the no-traffic baseline and cannot be captured.
// Provider: TomTom when TOMTOM_API_KEY is set, else the modeled profile;
// TRAFFIC_PROVIDER overrides by name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectProvider } from "../src/lib/providers.ts";
import { SPEED_PROVIDERS } from "../src/traffic/index.ts";
import { FREEFLOW, type Grid, type TrafficFile } from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export interface FetchTrafficOptions {
  slice: string;
  label?: string;
}

export async function main({ slice, label }: FetchTrafficOptions): Promise<void> {
  if (!slice || slice === FREEFLOW) {
    throw new Error(
      `a captured slice needs a name other than "${FREEFLOW}" (the reserved baseline)`,
    );
  }
  const grid = JSON.parse(
    fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
  ) as Grid;

  const ctx = {
    env: process.env,
    root,
    log: (m: string) => process.stderr.write(m),
  };
  const provider = selectProvider(SPEED_PROVIDERS, ctx, process.env.TRAFFIC_PROVIDER);
  ctx.log(`traffic: provider ${provider.name}, slice ${slice}\n`);

  const readings = await provider.read(grid.anchors, ctx);

  const out: TrafficFile = {
    slice,
    label: label ?? slice,
    provider: provider.name,
    capturedAt: new Date().toISOString(),
    readings,
  };
  const file = path.join(root, "data", `traffic-${slice}.json`);
  fs.writeFileSync(file, JSON.stringify(out));

  const factors = readings.map((r) => r.factor);
  const mean = factors.reduce((s, x) => s + x, 0) / factors.length;
  const max = factors.reduce((m, x) => Math.max(m, x), 0);
  console.log(
    `traffic: ${readings.length} readings (${provider.name}), ` +
      `mean slowdown ${mean.toFixed(2)}x, max ${max.toFixed(2)}x -> data/traffic-${slice}.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [slice, ...labelWords] = process.argv.slice(2);
  await main({
    slice: slice ?? "rush",
    label: labelWords.length ? labelWords.join(" ") : undefined,
  });
}
