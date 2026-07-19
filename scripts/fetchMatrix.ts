// fetchMatrix.ts: produce the pairwise drive-time matrix for one time
// slice. Output: data/matrix-<slice>.json ({ mode, provider, slice,
// traffic, seconds } where seconds[i][j] is anchor i -> anchor j).
//
//   npx tsx scripts/fetchMatrix.ts             # freeflow baseline
//   npx tsx scripts/fetchMatrix.ts friday-evening
//
// A non-freeflow slice requires its captured data/traffic-<slice>.json
// (see fetchTraffic.ts). The matrix provider comes from src/matrix:
// google when GOOGLE_MAPS_API_KEY is set, road once data/osm.json
// exists, synthetic otherwise; MATRIX_PROVIDER overrides by name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { selectProvider } from "../src/lib/providers.ts";
import { providersFor } from "../src/matrix/index.ts";
import {
  FREEFLOW,
  type Grid,
  type MatrixFile,
  type Mode,
  type TrafficFile,
} from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function main({
  mode = "drive" as Mode,
  slice = FREEFLOW,
} = {}): Promise<void> {
  const grid = JSON.parse(
    fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
  ) as Grid;
  const anchors = grid.anchors;

  let traffic: { provider: string; readings: TrafficFile["readings"] } | null = null;
  if (mode === "drive" && slice !== FREEFLOW) {
    const trafficPath = path.join(root, "data", `traffic-${slice}.json`);
    if (!fs.existsSync(trafficPath)) {
      throw new Error(
        `slice "${slice}" has no capture; run fetchTraffic.ts ${slice} first`,
      );
    }
    const file = JSON.parse(fs.readFileSync(trafficPath, "utf8")) as TrafficFile;
    traffic = { provider: file.provider, readings: file.readings };
  }

  const ctx = {
    env: process.env,
    root,
    log: (m: string) => process.stderr.write(m),
    slice,
    traffic,
  };
  const provider = selectProvider(
    providersFor(mode),
    ctx,
    mode === "drive" ? process.env.MATRIX_PROVIDER : undefined,
  );
  const seconds = await provider.build(anchors, ctx);

  const out: MatrixFile = {
    mode,
    provider: provider.name,
    slice,
    traffic: traffic?.provider ?? null,
    n: anchors.length,
    seconds,
  };
  fs.writeFileSync(
    path.join(root, "data", `matrix-${mode}-${slice}.json`),
    JSON.stringify(out),
  );
  console.log(
    `matrix: ${anchors.length}x${anchors.length} ${provider.name} ${mode} matrix, ` +
      `slice ${slice}${traffic ? ` (${traffic.provider} traffic)` : ""} -> data/matrix-${mode}-${slice}.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({
    mode: (process.argv[2] as Mode) ?? "drive",
    slice: process.argv[3] ?? FREEFLOW,
  });
}
