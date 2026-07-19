// Real water geometry from data/water.json (fetched by
// scripts/fetchWater.ts). Lakes and bays are natural=water polygons;
// the Sound is a set of natural=coastline ways that get stitched into
// chains and closed against the map edge on the water side. Shared by
// the grid generator (anchor masking) and the viewer build (basemap).

export type LatLng = [number, number];

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);

export interface OverpassGeomWay {
  type: "way";
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

export interface OverpassGeomRelation {
  type: "relation";
  tags?: Record<string, string>;
  members?: Array<{
    type: string;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
}

export type OverpassGeomElement = OverpassGeomWay | OverpassGeomRelation;

export interface Rect {
  n: number;
  s: number;
  e: number;
  w: number;
}

export function pointInRing(lat: number, lng: number, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function ringAreaKm2(ring: LatLng[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    a += xj * kmPerDegLng * (yi * KM_PER_DEG_LAT) - xi * kmPerDegLng * (yj * KM_PER_DEG_LAT);
  }
  return Math.abs(a / 2);
}

// Sutherland-Hodgman polygon clip against a lat/lng rectangle.
export function clipRing(ring: LatLng[], rect: Rect): LatLng[] {
  type Test = (p: LatLng) => boolean;
  type Cross = (a: LatLng, b: LatLng) => LatLng;
  const edges: Array<[Test, Cross]> = [
    [(p) => p[0] <= rect.n, (a, b) => {
      const f = (rect.n - a[0]) / (b[0] - a[0]);
      return [rect.n, a[1] + f * (b[1] - a[1])];
    }],
    [(p) => p[0] >= rect.s, (a, b) => {
      const f = (rect.s - a[0]) / (b[0] - a[0]);
      return [rect.s, a[1] + f * (b[1] - a[1])];
    }],
    [(p) => p[1] <= rect.e, (a, b) => {
      const f = (rect.e - a[1]) / (b[1] - a[1]);
      return [a[0] + f * (b[0] - a[0]), rect.e];
    }],
    [(p) => p[1] >= rect.w, (a, b) => {
      const f = (rect.w - a[1]) / (b[1] - a[1]);
      return [a[0] + f * (b[0] - a[0]), rect.w];
    }],
  ];
  let poly = ring;
  for (const [inside, cross] of edges) {
    const next: LatLng[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ain = inside(a);
      const bin = inside(b);
      if (ain) {
        next.push(a);
      }
      if (ain !== bin) {
        next.push(cross(a, b));
      }
    }
    poly = next;
    if (poly.length === 0) {
      return [];
    }
  }
  return poly;
}

// Stitch open segments into rings and chains by matching endpoints.
// preserveOrientation forbids reversing segments; coastline ways are
// consistently digitized with water on the right, and the closure test
// depends on that convention surviving the stitch.
export function assembleSegments(
  segs: LatLng[][],
  preserveOrientation = false,
): { rings: LatLng[][]; chains: LatLng[][] } {
  const key = (p: LatLng) => p[0].toFixed(6) + "," + p[1].toFixed(6);
  const at = new Map<string, number[]>();
  segs.forEach((seg, i) => {
    for (const end of [seg[0], seg[seg.length - 1]]) {
      const k = key(end);
      let list = at.get(k);
      if (!list) {
        at.set(k, (list = []));
      }
      list.push(i);
    }
  });
  const used = new Uint8Array(segs.length);
  const rings: LatLng[][] = [];
  const chains: LatLng[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) {
      continue;
    }
    used[i] = 1;
    let chain = [...segs[i]];
    for (let guard = 0; guard < segs.length; guard++) {
      const endKey = key(chain[chain.length - 1]);
      if (endKey === key(chain[0]) && chain.length > 3) {
        break; // closed
      }
      const next = (at.get(endKey) ?? []).find(
        (j) => !used[j] && (!preserveOrientation || key(segs[j][0]) === endKey),
      );
      if (next === undefined) {
        // try extending at the head instead
        const headKey = key(chain[0]);
        const prev = (at.get(headKey) ?? []).find(
          (j) =>
            !used[j] &&
            (!preserveOrientation || key(segs[j][segs[j].length - 1]) === headKey),
        );
        if (prev === undefined) {
          break;
        }
        used[prev] = 1;
        let seg = segs[prev];
        if (key(seg[seg.length - 1]) !== headKey) {
          seg = [...seg].reverse();
        }
        chain = [...seg.slice(0, -1), ...chain];
        continue;
      }
      used[next] = 1;
      let seg = segs[next];
      if (key(seg[0]) !== endKey) {
        seg = [...seg].reverse();
      }
      chain = [...chain, ...seg.slice(1)];
    }
    if (key(chain[0]) === key(chain[chain.length - 1]) && chain.length > 3) {
      rings.push(chain.slice(0, -1));
    } else {
      chains.push(chain);
    }
  }
  return { rings, chains };
}

// Close an open coastline chain along the rectangle perimeter. OSM
// convention puts water on the right of the way direction; both closure
// directions are tried, and the winner must contain a probe just right
// of the chain while excluding one just left of it.
export function closeChain(chain: LatLng[], rect: Rect): LatLng[] | null {
  const clamp = (p: LatLng): LatLng => [
    Math.min(rect.n, Math.max(rect.s, p[0])),
    Math.min(rect.e, Math.max(rect.w, p[1])),
  ];
  const pos = (pRaw: LatLng): number => {
    const [la, lo] = clamp(pRaw);
    const dN = rect.n - la;
    const dE = rect.e - lo;
    const dS = la - rect.s;
    const dW = lo - rect.w;
    const m = Math.min(dN, dE, dS, dW);
    if (m === dN) return 0 + (lo - rect.w) / (rect.e - rect.w);
    if (m === dE) return 1 + (rect.n - la) / (rect.n - rect.s);
    if (m === dS) return 2 + (rect.e - lo) / (rect.e - rect.w);
    return 3 + (la - rect.s) / (rect.n - rect.s);
  };
  const at = (t: number): LatLng => {
    const side = ((Math.floor(t) % 4) + 4) % 4;
    const f = t - Math.floor(t);
    if (side === 0) return [rect.n, rect.w + f * (rect.e - rect.w)];
    if (side === 1) return [rect.n - f * (rect.n - rect.s), rect.e];
    if (side === 2) return [rect.s, rect.e - f * (rect.e - rect.w)];
    return [rect.s + f * (rect.n - rect.s), rect.w];
  };
  // probe just right of the chain's midpoint direction
  const mi = chain.length >> 1;
  const a = chain[Math.max(0, mi - 1)];
  const b = chain[Math.min(chain.length - 1, mi + 1)];
  const dx = (b[1] - a[1]) * kmPerDegLng;
  const dy = (b[0] - a[0]) * KM_PER_DEG_LAT;
  const len = Math.hypot(dx, dy) || 1;
  const probeKmR = 0.3;
  const probe: LatLng = [
    chain[mi][0] + (-dx / len) * (probeKmR / KM_PER_DEG_LAT),
    chain[mi][1] + (dy / len) * (probeKmR / kmPerDegLng),
  ];
  const landProbe: LatLng = [
    chain[mi][0] + (dx / len) * (probeKmR / KM_PER_DEG_LAT),
    chain[mi][1] + (-dy / len) * (probeKmR / kmPerDegLng),
  ];
  for (const dir of [1, -1] as const) {
    const ring = [...chain];
    let t = pos(chain[chain.length - 1]);
    const tStart = pos(chain[0]);
    for (let guard = 0; guard < 9; guard++) {
      const distToStart =
        dir === 1 ? (tStart - t + 4) % 4 : (t - tStart + 4) % 4;
      const nextCornerT = dir === 1 ? Math.floor(t + 1e-9) + 1 : Math.ceil(t - 1e-9) - 1;
      const distToCorner =
        dir === 1 ? (nextCornerT - t + 4) % 4 : (t - nextCornerT + 4) % 4;
      if (distToCorner >= distToStart || distToStart === 0) {
        break;
      }
      ring.push(at(nextCornerT));
      t = nextCornerT;
    }
    if (
      pointInRing(probe[0], probe[1], ring) &&
      !pointInRing(landProbe[0], landProbe[1], ring)
    ) {
      return ring;
    }
  }
  return null;
}

// Known points used to sanity-check an assembled water set: four that
// must be wet, three that must be dry.
export const WATER_PROBES: Array<[number, number, string, boolean]> = [
  [47.598, -122.37, "Elliott Bay", true],
  [47.64, -122.334, "Lake Union", true],
  [47.68, -122.335, "Green Lake", true],
  [47.66, -122.26, "Lake Washington", true],
  [47.61, -122.332, "Downtown", false],
  [47.668, -122.384, "Ballard", false],
  [47.657, -122.406, "Discovery Park", false],
];

export function buildWater(
  elements: OverpassGeomElement[],
  rect: Rect,
): LatLng[][] {
  const toLL = (g: Array<{ lat: number; lon: number }>): LatLng[] =>
    g.map((p) => [p.lat, p.lon]);
  const closed: LatLng[][] = [];
  const waterSegs: LatLng[][] = [];
  const coastSegs: LatLng[][] = [];
  const isWaterTag = (tags?: Record<string, string>) =>
    tags?.natural === "water" || tags?.waterway === "riverbank";
  for (const el of elements) {
    if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
      const pts = toLL(el.geometry);
      const isClosed =
        pts[0][0] === pts[pts.length - 1][0] &&
        pts[0][1] === pts[pts.length - 1][1];
      if (el.tags?.natural === "coastline") {
        coastSegs.push(pts);
      } else if (isWaterTag(el.tags)) {
        if (isClosed) {
          closed.push(pts.slice(0, -1));
        } else {
          waterSegs.push(pts);
        }
      }
    } else if (el.type === "relation" && isWaterTag(el.tags)) {
      for (const m of el.members ?? []) {
        if (m.type === "way" && m.role === "outer" && m.geometry) {
          waterSegs.push(toLL(m.geometry));
        }
      }
    }
  }
  const assembledWater = assembleSegments(waterSegs);
  closed.push(...assembledWater.rings);
  const coast = assembleSegments(coastSegs, true);
  // A closed coastline ring is an island: land, not water.
  const out: LatLng[][] = [];
  for (const chain of coast.chains) {
    const ring = closeChain(chain, rect);
    if (ring) {
      out.push(ring);
    }
  }
  out.push(...closed);
  return out
    .map((r) => clipRing(r, rect))
    .filter((r) => r.length >= 4 && ringAreaKm2(r) >= 0.2);
}

// Validate assembled rings against the probe set. Returns the failures.
export function validateWater(rings: LatLng[][]): string[] {
  const failures: string[] = [];
  for (const [la, lo, name, expectWater] of WATER_PROBES) {
    const inWater = rings.some((r) => pointInRing(la, lo, r));
    if (inWater !== expectWater) {
      failures.push(`${name} expected ${expectWater ? "water" : "land"}`);
    }
  }
  return failures;
}
