// Transit matrix provider: door-to-door transit times between anchors,
// via the GTFS timetable and RAPTOR (src/transit). Available once the
// feeds (npm run gtfs) and the road network are on disk.
//
// Pass 1 runs one full walk Dijkstra per anchor. Because the walk
// graph is symmetric, that single pass yields three things at once:
// the anchor's stop access (seeds RAPTOR), its stop egress (same walk,
// other direction), and direct anchor-to-anchor walk times. Pass 2
// runs RAPTOR per source; a pair's final time is the better of riding
// and walking. The walk fallback has no cutoff on purpose: this mode
// means "transit plus your feet", and for an anchor far from any stop
// the truthful answer is a long walk, not unreachable.

import fs from "node:fs";
import path from "node:path";

import { dataFileExists, readJsonGz } from "../lib/data.ts";
import {
  buildGraph,
  dijkstra,
  largestScc,
  makeSnapper,
  type OsmElement,
} from "../roadRouter.ts";
import { walkGraph } from "../transit/access.ts";
import { loadTimetable, type Timetable } from "../transit/gtfs.ts";
import { raptor } from "../transit/raptor.ts";
import { departSeconds, serviceDate, TRANSIT_SLICES } from "../transit/slices.ts";
import type { MatrixProvider } from "./index.ts";

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);
const WALK_MPS = 1.35;
const ACCESS_CUTOFF_S = 900;
const INF = 0x7fffffff;

export const transit: MatrixProvider = {
  name: "transit",
  available: (ctx) =>
    fs.existsSync(path.join(ctx.root, "data", "gtfs")) &&
    dataFileExists(path.join(ctx.root, "data", "osm.json")),
  async build(anchors, ctx) {
    const slice = TRANSIT_SLICES.find((s) => s.id === ctx.slice);
    if (!slice) {
      throw new Error(`unknown transit slice "${ctx.slice}"`);
    }
    const date = serviceDate();
    const departSec = departSeconds(slice.depart);
    ctx.log(`transit: ${slice.id} departing ${slice.depart} on ${date}\n`);

    const osm = readJsonGz<{ elements: OsmElement[] }>(
      path.join(ctx.root, "data", "osm.json"),
    );
    const walk = walkGraph(buildGraph(osm.elements));
    const { mask } = largestScc(walk);
    const snap = makeSnapper(walk, mask, true);

    const gtfsDir = path.join(ctx.root, "data", "gtfs");
    const grid = JSON.parse(
      fs.readFileSync(path.join(ctx.root, "data", "grid.json"), "utf8"),
    ) as { bounds: Parameters<typeof loadTimetable>[1]["bounds"] };
    const tt: Timetable = loadTimetable(gtfsDir, { date, bounds: grid.bounds });
    const tripTotal = tt.patterns.reduce((s, p) => s + p.tripCount, 0);
    ctx.log(
      `transit: ${tt.stopIds.length} stops, ${tt.patterns.length} patterns, ${tripTotal} trips\n`,
    );

    // stops -> walk nodes (off-network remainder charged at walk speed)
    const stopsAtNode = new Map<number, Array<[number, number]>>();
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
        continue;
      }
      let list = stopsAtNode.get(node);
      if (!list) {
        stopsAtNode.set(node, (list = []));
      }
      list.push([s, gapM / WALK_MPS]);
    }
    const anchorNode = anchors.map((a) => snap(a.lat, a.lng));
    const nodeAnchors = new Map<number, number[]>();
    anchorNode.forEach((node, i) => {
      if (node < 0) {
        return;
      }
      let list = nodeAnchors.get(node);
      if (!list) {
        nodeAnchors.set(node, (list = []));
      }
      list.push(i);
    });

    const n = anchors.length;

    // Pass 1: one full walk per anchor.
    const stopsNear: Array<Array<[number, number]>> = [];
    const walkRows: Float64Array[] = [];
    {
      const dist = new Float64Array(walk.n);
      for (let i = 0; i < n; i++) {
        const list: Array<[number, number]> = [];
        const row = new Float64Array(n).fill(Infinity);
        if (anchorNode[i] >= 0) {
          dijkstra(walk, anchorNode[i], dist);
          for (const [node, stops] of stopsAtNode) {
            const d = dist[node];
            if (Number.isFinite(d) && d <= ACCESS_CUTOFF_S) {
              for (const [s, gap] of stops) {
                list.push([s, Math.round(d + gap)]);
              }
            }
          }
          for (let j = 0; j < n; j++) {
            const node = anchorNode[j];
            if (node >= 0 && Number.isFinite(dist[node])) {
              row[j] = Math.round(dist[node]);
            }
          }
        }
        stopsNear.push(list);
        walkRows.push(row);
        if ((i + 1) % 100 === 0 || i === n - 1) {
          ctx.log(`\rtransit walk: ${i + 1}/${n}`);
        }
      }
      ctx.log("\n");
    }

    // Pass 2: RAPTOR per source, egress over each destination's stops.
    const seconds: (number | null)[][] = Array.from({ length: n }, () =>
      new Array(n).fill(null),
    );
    for (let i = 0; i < n; i++) {
      if (anchorNode[i] < 0) {
        continue;
      }
      const arrival = raptor(tt, new Map(stopsNear[i]), departSec);
      for (let j = 0; j < n; j++) {
        let best = walkRows[i][j];
        for (const [s, sec] of stopsNear[j]) {
          const a = arrival[s];
          if (a < INF) {
            const t = a - departSec + sec;
            if (t < best) {
              best = t;
            }
          }
        }
        if (Number.isFinite(best)) {
          seconds[i][j] = Math.round(best);
        }
      }
      if ((i + 1) % 50 === 0 || i === n - 1) {
        ctx.log(`\rtransit routes: ${i + 1}/${n}`);
      }
    }
    ctx.log("\n");
    return seconds;
  },
};
