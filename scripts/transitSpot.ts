// transitSpot.ts: validation harness for the transit router. Loads the
// GTFS timetable and the walk graph, runs RAPTOR for a handful of
// known trips, and prints door-to-door minutes for comparison against
// a trip planner. No downstream artifact; when these numbers look
// believable, the transit matrix provider gets built on the same
// parts.
//
//   npx tsx scripts/transitSpot.ts [YYYYMMDD] [HH:MM]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dataFileExists, readJsonGz } from "../src/lib/data.ts";
import { buildGraph, type OsmElement } from "../src/roadRouter.ts";
import { buildAccess, walkGraph } from "../src/transit/access.ts";
import { loadTimetable } from "../src/transit/gtfs.ts";
import { raptor } from "../src/transit/raptor.ts";
import type { Grid } from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");

const TRIPS: Array<{ name: string; a: [number, number]; b: [number, number]; expect: string }> = [
  { name: "Northgate to Westlake", a: [47.708, -122.328], b: [47.6114, -122.3373], expect: "~25-35 (Link)" },
  { name: "Ballard to Capitol Hill", a: [47.668, -122.384], b: [47.623, -122.316], expect: "~40-55" },
  { name: "Ballard to U District", a: [47.668, -122.384], b: [47.66, -122.313], expect: "~25-40 (44)" },
  { name: "West Seattle to Downtown", a: [47.566, -122.387], b: [47.606, -122.333], expect: "~30-45 (C Line)" },
  { name: "Columbia City to Westlake", a: [47.56, -122.287], b: [47.6114, -122.3373], expect: "~25-35 (Link)" },
];

export async function main({ date = "20260722", depart = "08:30" } = {}): Promise<void> {
  const grid = JSON.parse(
    fs.readFileSync(path.join(dataDir, "grid.json"), "utf8"),
  ) as Grid;
  const gtfsDir = path.join(dataDir, "gtfs");
  if (!fs.existsSync(gtfsDir) || !dataFileExists(path.join(dataDir, "osm.json"))) {
    throw new Error("need data/gtfs (npm run gtfs) and data/osm.json");
  }

  console.time("timetable");
  const tt = loadTimetable(gtfsDir, { date, bounds: grid.bounds });
  console.timeEnd("timetable");
  const tripTotal = tt.patterns.reduce((s, p) => s + p.tripCount, 0);
  console.log(
    `timetable: ${tt.stopIds.length} stops, ${tt.patterns.length} patterns, ` +
      `${tripTotal} trips on ${date}`,
  );

  console.time("walk graph");
  const osm = readJsonGz<{ elements: OsmElement[] }>(path.join(dataDir, "osm.json"));
  const walk = walkGraph(buildGraph(osm.elements));
  console.timeEnd("walk graph");

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
  const wanted = new Set<number>();
  for (const t of TRIPS) {
    wanted.add(nearestAnchor(t.a[0], t.a[1]));
    wanted.add(nearestAnchor(t.b[0], t.b[1]));
  }
  const anchorList = [...wanted];
  console.time("access");
  const access = buildAccess(
    walk,
    anchorList.map((i) => grid.anchors[i]),
    tt,
    720,
  );
  console.timeEnd("access");
  const accessOf = new Map(anchorList.map((ai, k) => [ai, access.byAnchor[k]]));

  const [hh, mm] = depart.split(":").map(Number);
  const departSec = hh * 3600 + mm * 60;

  console.log(`\ndoor-to-door, departing ${depart} on ${date}:`);
  for (const t of TRIPS) {
    const ai = nearestAnchor(t.a[0], t.a[1]);
    const bi = nearestAnchor(t.b[0], t.b[1]);
    const src = new Map(accessOf.get(ai));
    console.time(`  raptor ${t.name}`);
    const arrival = raptor(tt, src, departSec);
    console.timeEnd(`  raptor ${t.name}`);
    let best = Infinity;
    for (const [stop, walkSec] of accessOf.get(bi) ?? []) {
      const a = arrival[stop];
      if (a < 0x7fffffff && a + walkSec < best) {
        best = a + walkSec;
      }
    }
    const minutes = Number.isFinite(best)
      ? ((best - departSec) / 60).toFixed(1)
      : "unreachable";
    console.log(`  ${t.name.padEnd(28)} ${minutes} min   (expect ${t.expect})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({
    date: process.argv[2] ?? "20260722",
    depart: process.argv[3] ?? "08:30",
  });
}
