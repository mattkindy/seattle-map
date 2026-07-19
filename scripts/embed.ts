// embed.ts: turn one slice's drive-time matrix into 2D positions whose
// screen distances approximate travel times. Output:
// data/embedding-<slice>.json with, per anchor, the geographic position
// and the time-space position. The math lives in src/embedding.ts.
//
// The matrix is symmetrized (average of the two directions) since drive
// times are mildly asymmetric and a 2D layout can only show one number
// per pair. The result is Procrustes-aligned back to geography so north
// stays up. Residual per-anchor stress is kept for the viewer, since
// where the times exceed what 2D can represent is itself signal (bridge
// shear, mostly).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classicalMds, procrustes, smacof, stress, type Point } from "../src/embedding.ts";
import {
  FREEFLOW,
  type EmbeddingFile,
  type Grid,
  type MatrixFile,
  type Mode,
} from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function main({
  mode = "drive" as Mode,
  slice = FREEFLOW,
} = {}): Promise<void> {
  const grid = JSON.parse(
    fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
  ) as Grid;
  const matrix = JSON.parse(
    fs.readFileSync(path.join(root, "data", `matrix-${mode}-${slice}.json`), "utf8"),
  ) as MatrixFile;
  const { seconds, provider, traffic } = matrix;
  const anchors = grid.anchors;
  const n = anchors.length;

  // Symmetrize; fill the rare null (unroutable pair) with the row mean so
  // it doesn't anchor the layout. Nulls are counted and reported.
  let nulls = 0;
  const D: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = seconds[i][j];
      const b = seconds[j][i];
      let v: number;
      if (a == null && b == null) {
        nulls++;
        v = NaN;
      } else if (a == null) {
        v = b as number;
      } else if (b == null) {
        v = a;
      } else {
        v = (a + b) / 2;
      }
      D[i][j] = v;
    }
  }
  if (nulls > 0) {
    const finite = D.flat().filter((v) => Number.isFinite(v));
    const globalMean = finite.reduce((s, v) => s + v, 0) / finite.length;
    for (let i = 0; i < n; i++) {
      const row = D[i].filter((v) => Number.isFinite(v));
      const mean = row.length
        ? row.reduce((s, v) => s + v, 0) / row.length
        : globalMean;
      for (let j = 0; j < n; j++) {
        if (!Number.isFinite(D[i][j])) {
          D[i][j] = mean;
        }
      }
    }
    console.log(`matrix: filled ${nulls} unroutable pairs`);
  }

  // Geographic layout in km so scales are comparable.
  const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
  const G: Point[] = anchors.map((a) => [a.lng * kmPerDegLng, a.lat * 111.32]);

  let X = classicalMds(D);
  X = smacof(X, D, 150);
  const { total, per } = stress(X, D);
  X = procrustes(X, G);

  const out: EmbeddingFile = {
    provider,
    mode,
    slice,
    traffic,
    stress: Number(total.toFixed(4)),
    anchors: anchors.map((a, i) => ({
      id: a.id,
      lat: a.lat,
      lng: a.lng,
      // time-space position, km-comparable after Procrustes
      tx: Number(X[i][0].toFixed(3)),
      ty: Number(X[i][1].toFixed(3)),
      stress: Number(Math.sqrt(per[i] / n).toFixed(1)),
    })),
  };
  fs.writeFileSync(
    path.join(root, "data", `embedding-${mode}-${slice}.json`),
    JSON.stringify(out, null, 1),
  );
  console.log(
    `embedding: stress ${out.stress} (${provider} ${mode} matrix, slice ${slice}) -> data/embedding-${mode}-${slice}.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({
    mode: (process.argv[2] as Mode) ?? "drive",
    slice: process.argv[3] ?? FREEFLOW,
  });
}
