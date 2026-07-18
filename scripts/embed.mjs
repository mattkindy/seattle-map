// embed.mjs — turn the drive-time matrix into 2D positions whose
// screen distances approximate travel times. Output: data/embedding.json
// with, per anchor, the geographic position and the time-space position.
//
// Method: classical MDS for the initial layout, refined by SMACOF-style
// stress majorization (both from scratch; no dependencies). The matrix
// is symmetrized (average of the two directions) since drive times are
// mildly asymmetric and a 2D layout can only honor one number per pair.
//
// The result is anchored back to geography: Procrustes-align the
// embedding to the lat/lng layout (translation, rotation, reflection,
// uniform scale) so north stays up and the map reads as Seattle rather
// than an arbitrary rotation of it. The residual per-anchor stress is
// kept for the viewer, since where 2D can't honor the times is itself
// signal (bridge shear, mostly).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const grid = JSON.parse(
  fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
);
const { seconds, provider } = JSON.parse(
  fs.readFileSync(path.join(root, "data", "matrix.json"), "utf8"),
);
const anchors = grid.anchors;
const n = anchors.length;

// Symmetrize; fill the rare null (unroutable pair) with the row mean so
// it doesn't anchor the layout. Nulls are counted and reported.
let nulls = 0;
const D = Array.from({ length: n }, () => new Array(n).fill(0));
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    const a = seconds[i][j];
    const b = seconds[j][i];
    let v;
    if (a == null && b == null) {
      nulls++;
      v = NaN;
    } else if (a == null) {
      v = b;
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
    const mean = row.length ? row.reduce((s, v) => s + v, 0) / row.length : globalMean;
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(D[i][j])) {
        D[i][j] = mean;
      }
    }
  }
  console.log(`matrix: filled ${nulls} unroutable pairs`);
}

// ------------------------------------------------------------------
// Classical MDS: double-center the squared-distance matrix, take the
// top-2 eigenvectors by power iteration with deflation.
// ------------------------------------------------------------------

function classicalMds(D) {
  const D2 = D.map((row) => row.map((v) => v * v));
  const rowMean = D2.map((r) => r.reduce((s, v) => s + v, 0) / n);
  const grand = rowMean.reduce((s, v) => s + v, 0) / n;
  // B = -0.5 * J D2 J
  const B = Array.from({ length: n }, (_, i) =>
    Array.from(
      { length: n },
      (_, j) => -0.5 * (D2[i][j] - rowMean[i] - rowMean[j] + grand),
    ),
  );
  function powerIter(B, deflate) {
    let v = Array.from({ length: n }, () => Math.random() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 300; it++) {
      let w = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const Bi = B[i];
        let s = 0;
        for (let j = 0; j < n; j++) {
          s += Bi[j] * v[j];
        }
        w[i] = s;
      }
      if (deflate) {
        const { vec, val } = deflate;
        let dot = 0;
        for (let i = 0; i < n; i++) {
          dot += vec[i] * w[i];
        }
        for (let i = 0; i < n; i++) {
          w[i] -= val * vec[i] * (dot / val);
        }
      }
      const norm = Math.hypot(...w);
      v = w.map((x) => x / norm);
      lambda = norm;
    }
    return { vec: v, val: lambda };
  }
  const e1 = powerIter(B, null);
  const e2 = powerIter(B, e1);
  return anchors.map((_, i) => [
    e1.vec[i] * Math.sqrt(Math.max(e1.val, 0)),
    e2.vec[i] * Math.sqrt(Math.max(e2.val, 0)),
  ]);
}

// ------------------------------------------------------------------
// SMACOF refinement: iteratively move each point toward positions that
// better honor the target distances. Monotone in stress.
// ------------------------------------------------------------------

