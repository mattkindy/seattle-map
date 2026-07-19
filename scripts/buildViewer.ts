// buildViewer.ts: assemble docs/embedding.js for the site from every
// embedded slice (freeflow baseline plus each captured traffic slice),
// the shared mesh edges, and a table of example routes with per-slice
// minutes, distortion factors, and the driving route itself. The site is
// static; this file is the whole data hand-off, inlined so
// docs/index.html opens from file:// and serves on Pages.
//
// Each route's drawn path is the shortest-time drive over the road
// network, emitted as downsampled road geometry; the page warps those
// vertices through the anchor displacement field, the same warp the
// basemap uses. Routes can differ per slice when congestion changes the
// fastest road.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyTraffic,
  buildGraph,
  dijkstraPath,
  largestScc,
  makeSnapper,
  type OsmElement,
  type RoadGraph,
} from "../src/roadRouter.ts";
import type { Reading } from "../src/traffic/index.ts";
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
  { name: "Ballard to Capitol Hill", a: [47.668, -122.384], b: [47.623, -122.316] },
  { name: "Northgate to Pike Place", a: [47.708, -122.328], b: [47.6094, -122.3417] },
  { name: "Green Lake to Georgetown", a: [47.6805, -122.322], b: [47.548, -122.323] },
  { name: "Magnolia to Capitol Hill", a: [47.647, -122.4], b: [47.623, -122.316] },
  { name: "West Seattle to Ballard", a: [47.566, -122.387], b: [47.668, -122.384] },
];

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
const KM_PER_MILE = 1.60934;

// Basemap street tiers by highway class. Tier drives stroke width in
// the viewer; classes absent here (residential and below) stay off the
// basemap to keep the payload small.
const STREET_TIER: Record<string, number> = {
  motorway: 0,
  motorway_link: 0,
  trunk: 0,
  trunk_link: 0,
  primary: 1,
  primary_link: 1,
  secondary: 2,
  tertiary: 3,
};
// Drop vertices closer than this to the last kept one; street shape at
// map scale survives far coarser sampling than routing needs.
const SIMPLIFY_M = 90;
// Water ring segments longer than this get midpoints inserted so the
// outline bends with the warp instead of cutting straight across it.
const DENSIFY_M = 300;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return Math.hypot(
    (aLat - bLat) * KM_PER_DEG_LAT * 1000,
    (aLng - bLng) * kmPerDegLng * 1000,
  );
}

type LatLng = [number, number];

interface Basemap {
  water: LatLng[][];
  streets: Array<{ t: number; p: LatLng[] }>;
}

// ------------------------------------------------------------------
// Real water geometry (data/water.json, fetched by fetchWater.ts).
// Lakes and bays are natural=water polygons; the Sound is a set of
// natural=coastline ways that get stitched into chains and closed
// against the map edge on the water side.
// ------------------------------------------------------------------

