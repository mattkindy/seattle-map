// roadRouter.ts: a small routing engine over an OpenStreetMap road
// network. Builds a time-weighted directed graph from Overpass output,
// snaps points to the nearest road node, and computes shortest-time
// paths with Dijkstra.
//
// Edge time is length divided by the road's speed limit: the `maxspeed`
// tag when present, otherwise a default for the road class. This is
// free-flow time. A traffic speed layer (src/traffic) can be laid over
// these weights afterward with applyTraffic.

import type { Anchor } from "./types.ts";
import type { Reading } from "./traffic/index.ts";

export interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

export interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export type OsmElement = OsmNode | OsmWay;

export interface RoadGraph {
  n: number;
  lat: Float64Array;
  lng: Float64Array;
  /** CSR: edges of node u are [offset[u], offset[u+1]). */
  offset: Int32Array;
  head: Int32Array;
  /** Edge traversal time in seconds. */
  weight: Float64Array;
}

const MPH = 0.44704; // m/s per mph

// Default speed limits by highway class, in mph.
const DEFAULT_MPH: Record<string, number> = {
  motorway: 60,
  motorway_link: 45,
  trunk: 55,
  trunk_link: 40,
  primary: 40,
  primary_link: 30,
  secondary: 35,
  secondary_link: 30,
  tertiary: 30,
  tertiary_link: 25,
  unclassified: 25,
  residential: 25,
  living_street: 12,
};

function parseMaxspeed(tag: string | undefined, highway: string): number {
  if (typeof tag === "string") {
    const m = tag.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      // US maxspeed is in mph even when the unit is omitted.
      return Number(m[1]);
    }
  }
  return DEFAULT_MPH[highway] ?? 25;
}

const R = 6371000;
function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ------------------------------------------------------------------
// Build a compact directed graph (CSR layout) from Overpass elements.
// ------------------------------------------------------------------

// Only these classes become edges. Ferries and stray ways pulled in by
// node recursion must not become slow shortcuts across water.
const DRIVABLE = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "unclassified", "residential", "living_street",
  "motorway_link", "trunk_link", "primary_link",
  "secondary_link", "tertiary_link",
]);

export function buildGraph(elements: OsmElement[]): RoadGraph {
  const nodeLat = new Map<number, number>();
  const nodeLng = new Map<number, number>();
  for (const el of elements) {
    if (el.type === "node") {
      nodeLat.set(el.id, el.lat);
      nodeLng.set(el.id, el.lon);
    }
  }

  // Reindex the OSM node ids used by ways into a dense 0..N-1 space.
  const idToIdx = new Map<number, number>();
  const lats: number[] = [];
  const lngs: number[] = [];
  function idx(osmId: number): number {
    let i = idToIdx.get(osmId);
    if (i === undefined) {
      i = lats.length;
      idToIdx.set(osmId, i);
      lats.push(nodeLat.get(osmId) as number);
      lngs.push(nodeLng.get(osmId) as number);
    }
    return i;
  }

  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  const edgeW: number[] = [];
  function addEdge(u: number, v: number): void {
    if (lats[u] == null || lats[v] == null) {
      return;
    }
    const len = haversine(lats[u], lngs[u], lats[v], lngs[v]);
    // speed captured on the way; stored per directed edge below.
    edgeFrom.push(u);
    edgeTo.push(v);
    edgeW.push(len);
  }

  for (const el of elements) {
    if (el.type !== "way" || !el.nodes || el.nodes.length < 2) {
      continue;
    }
    const tags = el.tags ?? {};
    if (!DRIVABLE.has(tags.highway)) {
      continue;
    }
    const speed = parseMaxspeed(tags.maxspeed, tags.highway) * MPH;
    const oneway =
      tags.oneway === "yes" ||
      tags.oneway === "true" ||
      tags.oneway === "1" ||
      tags.highway === "motorway" ||
      tags.highway === "motorway_link";
    const reversed = tags.oneway === "-1";
    for (let k = 0; k + 1 < el.nodes.length; k++) {
      const a = el.nodes[k];
      const bId = el.nodes[k + 1];
      if (!nodeLat.has(a) || !nodeLat.has(bId)) {
        continue;
      }
      const u = idx(a);
      const v = idx(bId);
      const before = edgeW.length;
      if (!reversed) {
        addEdge(u, v);
      }
      if (!oneway || reversed) {
        addEdge(v, u);
      }
      // stamp seconds onto whatever directed edges were just pushed
      for (let e = before; e < edgeW.length; e++) {
        edgeW[e] = edgeW[e] / speed;
      }
    }
  }

  const n = lats.length;
  const m = edgeFrom.length;
  const offset = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) {
    offset[edgeFrom[e] + 1]++;
  }
  for (let i = 0; i < n; i++) {
    offset[i + 1] += offset[i];
  }
  const head = new Int32Array(m);
  const weight = new Float64Array(m);
  const cursor = offset.slice(0, n);
  for (let e = 0; e < m; e++) {
    const p = cursor[edgeFrom[e]]++;
    head[p] = edgeTo[e];
    weight[p] = edgeW[e];
  }

  return {
    n,
    lat: Float64Array.from(lats),
    lng: Float64Array.from(lngs),
    offset,
    head,
    weight,
  };
}