function smacof(X, D, iters) {
  for (let it = 0; it < iters; it++) {
    const next = X.map(() => [0, 0]);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          continue;
        }
        const dx = X[i][0] - X[j][0];
        const dy = X[i][1] - X[j][1];
        const dist = Math.hypot(dx, dy) || 1e-9;
        const ratio = D[i][j] / dist;
        next[i][0] += X[j][0] + ratio * dx;
        next[i][1] += X[j][1] + ratio * dy;
      }
      next[i][0] /= n - 1;
      next[i][1] /= n - 1;
    }
    for (let i = 0; i < n; i++) {
      X[i] = next[i];
    }
  }
  return X;
}

function stress(X, D) {
  let num = 0;
  let den = 0;
  const per = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(X[i][0] - X[j][0], X[i][1] - X[j][1]);
      const e = (d - D[i][j]) ** 2;
      num += e;
      den += D[i][j] ** 2;
      per[i] += e;
      per[j] += e;
    }
  }
  return { total: Math.sqrt(num / den), per };
}

// ------------------------------------------------------------------
// Procrustes: align embedding to geography (rotation/reflection/scale/
// translation) so the cartogram sits over the real map.
// ------------------------------------------------------------------

function procrustes(X, G) {
  const cx = mean(X.map((p) => p[0]));
  const cy = mean(X.map((p) => p[1]));
  const gx = mean(G.map((p) => p[0]));
  const gy = mean(G.map((p) => p[1]));
  const Xc = X.map(([x, y]) => [x - cx, y - cy]);
  const Gc = G.map(([x, y]) => [x - gx, y - gy]);
  // Cross-covariance
  let sxx = 0;
  let sxy = 0;
  let syx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += Gc[i][0] * Xc[i][0];
    sxy += Gc[i][0] * Xc[i][1];
    syx += Gc[i][1] * Xc[i][0];
    syy += Gc[i][1] * Xc[i][1];
  }
  // Optimal rotation for max trace(G^T R X): atan2(syx - sxy, sxx + syy).
  const theta = Math.atan2(syx - sxy, sxx + syy);
  const det = sxx * syy - sxy * syx;
  const reflect = det < 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let rot = Xc.map(([x, y]) => [cos * x - sin * y, sin * x + cos * y]);
  if (reflect) {
    // Reflect across x-axis then re-derive rotation cheaply: try both,
    // keep whichever correlates better with geography.
    const refl = Xc.map(([x, y]) => [x, -y]);
    const thetaR = Math.atan2(
      sxy + syx,
      sxx - syy,
    );
    const cR = Math.cos(thetaR);
    const sR = Math.sin(thetaR);
    const rotR = refl.map(([x, y]) => [cR * x - sR * y, sR * x + cR * y]);
    if (corr(rotR, Gc) > corr(rot, Gc)) {
      rot = rotR;
    }
  }
  const scale =
    sum(rot.map((p, i) => p[0] * Gc[i][0] + p[1] * Gc[i][1])) /
    sum(rot.map((p) => p[0] ** 2 + p[1] ** 2));
  return rot.map(([x, y]) => [x * scale + gx, y * scale + gy]);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sum = (a) => a.reduce((s, v) => s + v, 0);
function corr(A, G) {
  return sum(A.map((p, i) => p[0] * G[i][0] + p[1] * G[i][1]));
}

// ------------------------------------------------------------------

// Geographic layout in km so scales are comparable.
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
const G = anchors.map((a) => [a.lng * kmPerDegLng, a.lat * 111.32]);

let X = classicalMds(D);
X = smacof(X, D, 150);
const { total, per } = stress(X, D);
X = procrustes(X, G);

const out = {
  provider,
  edges: grid.edges ?? [],
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
  path.join(root, "data", "embedding.json"),
  JSON.stringify(out, null, 1),
);
// Inline copy so docs/index.html opens from file:// and serves on Pages.
fs.writeFileSync(
  path.join(root, "docs", "embedding.js"),
  `window.EMBEDDING = ${JSON.stringify(out)};
`,
);
console.log(
  `embedding: stress ${out.stress} (${provider} matrix) -> data/embedding.json`,
);