interface OverpassGeomWay {
  type: "way";
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassGeomRelation {
  type: "relation";
  tags?: Record<string, string>;
  members?: Array<{
    type: string;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
}

type OverpassGeomElement = OverpassGeomWay | OverpassGeomRelation;

interface Rect {
  n: number;
  s: number;
  e: number;
  w: number;
}

function pointInRing(lat: number, lng: number, ring: LatLng[]): boolean {
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

function ringAreaKm2(ring: LatLng[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    a += xj * kmPerDegLng * (yi * KM_PER_DEG_LAT) - xi * kmPerDegLng * (yj * KM_PER_DEG_LAT);
  }
  return Math.abs(a / 2);
}

// Sutherland-Hodgman polygon clip against a lat/lng rectangle.
function clipRing(ring: LatLng[], rect: Rect): LatLng[] {
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
function assembleSegments(
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
        if (preserveOrientation && key(segs[prev][segs[prev].length - 1]) !== headKey) {
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
      if (preserveOrientation && key(segs[next][0]) !== endKey) {
        break;
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
// directions are tried and the one containing a probe point just right
// of the chain wins.
function closeChain(chain: LatLng[], rect: Rect): LatLng[] | null {
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

const WATER_PROBES: Array<[number, number, string, boolean]> = [
  [47.598, -122.37, "Elliott Bay", true],
  [47.64, -122.334, "Lake Union", true],
  [47.68, -122.335, "Green Lake", true],
  [47.66, -122.26, "Lake Washington", true],
  [47.61, -122.332, "Downtown", false],
  [47.668, -122.384, "Ballard", false],
  [47.657, -122.406, "Discovery Park", false],
];

function buildWater(elements: OverpassGeomElement[], rect: Rect): LatLng[][] {
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

function normalizeRing(ring: LatLng[]): LatLng[] {
  const rnd = (x: number): number => Number(x.toFixed(4));
  // Decimate dense shoreline detail, then densify long straight runs so
  // every stretch bends under the warp.
  const kept: LatLng[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [la, lo] = ring[i];
    if (
      kept.length === 0 ||
      i === ring.length - 1 ||
      metersBetween(kept[kept.length - 1][0], kept[kept.length - 1][1], la, lo) >= 80
    ) {
      kept.push([la, lo]);
    }
  }
  const out: LatLng[] = [];
  for (let i = 0; i < kept.length; i++) {
    const [aLat, aLng] = kept[i];
    const [bLat, bLng] = kept[(i + 1) % kept.length];
    out.push([rnd(aLat), rnd(aLng)]);
    const len = metersBetween(aLat, aLng, bLat, bLng);
    const cuts = Math.floor(len / DENSIFY_M);
    for (let c = 1; c <= cuts; c++) {
      const f = c / (cuts + 1);
      out.push([rnd(aLat + (bLat - aLat) * f), rnd(aLng + (bLng - aLng) * f)]);
    }
  }
  return out;
}

function extractBasemap(
  osmElements: OsmElement[],
  waterRings: LatLng[][],
): Basemap {
  const nodeLat = new Map<number, number>();
  const nodeLng = new Map<number, number>();
  for (const el of osmElements) {
    if (el.type === "node") {
      nodeLat.set(el.id, el.lat);
      nodeLng.set(el.id, el.lon);
    }
  }
  // 4 decimal places is ~11 m, plenty at basemap scale.
  const rnd = (x: number): number => Number(x.toFixed(4));

  // OSM splits roads at every junction, so a single avenue arrives as
  // dozens of short ways. Collect raw node chains per tier, stitch
  // chains that share an endpoint into long polylines, then simplify.
  // Without stitching, most ways are shorter than the simplify
  // tolerance and the payload drowns in per-fragment overhead.
  const rawByTier = new Map<number, number[][]>();
  for (const el of osmElements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) {
      continue;
    }
    const t = STREET_TIER[el.tags?.highway ?? ""];
    if (t === undefined) {
      continue;
    }
    let chains = rawByTier.get(t);
    if (!chains) {
      chains = [];
      rawByTier.set(t, chains);
    }
    chains.push(el.nodes.filter((id) => nodeLat.has(id)));
  }

  function stitch(chains: number[][]): number[][] {
    // endpoint node id -> indexes of chains that start or end there
    const at = new Map<number, number[]>();
    chains.forEach((c, i) => {
      for (const end of [c[0], c[c.length - 1]]) {
        let list = at.get(end);
        if (!list) {
          at.set(end, (list = []));
        }
        list.push(i);
      }
    });
    const used = new Uint8Array(chains.length);
    const out: number[][] = [];
    for (let i = 0; i < chains.length; i++) {
      if (used[i]) {
        continue;
      }
      used[i] = 1;
      const chain = [...chains[i]];
      // Grow at the tail, then at the head, while an unused chain
      // continues from the current endpoint.
      for (const dir of [1, -1] as const) {
        for (;;) {
          const end = dir === 1 ? chain[chain.length - 1] : chain[0];
          const next = (at.get(end) ?? []).find((j) => !used[j]);
          if (next === undefined) {
            break;
          }
          used[next] = 1;
          let seg = chains[next];
          if (dir === 1) {
            if (seg[0] !== end) {
              seg = [...seg].reverse();
            }
            chain.push(...seg.slice(1));
          } else {
            if (seg[seg.length - 1] !== end) {
              seg = [...seg].reverse();
            }
            chain.unshift(...seg.slice(0, -1));
          }
        }
      }
      out.push(chain);
    }
    return out;
  }

  const streets: Basemap["streets"] = [];
  for (const [t, chains] of rawByTier) {
    for (const chain of stitch(chains)) {
      const p: LatLng[] = [];
      let lastLat = NaN;
      let lastLng = NaN;
      for (let k = 0; k < chain.length; k++) {
        const la = nodeLat.get(chain[k]) as number;
        const lo = nodeLng.get(chain[k]) as number;
        const isEnd = k === chain.length - 1;
        if (
          p.length === 0 ||
          isEnd ||
          metersBetween(lastLat, lastLng, la, lo) >= SIMPLIFY_M
        ) {
          p.push([rnd(la), rnd(lo)]);
          lastLat = la;
          lastLng = lo;
        }
      }
      if (p.length >= 2) {
        streets.push({ t, p });
      }
    }
  }

  const water: LatLng[][] = waterRings.map(normalizeRing).filter((r) => r.length >= 4);

  return { water, streets };
}

export async function main(): Promise<void> {
  const grid = JSON.parse(
    fs.readFileSync(path.join(dataDir, "grid.json"), "utf8"),
  ) as Grid;

  const sliceIds = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith("embedding-") && f.endsWith(".json"))
    .map((f) => f.slice("embedding-".length, -".json".length));
  // Freeflow baseline first, then captures.
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

  const readingsOf = new Map<string, Reading[]>();
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
      readingsOf.set(slice, traffic.readings);
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

  // Road graphs for route geometry, one per slice, plus the basemap
  // streets. Skipped (straight fallback, no basemap) when no OSM data
  // is present, e.g. a synthetic-only run.
  const osmPath = path.join(dataDir, "osm.json");
  let graphs: Map<string, RoadGraph> | null = null;
  let snap: ((la: number, lo: number) => number) | null = null;
  let basemap: Basemap | null = null;
  if (fs.existsSync(osmPath)) {
    const osm = JSON.parse(fs.readFileSync(osmPath, "utf8")) as {
      elements: OsmElement[];
    };
    const base = buildGraph(osm.elements);
    const { mask } = largestScc(base);
    snap = makeSnapper(base, mask, true);
    graphs = new Map(
      ordered.map((slice) => {
        const readings = readingsOf.get(slice);
        return [slice, readings ? applyTraffic(base, readings) : base];
      }),
    );
    const waterPath = path.join(dataDir, "water.json");
    let rings: LatLng[][];
    if (fs.existsSync(waterPath)) {
      const rect: Rect = {
        n: grid.bounds.north + 0.02,
        s: grid.bounds.south - 0.02,
        e: grid.bounds.east + 0.02,
        w: grid.bounds.west - 0.02,
      };
      const waterJson = JSON.parse(fs.readFileSync(waterPath, "utf8")) as {
        elements: OverpassGeomElement[];
      };
      rings = buildWater(waterJson.elements, rect);
      let failed = 0;
      for (const [la, lo, name, expectWater] of WATER_PROBES) {
        const inWater = rings.some((r) => pointInRing(la, lo, r));
        if (inWater !== expectWater) {
          failed++;
          console.log(
            `water probe FAIL: ${name} expected ${expectWater ? "water" : "land"}`,
          );
        }
      }
      console.log(
        `water: ${rings.length} rings from data/water.json, probes ${WATER_PROBES.length - failed}/${WATER_PROBES.length}`,
      );
    } else {
      // Hand-drawn masking polygons as display fallback ([lng, lat] -> [lat, lng]).
      rings = (grid.water ?? []).map(({ ring }) =>
        ring.map(([lng, lat]) => [lat, lng] as LatLng),
      );
    }
    basemap = extractBasemap(osm.elements, rings);
  }

  // Route geometry as geographic coordinates, downsampled. The viewer
  // warps these vertices with the same displacement field as the
  // basemap, so the route follows real roads at the geographic end of
  // the slider and bends with the city at the other. (An earlier
  // version projected the path onto the anchor mesh; the nearest-anchor
  // assignment wandered off the corridor near freeways.)
  function geoPath(graph: RoadGraph, nodes: number[]): LatLng[] {
    const out: LatLng[] = [];
    let lastLat = NaN;
    let lastLng = NaN;
    nodes.forEach((u, i) => {
      const la = graph.lat[u];
      const lo = graph.lng[u];
      const isEnd = i === nodes.length - 1;
      if (
        out.length === 0 ||
        isEnd ||
        metersBetween(lastLat, lastLng, la, lo) >= 180
      ) {
        out.push([Number(la.toFixed(5)), Number(lo.toFixed(5))]);
        lastLat = la;
        lastLng = lo;
      }
    });
    return out;
  }

  // Distance-weighted twin of the road graph, for shortest-distance
  // routes. Same topology, edge weight = meters instead of seconds.
  function distanceWeights(g: RoadGraph): Float64Array {
    const w = new Float64Array(g.head.length);
    for (let u = 0; u < g.n; u++) {
      for (let e = g.offset[u]; e < g.offset[u + 1]; e++) {
        const v = g.head[e];
        w[e] = metersBetween(g.lat[u], g.lng[u], g.lat[v], g.lng[v]);
      }
    }
    return w;
  }
  const baseGraph = graphs?.get(FREEFLOW) ?? null;
  const distGraph: RoadGraph | null = baseGraph
    ? { ...baseGraph, weight: distanceWeights(baseGraph) }
    : null;

  function pathMeters(g: RoadGraph, nodes: number[]): number {
    let m = 0;
    for (let i = 0; i + 1 < nodes.length; i++) {
      m += metersBetween(
        g.lat[nodes[i]],
        g.lng[nodes[i]],
        g.lat[nodes[i + 1]],
        g.lng[nodes[i + 1]],
      );
    }
    return m;
  }

  // Time along a fixed node path under a slice's weights: cheapest
  // parallel edge for each consecutive pair.
  function pathSeconds(g: RoadGraph, nodes: number[]): number {
    let s = 0;
    for (let i = 0; i + 1 < nodes.length; i++) {
      const u = nodes[i];
      const v = nodes[i + 1];
      let best = Infinity;
      for (let e = g.offset[u]; e < g.offset[u + 1]; e++) {
        if (g.head[e] === v && g.weight[e] < best) {
          best = g.weight[e];
        }
      }
      s += best;
    }
    return s;
  }

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
    const routePath: Record<string, LatLng[]> = {};
    const fastMiles: Record<string, number> = {};
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
      let pts: LatLng[] = [
        [pa.lat, pa.lng],
        [pb.lat, pb.lng],
      ];
      const graph = graphs?.get(slice);
      if (graph && snap) {
        const nodes = dijkstraPath(
          graph,
          snap(pa.lat, pa.lng),
          snap(pb.lat, pb.lng),
        );
        if (nodes.length > 0) {
          pts = geoPath(graph, nodes);
          fastMiles[slice] = Number(
            (pathMeters(graph, nodes) / 1609.34).toFixed(1),
          );
        }
      }
      routePath[slice] = pts;
    }

    // Shortest-distance alternative: one geometry (distance ignores
    // traffic), timed under each slice's weights.
    let alt: {
      path: LatLng[];
      miles: number;
      minutes: Record<string, number>;
    } | null = null;
    if (distGraph && baseGraph && snap) {
      const nodes = dijkstraPath(
        distGraph,
        snap(pa.lat, pa.lng),
        snap(pb.lat, pb.lng),
      );
      if (nodes.length > 0) {
        const altMinutes: Record<string, number> = {};
        for (const slice of ordered) {
          const g = graphs?.get(slice) as RoadGraph;
          altMinutes[slice] = Number((pathSeconds(g, nodes) / 60).toFixed(1));
        }
        alt = {
          path: geoPath(baseGraph, nodes),
          miles: Number((pathMeters(baseGraph, nodes) / 1609.34).toFixed(1)),
          minutes: altMinutes,
        };
      }
    }

    return {
      name,
      ai,
      bi,
      miles: Number((geoKm / KM_PER_MILE).toFixed(1)),
      fastMiles,
      minutes,
      factor,
      path: routePath,
      alt,
    };
  });

  const payload = { edges: grid.edges, slices, routes, basemap };
  const body = `window.EMBEDDING = ${JSON.stringify(payload)};\n`;
  fs.writeFileSync(path.join(root, "docs", "embedding.js"), body);

  // Stamp the page's script reference with a content hash so browsers
  // never pair a cached data file with a newer page.
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 8);
  const indexPath = path.join(root, "docs", "index.html");
  const page = fs.readFileSync(indexPath, "utf8");
  const stamped = page.replace(
    /src="\.\/embedding\.js[^"]*"/,
    `src="./embedding.js?v=${hash}"`,
  );
  if (stamped !== page) {
    fs.writeFileSync(indexPath, stamped);
  }

  console.log(
    `viewer: ${slices.length} slices (${ordered.join(", ")}), ` +
      `${routes.length} routes -> docs/embedding.js (v=${hash})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
