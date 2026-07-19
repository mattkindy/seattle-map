// pipeline.ts: grid -> osm -> per-slice matrix + embedding -> viewer.
//
// Traffic captures are live reads of current conditions, so they are
// not part of the deterministic pipeline; take one with fetchTraffic.ts
// when the moment is right. The pipeline embeds the freeflow baseline
// plus every slice already captured in data/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FREEFLOW } from "../src/types.ts";
import { main as generateGrid } from "./generateGrid.ts";
import { main as fetchOsm } from "./fetchOsm.ts";
import { main as fetchWater } from "./fetchWater.ts";
import { main as fetchMatrix } from "./fetchMatrix.ts";
import { main as embed } from "./embed.ts";
import { main as buildViewer } from "./buildViewer.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function main(): Promise<void> {
  await generateGrid();
  await fetchOsm();
  await fetchWater();

  const captured = fs
    .readdirSync(path.join(root, "data"))
    .filter((f) => f.startsWith("traffic-") && f.endsWith(".json"))
    .map((f) => f.slice("traffic-".length, -".json".length));

  for (const slice of [FREEFLOW, ...captured.sort()]) {
    await fetchMatrix({ slice });
    await embed({ slice });
  }
  await buildViewer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
