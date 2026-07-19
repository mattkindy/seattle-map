// Walking access between anchors and transit stops, over the road
// graph. Walkers ignore one-way rules, so the graph symmetrizes; edge
// time becomes length at walking speed. Access is a bounded Dijkstra
// from each anchor: every stop reachable within the cutoff gets a walk
// time.

import {
  dijkstra,
  makeSnapper,
  largestScc,
  type RoadGraph,
} from "../roadRouter.ts";
import type { Anchor } from "../types.ts";
import type { Timetable } from "./gtfs.ts";

const WALK_MPS = 1.35;
const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);

/** Same nodes, edges in both directions, weights in walking seconds. */
export function walkGraph(road: RoadGraph): RoadGraph {
  const { n, offset, head, lat, lng } = road;
  const m = head.length;
  const from = new Int32Array(m * 2);
  const to = new Int32Array(m * 2);
  const w = new Float64Array(m * 2);
  let e2 = 0;
  for (let u = 0; u < n; u++) {
    for (let e = offset[u]; e < offset[u + 1]; e++) {
      const v = head[e];
      const meters = Math.hypot(
        (lat[u] - lat[v]) * KM_PER_DEG_LAT * 1000,
        (lng[u] - lng[v]) * kmPerDegLng * 1000,
      );
      const sec = meters / WALK_MPS;
      from[e2] = u;
      to[e2] = v;
      w[e2++] = sec;
      from[e2] = v;
      to[e2] = u;
      w[e2++] = sec;
    }
  }
  const outOffset = new Int32Array(n + 1);
  for (let e = 0; e < e2; e++) {
    outOffset[from[e] + 1]++;
  }
  for (let i = 0; i < n; i++) {
    outOffset[i + 1] += outOffset[i];
  }
  const outHead = new Int32Array(e2);
  const outW = new Float64Array(e2);
  const cursor = outOffset.slice(0, n);
  for (let e = 0; e < e2; e++) {
    const p = cursor[from[e]]++;
    outHead[p] = to[e];
    outW[p] = w[e];
  }
  return {
    n,
    lat,
    lng,
    offset: outOffset,
    head: outHead,
    weight: outW,
    local: road.local,
  };
}

export interface AccessTables {
  /** anchor index -> [stopIdx, walkSeconds][] within the cutoff. */
  byAnchor: Array<Array<[number, number]>>;
  /** stop index -> nearest walk-graph node (-1 if none close). */
  stopNode: Int32Array;
}

export function buildAccess(
  walk: RoadGraph,
  anchors: Anchor[],
  tt: Timetable,
  cutoffSec = 720,
  log: (m: string) => void = () => {},
): AccessTables {
  const { mask } = largestScc(walk);
  const snap = makeSnapper(walk, mask, true);

  // stops -> nodes, with the straight-line remainder charged at walk speed
  const stopNode = new Int32Array(tt.stopIds.length).fill(-1);
  const stopGap = new Float64Array(tt.stopIds.length);
  const stopsAtNode = new Map<number, number[]>();
  for (let s = 0; s < tt.stopIds.length; s++) {
    const node = snap(tt.stopLat[s], tt.stopLng[s]);
    if (node < 0) {
      continue;
    }
    const gapM = Math.hypot(
      (tt.stopLat[s] - walk.lat[node]) * KM_PER_DEG_LAT * 1000,
      (tt.stopLng[s] - walk.lng[node]) * kmPerDegLng * 1000,
    );
    if (gapM > 300) {
      continue; // stop outside the walkable network (e.g. beyond the map)
    }
    stopNode[s] = node;
    stopGap[s] = gapM / WALK_MPS;
    let list = stopsAtNode.get(node);
    if (!list) {
      stopsAtNode.set(node, (list = []));
    }
    list.push(s);
  }

  const dist = new Float64Array(walk.n);
  const byAnchor: Array<Array<[number, number]>> = [];
  for (let i = 0; i < anchors.length; i++) {
    const src = snap(anchors[i].lat, anchors[i].lng);
    const list: Array<[number, number]> = [];
    if (src >= 0) {
      dijkstra(walk, src, dist, { cutoff: cutoffSec });
      for (const [node, stops] of stopsAtNode) {
        const d = dist[node];
        if (Number.isFinite(d) && d <= cutoffSec) {
          for (const s of stops) {
            list.push([s, Math.round(d + stopGap[s])]);
          }
        }
      }
    }
    byAnchor.push(list);
    if ((i + 1) % 100 === 0 || i === anchors.length - 1) {
      log(`\raccess: ${i + 1}/${anchors.length}`);
    }
  }
  log("\n");
  return { byAnchor, stopNode };
}
