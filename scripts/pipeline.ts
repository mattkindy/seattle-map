// pipeline.ts: grid -> osm -> per-slice matrix + embedding -> viewer.
//
// Traffic captures are live reads of current conditions, so they are
// not part of the deterministic pipeline; take one with fetchTraffic.ts
// when the moment is right. The pipeline embeds the freeflow baseline
// plus every slice already captured in data/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TRANSIT_SLICES } from "../src/transit/slices.ts";
import { dataFileExists } from "../src/lib/data.ts";
import { FREEFLOW, type Mode } from "../src/types.ts";
import { main as generateGrid } from "./generateGrid.ts";
import { main as fetchOsm } from "./fetchOsm.ts";
import { main as fetchWater } from "./fetchWater.ts";
import { main as fetchMatrix } from "./fetchMatrix.ts";
import { main as embed } from "./embed.ts";
import { main as buildViewer } from "./buildViewer.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Base data everything else depends on. The grid generates twice on a
// fresh environment: once to bootstrap (fetchOsm and fetchWater read
// its bounds), then again once the real water geometry exists so the
// anchor mask matches every other environment.
export async function prepare(): Promise<void> {
  await generateGrid();
  await fetchOsm();
  await fetchWater();
  await generateGrid();
}

export async function main(): Promise<void> {
  await prepare();

  const captured = fs
    .readdirSync(path.join(root, "data"))
    .filter((f) => f.startsWith("traffic-") && f.endsWith(".json"))
    .map((f) => f.slice("traffic-".length, -".json".length));

  const plan: Array<[Mode, string]> = [
    ...[FREEFLOW, ...captured.sort()].map((s): [Mode, string] => ["drive", s]),
  ];
  // Transit builds only when the feeds have been fetched (npm run gtfs).
  if (
    fs.existsSync(path.join(root, "data", "gtfs")) &&
    dataFileExists(path.join(root, "data", "osm.json"))
  ) {
    for (const s of TRANSIT_SLICES) {
      plan.push(["transit", s.id]);
    }
  }
  for (const [mode, slice] of plan) {
    await fetchMatrix({ mode, slice });
    await embed({ mode, slice });
  }
  await buildViewer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--prepare")) {
    await prepare();
  } else {
    await main();
  }
}