// ------------------------------------------------------------------
// Traffic speed layer. A reading is a point with a slowdown factor
// (>= 1): how much longer a road near it takes now than at free-flow,
// from a speed provider (see src/traffic). Each edge's free-flow time is
// multiplied by the factor interpolated from the nearest readings
// (inverse-distance over the k closest within maxKm), so congestion warps
// routes the same way whether the readings are measured or modeled. Edges
// with no reading within maxKm keep their free-flow time (factor 1).
// ------------------------------------------------------------------

export interface ApplyTrafficOptions {
  maxKm?: number;
  k?: number;
}

export function applyTraffic(
  graph: RoadGraph,
  readings: Reading[],
  opts: ApplyTrafficOptions = {},
): RoadGraph {
  const maxKm = opts.maxKm ?? 1.5;
  const k = opts.k ?? 4;
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
  const cellLat = maxKm / kmPerDegLat;
  const cellLng = maxKm / kmPerDegLng;

  // Bucket readings into a grid so each lookup scans only nearby cells.
  const grid = new Map<string, number[]>();
  readings.forEach((r, i) => {
    const key = `${Math.floor(r.lat / cellLat)},${Math.floor(r.lng / cellLng)}`;
    let b = grid.get(key);
    if (!b) {
      b = [];
      grid.set(key, b);
    }
    b.push(i);
  });

  function factorAt(la: number, lo: number): number {
    const ci = Math.floor(la / cellLat);
    const cj = Math.floor(lo / cellLng);
    const near: Array<[number, number]> = [];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const b = grid.get(`${ci + di},${cj + dj}`);
        if (!b) {
          continue;
        }
        for (const idx of b) {
          const r = readings[idx];
          const d = Math.hypot(
            (r.lat - la) * kmPerDegLat,
            (r.lng - lo) * kmPerDegLng,
          );
          if (d <= maxKm) {
            near.push([d, r.factor]);
          }
        }
      }
    }
    if (near.length === 0) {
      return 1;
    }
    near.sort((a, b) => a[0] - b[0]);
    let wsum = 0;
    let fsum = 0;
    for (let i = 0; i < Math.min(k, near.length); i++) {
      const [d, f] = near[i];
      const w = 1 / (d * d + 1e-6);
      wsum += w;
      fsum += w * f;
    }
    return fsum / wsum;
  }

  const weight = Float64Array.from(graph.weight);
  const { offset, head, lat, lng } = graph;
  for (let u = 0; u < graph.n; u++) {
    for (let e = offset[u]; e < offset[u + 1]; e++) {
      const v = head[e];
      weight[e] *= factorAt((lat[u] + lat[v]) / 2, (lng[u] + lng[v]) / 2);
    }
  }
  return { ...graph, weight };
}

