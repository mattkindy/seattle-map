// buildViewer.ts: assemble docs/embedding.js for the site from every
// embedded slice (freeflow baseline plus each captured traffic slice),
// the shared mesh edges, and a table of example routes with per-slice
// minutes and distortion factors. The site is static; this file is the
// whole data hand-off, inlined so docs/index.html opens from file:// and
// serves on Pages.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FREEFLOW,
  type EmbeddingFile,
  type Grid,
  type MatrixFile,
  type TrafficFile,
} from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");

// Example routes for the site: pairs people actually drive, spanning
// the compressed corridors and the stretched crossings.
const ROUTES: Array<{ name: string; a: [number, number]; b: [number, number] }> = [
  { name: "Northgate to Downtown", a: [47.708, -122.328], b: [47.606, -122.333] },
  { name: "Green Lake to Georgetown", a: [47.6805, -122.322], b: [47.548, -122.323] },
  { name: "Ballard to U District", a: [47.668, -122.384], b: [47.66, -122.313] },
  { name: "Magnolia to Capitol Hill", a: [47.647, -122.4], b: [47.623, -122.316] },
  { name: "West Seattle to Ballard", a: [47.566, -122.387], b: [47.668, -122.384] },
];

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
const KM_PER_MILE = 1.60934;

export async function main(): Promise<void> {
  const grid = JSON.parse(
    fs.readFileSync(path.join(dataDir, "grid.json"), "utf8"),
  ) as Grid;

  const sliceIds = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("embedding-") && f.endsWith(".json"))
    .map((f) => f.slice("embedding-".length, -".json".length));
  // Freeflow baseline first, then captures in capture order.
  const ordered = [
    ...sliceIds.filter((s) => s === FREEFLOW),
    ...sliceIds.filter((s) => s !== FREEFLOW).sort(),
  ];
  if (!ordered.includes(FREEFLOW)) {
    throw new Error("no freeflow embedding; run the pipeline first");
  }

  const nearestAnchor = (lat: number, lng: number): number => {
    let best = 0;
    let bd = Infinity;
    grid.anchors.forEach((p, i) => {
      const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const slices = ordered.map((slice) => {
    const emb = JSON.parse(
      fs.readFileSync(path.join(dataDir, `embedding-${slice}.json`), "utf8"),
    ) as EmbeddingFile;
    let label = "Free flow";
    let capturedAt: string | null = null;
    if (slice !== FREEFLOW) {
      const traffic = JSON.parse(
        fs.readFileSync(path.join(dataDir, `traffic-${slice}.json`), "utf8"),
      ) as TrafficFile;
      label = traffic.label;
      capturedAt = traffic.capturedAt;
    }
    return {
      id: slice,
      label,
      capturedAt,
      traffic: emb.traffic,
      stress: emb.stress,
      anchors: emb.anchors,
    };
  });

  const matrices = new Map(
    ordered.map((slice) => [
      slice,
      (
        JSON.parse(
          fs.readFileSync(path.join(dataDir, `matrix-${slice}.json`), "utf8"),
        ) as MatrixFile
      ).seconds,
    ]),
  );

  const routes = ROUTES.map(({ name, a, b }) => {
    const ai = nearestAnchor(a[0], a[1]);
    const bi = nearestAnchor(b[0], b[1]);
    const pa = grid.anchors[ai];
    const pb = grid.anchors[bi];
    const geoKm = Math.hypot(
      (pa.lat - pb.lat) * KM_PER_DEG_LAT,
      (pa.lng - pb.lng) * kmPerDegLng,
    );
    const minutes: Record<string, number> = {};
    const factor: Record<string, number> = {};
    for (const slice of ordered) {
      const seconds = matrices.get(slice) as (number | null)[][];
      const there = seconds[ai][bi];
      const back = seconds[bi][ai];
      const s =
        there != null && back != null ? (there + back) / 2 : (there ?? back);
      minutes[slice] = s == null ? NaN : Number((s / 60).toFixed(1));
      const anchors = (slices.find((x) => x.id === slice) as (typeof slices)[0])
        .anchors;
      const qa = anchors[ai];
      const qb = anchors[bi];
      factor[slice] = Number(
        (Math.hypot(qa.tx - qb.tx, qa.ty - qb.ty) / geoKm).toFixed(2),
      );
    }
    return {
      name,
      ai,
      bi,
      miles: Number((geoKm / KM_PER_MILE).toFixed(1)),
      minutes,
      factor,
    };
  });

  const payload = { edges: grid.edges, slices, routes };
  fs.writeFileSync(
    path.join(root, "docs", "embedding.js"),
    `window.EMBEDDING = ${JSON.stringify(payload)};\n`,
  );
  console.log(
    `viewer: ${slices.length} slices (${ordered.join(", ")}), ` +
      `${routes.length} routes -> docs/embedding.js`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
