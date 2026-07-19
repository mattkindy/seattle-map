// Multidimensional scaling: place points in 2D so screen distance
// approximates a target distance matrix. Classical MDS seeds the layout
// (double-center the squared-distance matrix, top-2 eigenvectors by
// power iteration), SMACOF-style stress majorization refines it, and
// Procrustes aligns the result to a reference layout (translation,
// rotation, reflection, uniform scale) so north stays up. All from
// scratch; no dependencies.

export type Point = [number, number];

export function classicalMds(D: number[][]): Point[] {
  const n = D.length;
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
  interface Eigen {
    vec: number[];
    val: number;
  }
  function powerIter(deflate: Eigen | null): Eigen {
    let v = Array.from({ length: n }, () => Math.random() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 300; it++) {
      const w = new Array(n).fill(0);
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
  const e1 = powerIter(null);
  const e2 = powerIter(e1);
  return Array.from({ length: n }, (_, i) => [
    e1.vec[i] * Math.sqrt(Math.max(e1.val, 0)),
    e2.vec[i] * Math.sqrt(Math.max(e2.val, 0)),
  ]);
}

// SMACOF refinement: iteratively move each point toward positions that
// reduce the gap to the target distances. Monotone in stress. An
// optional weight matrix makes the objective relative rather than
// absolute: with w = 1/d^2, a 10-minute pair drawn 5 minutes off
// matters as much as an 80-minute pair drawn 40 minutes off. Transit
// needs this; its matrix spans a 10x dynamic range and the hour-long
// walk-dominated pairs would otherwise twist local structure.
export function smacof(
  X: Point[],
  D: number[][],
  iters: number,
  W?: number[][],
): Point[] {
  const n = D.length;
  for (let it = 0; it < iters; it++) {
    const next: Point[] = X.map(() => [0, 0]);
    for (let i = 0; i < n; i++) {
      let wsum = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) {
          continue;
        }
        const w = W ? W[i][j] : 1;
        const dx = X[i][0] - X[j][0];
        const dy = X[i][1] - X[j][1];
        const dist = Math.hypot(dx, dy) || 1e-9;
        const ratio = D[i][j] / dist;
        next[i][0] += w * (X[j][0] + ratio * dx);
        next[i][1] += w * (X[j][1] + ratio * dy);
        wsum += w;
      }
      next[i][0] /= wsum;
      next[i][1] /= wsum;
    }
    for (let i = 0; i < n; i++) {
      X[i] = next[i];
    }
  }
  return X;
}

export interface Stress {
  total: number;
  per: number[];
}

export function stress(X: Point[], D: number[][]): Stress {
  const n = D.length;
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

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const corr = (A: Point[], G: Point[]) =>
  sum(A.map((p, i) => p[0] * G[i][0] + p[1] * G[i][1]));

// Procrustes: align X to the reference layout G.
export function procrustes(X: Point[], G: Point[]): Point[] {
  const n = X.length;
  const cx = mean(X.map((p) => p[0]));
  const cy = mean(X.map((p) => p[1]));
  const gx = mean(G.map((p) => p[0]));
  const gy = mean(G.map((p) => p[1]));
  const Xc: Point[] = X.map(([x, y]) => [x - cx, y - cy]);
  const Gc: Point[] = G.map(([x, y]) => [x - gx, y - gy]);
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
  let rot: Point[] = Xc.map(([x, y]) => [cos * x - sin * y, sin * x + cos * y]);
  if (reflect) {
    // Reflect across x-axis then re-derive rotation; keep whichever
    // correlates better with the reference.
    const refl: Point[] = Xc.map(([x, y]) => [x, -y]);
    const thetaR = Math.atan2(sxy + syx, sxx - syy);
    const cR = Math.cos(thetaR);
    const sR = Math.sin(thetaR);
    const rotR: Point[] = refl.map(([x, y]) => [cR * x - sR * y, sR * x + cR * y]);
    if (corr(rotR, Gc) > corr(rot, Gc)) {
      rot = rotR;
    }
  }
  const scale =
    sum(rot.map((p, i) => p[0] * Gc[i][0] + p[1] * Gc[i][1])) /
    sum(rot.map((p) => p[0] ** 2 + p[1] ** 2));
  return rot.map(([x, y]) => [x * scale + gx, y * scale + gy]);
}