// ------------------------------------------------------------------
// Largest strongly-connected component. OSM road data is full of small
// stranded fragments (parking aisles, one-way stubs, driveways). Routing
// only within the biggest mutually reachable component removes the
// unreachable pairs that otherwise wreck the embedding.
// ------------------------------------------------------------------

export function largestScc(graph: RoadGraph): { mask: Uint8Array; size: number } {
  const { n, offset, head } = graph;
  // Reverse adjacency in CSR form.
  const rOffset = new Int32Array(n + 1);
  for (let e = 0; e < head.length; e++) {
    rOffset[head[e] + 1]++;
  }
  for (let i = 0; i < n; i++) {
    rOffset[i + 1] += rOffset[i];
  }
  const rHead = new Int32Array(head.length);
  const cur = rOffset.slice(0, n);
  for (let u = 0; u < n; u++) {
    for (let e = offset[u]; e < offset[u + 1]; e++) {
      rHead[cur[head[e]]++] = u;
    }
  }

  // Pass 1: iterative DFS on the forward graph, recording finish order.
  const visited = new Uint8Array(n);
  const order = new Int32Array(n);
  let oi = 0;
  const stack = new Int32Array(n);
  const iter = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (visited[s]) {
      continue;
    }
    let sp = 0;
    stack[sp] = s;
    iter[sp] = offset[s];
    visited[s] = 1;
    while (sp >= 0) {
      const u = stack[sp];
      if (iter[sp] < offset[u + 1]) {
        const v = head[iter[sp]++];
        if (!visited[v]) {
          visited[v] = 1;
          sp++;
          stack[sp] = v;
          iter[sp] = offset[v];
        }
      } else {
        order[oi++] = u;
        sp--;
      }
    }
  }

  // Pass 2: DFS on the reverse graph in reverse finish order.
  const comp = new Int32Array(n).fill(-1);
  let label = 0;
  const sizes: number[] = [];
  for (let k = n - 1; k >= 0; k--) {
    const root = order[k];
    if (comp[root] !== -1) {
      continue;
    }
    let size = 0;
    let sp = 0;
    stack[sp] = root;
    comp[root] = label;
    while (sp >= 0) {
      const u = stack[sp--];
      size++;
      for (let e = rOffset[u]; e < rOffset[u + 1]; e++) {
        const v = rHead[e];
        if (comp[v] === -1) {
          comp[v] = label;
          stack[++sp] = v;
        }
      }
    }
    sizes.push(size);
    label++;
  }

  let biggest = 0;
  for (let c = 1; c < sizes.length; c++) {
    if (sizes[c] > sizes[biggest]) {
      biggest = c;
    }
  }
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = comp[i] === biggest ? 1 : 0;
  }
  return { mask, size: sizes[biggest] };
}

// ------------------------------------------------------------------
// Spatial hash for snapping points to the nearest road node.
// ------------------------------------------------------------------

export function makeSnapper(
  graph: RoadGraph,
  mask?: Uint8Array,
): (la: number, lo: number) => number {
  const cell = 0.004; // ~300 m
  const buckets = new Map<string, number[]>();
  const key = (la: number, lo: number) =>
    `${Math.floor(la / cell)},${Math.floor(lo / cell)}`;
  for (let i = 0; i < graph.n; i++) {
    if (mask && !mask[i]) {
      continue;
    }
    const k = key(graph.lat[i], graph.lng[i]);
    let b = buckets.get(k);
    if (!b) {
      b = [];
      buckets.set(k, b);
    }
    b.push(i);
  }
  // Expanding-ring search: grow the radius until the nearest node can't
  // be beaten by a further ring. Guarantees a snap for shoreline and
  // park anchors that a fixed neighborhood misses.
  const cellMeters = cell * 111320 * Math.cos((47.61 * Math.PI) / 180);
  return function snap(la: number, lo: number): number {
    const ci0 = Math.floor(la / cell);
    const cj0 = Math.floor(lo / cell);
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r <= 40; r++) {
      for (let ci = ci0 - r; ci <= ci0 + r; ci++) {
        for (let cj = cj0 - r; cj <= cj0 + r; cj++) {
          if (Math.max(Math.abs(ci - ci0), Math.abs(cj - cj0)) !== r) {
            continue; // only the new ring
          }
          const b = buckets.get(`${ci},${cj}`);
          if (!b) {
            continue;
          }
          for (const i of b) {
            const d = haversine(la, lo, graph.lat[i], graph.lng[i]);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
      if (best >= 0 && r * cellMeters > bd) {
        break;
      }
    }
    return best;
  };
}

// ------------------------------------------------------------------
// Dijkstra with a binary heap. Returns the seconds to every node.
// ------------------------------------------------------------------

export function dijkstra(
  graph: RoadGraph,
  source: number,
  dist: Float64Array,
): Float64Array {
  dist.fill(Infinity);
  dist[source] = 0;
  const heapDist: number[] = [0];
  const heapNode: number[] = [source];
  const swap = (a: number, b: number) => {
    [heapDist[a], heapDist[b]] = [heapDist[b], heapDist[a]];
    [heapNode[a], heapNode[b]] = [heapNode[b], heapNode[a]];
  };
  const push = (d: number, v: number) => {
    heapDist.push(d);
    heapNode.push(v);
    let i = heapDist.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapDist[p] <= heapDist[i]) {
        break;
      }
      swap(i, p);
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const d = heapDist[0];
    const v = heapNode[0];
    const last = heapDist.length - 1;
    heapDist[0] = heapDist[last];
    heapNode[0] = heapNode[last];
    heapDist.pop();
    heapNode.pop();
    let i = 0;
    const size = heapDist.length;
    while (true) {
      const l = 2 * i + 1;
      const r = l + 1;
      let s = i;
      if (l < size && heapDist[l] < heapDist[s]) {
        s = l;
      }
      if (r < size && heapDist[r] < heapDist[s]) {
        s = r;
      }
      if (s === i) {
        break;
      }
      swap(i, s);
      i = s;
    }
    return [d, v];
  };

  while (heapDist.length) {
    const [d, u] = pop();
    if (d > dist[u]) {
      continue;
    }
    for (let e = graph.offset[u]; e < graph.offset[u + 1]; e++) {
      const v = graph.head[e];
      const nd = d + graph.weight[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        push(nd, v);
      }
    }
  }
  return dist;
}

// ------------------------------------------------------------------
// Anchor-to-anchor drive-time matrix, in seconds.
// ------------------------------------------------------------------

export function driveMatrix(
  graph: RoadGraph,
  anchors: Anchor[],
  log: (m: string) => void = (m) => process.stderr.write(m),
): (number | null)[][] {
  const { mask, size } = largestScc(graph);
  log(`road: largest connected component has ${size} of ${graph.n} nodes\n`);
  const snap = makeSnapper(graph, mask);
  const nodeOf = anchors.map((a) => snap(a.lat, a.lng));
  const n = anchors.length;
  const seconds: (number | null)[][] = Array.from({ length: n }, () =>
    new Array(n).fill(null),
  );
  const dist = new Float64Array(graph.n);
  for (let i = 0; i < n; i++) {
    dijkstra(graph, nodeOf[i], dist);
    for (let j = 0; j < n; j++) {
      const d = dist[nodeOf[j]];
      seconds[i][j] = Number.isFinite(d) ? Math.round(d) : null;
    }
    if ((i + 1) % 25 === 0 || i === n - 1) {
      log(`\rroutes: ${i + 1}/${n}`);
    }
  }
  log("\n");
  return seconds;
}
