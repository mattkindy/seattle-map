// fetchMatrix.mjs — produce the pairwise drive-time matrix for the
// anchor grid. Output: data/matrix.json ({ mode, provider, seconds }
// where seconds[i][j] is anchor i -> anchor j).
//
// Two providers, chosen by environment:
//
//   GOOGLE_MAPS_API_KEY set     -> Google Distance Matrix, batched in
//                                  25x25 blocks (the API's per-request
//                                  element cap is 625). Costs money:
//                                  price out count^2 elements before
//                                  running on a dense grid.
//   otherwise                   -> a synthetic Seattle drive-time model
//                                  (below), so the whole pipeline runs
//                                  end to end with zero setup.
//
// The synthetic model is not pretending to be real data. It exists so
// the embedding and the warp can be built and judged before spending on
// the real matrix, and it encodes the two facts that make Seattle
// interesting: north-south is fast (I-5) and east-west across water is
// slow (a handful of bridges).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGraph, driveMatrix } from "../src/roadRouter.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const grid = JSON.parse(
  fs.readFileSync(path.join(root, "data", "grid.json"), "utf8"),
);
const anchors = grid.anchors;
const n = anchors.length;

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);

function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * KM_PER_DEG_LAT;
  const dLng = (b.lng - a.lng) * kmPerDegLng;
  return Math.hypot(dLat, dLng);
}

// --------------------------------------------------------------------
// Synthetic Seattle drive model
// --------------------------------------------------------------------
//
// Speed model: trips decompose into a north-south component (fast,
// 45 km/h effective: I-5/99 corridors) and an east-west component
// (slow, 22 km/h effective: surface streets). A trip that crosses the
// Ship Canal pays a bridge penalty; a trip whose straight line crosses
// Lake Union or Green Lake pays a detour factor. Plus a flat 90 s of
// trip overhead (parking, signals at the ends).

const NS_KMH = 45;
const EW_KMH = 22;
const OVERHEAD_S = 90;
const SHIP_CANAL_LAT = 47.655;
const CANAL_PENALTY_S = 240;

function crossesRect(a, b, rect) {
  // Does segment a-b cross the vertical band of the rect while both
  // endpoints straddle it? Coarse but adequate for a detour factor.
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  return (
    midLat > rect.south &&
    midLat < rect.north &&
    midLng > rect.west &&
    midLng < rect.east
  );
}

const LAKE_UNION = { south: 47.62, north: 47.655, west: -122.345, east: -122.305 };
const GREEN_LAKE = { south: 47.673, north: 47.687, west: -122.345, east: -122.325 };

function syntheticSeconds(a, b) {
  const nsKm = Math.abs(b.lat - a.lat) * KM_PER_DEG_LAT;
  const ewKm = Math.abs(b.lng - a.lng) * kmPerDegLng;
  let s = (nsKm / NS_KMH) * 3600 + (ewKm / EW_KMH) * 3600;
  const crossesCanal =
    (a.lat - SHIP_CANAL_LAT) * (b.lat - SHIP_CANAL_LAT) < 0;
  if (crossesCanal) {
    s += CANAL_PENALTY_S;
  }
  if (crossesRect(a, b, LAKE_UNION) || crossesRect(a, b, GREEN_LAKE)) {
    s *= 1.25;
  }
  return Math.round(s + OVERHEAD_S);
}

function buildSynthetic() {
  const seconds = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n);
    for (let j = 0; j < n; j++) {
      row[j] = i === j ? 0 : syntheticSeconds(anchors[i], anchors[j]);
    }
    seconds.push(row);
  }
  return seconds;
}

// --------------------------------------------------------------------
// Google Distance Matrix provider
// --------------------------------------------------------------------

const BLOCK = 25;

async function fetchBlock(key, origins, destinations, departureTime) {
  const fmt = (list) => list.map((p) => `${p.lat},${p.lng}`).join("|");
  const params = new URLSearchParams({
    origins: fmt(origins),
    destinations: fmt(destinations),
    mode: "driving",
    departure_time: String(departureTime),
    key,
  });
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`distance matrix http ${res.status}`);
  }
  const body = await res.json();
  if (body.status !== "OK") {
    throw new Error(`distance matrix status ${body.status}`);
  }
  return body.rows.map((r) =>
    r.elements.map((e) =>
      e.status === "OK"
        ? (e.duration_in_traffic ?? e.duration).value
        : null,
    ),
  );
}

async function buildGoogle(key) {
  // Baseline: next Wednesday 13:00 local, a neutral midday slice.
  // Rush-hour slices come later as separate matrix files.
  const departure = nextWednesday13LocalEpoch();
  const seconds = Array.from({ length: n }, () => new Array(n).fill(null));
  const blocks = Math.ceil(n / BLOCK);
  let done = 0;
  for (let bi = 0; bi < blocks; bi++) {
    for (let bj = 0; bj < blocks; bj++) {
      const origins = anchors.slice(bi * BLOCK, (bi + 1) * BLOCK);
      const dests = anchors.slice(bj * BLOCK, (bj + 1) * BLOCK);
      const block = await fetchBlock(key, origins, dests, departure);
      for (let i = 0; i < origins.length; i++) {
        for (let j = 0; j < dests.length; j++) {
          seconds[bi * BLOCK + i][bj * BLOCK + j] = block[i][j];
        }
      }
      done++;
      process.stderr.write(`\rblocks: ${done}/${blocks * blocks}`);
      // Stay far under the default elements-per-minute quota.
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  process.stderr.write("\n");
  for (let i = 0; i < n; i++) {
    seconds[i][i] = 0;
  }
  return seconds;
}

function nextWednesday13LocalEpoch() {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
  d.setHours(13, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// --------------------------------------------------------------------
// Speed-limit routing over the real OSM road network (no traffic).
// --------------------------------------------------------------------

function buildRoad() {
  const osmPath = path.join(root, "data", "osm.json");
  const osm = JSON.parse(fs.readFileSync(osmPath, "utf8"));
  process.stderr.write(`road: building graph from ${osm.elements.length} elements …\n`);
  const graph = buildGraph(osm.elements);
  process.stderr.write(`road: ${graph.n} nodes, ${graph.head.length} directed edges\n`);
  return driveMatrix(graph, anchors);
}

// --------------------------------------------------------------------

const key = process.env.GOOGLE_MAPS_API_KEY;
const hasOsm = fs.existsSync(path.join(root, "data", "osm.json"));
const provider = key ? "google" : hasOsm ? "road" : "synthetic";
if (provider === "google") {
  const elements = n * n;
  console.log(
    `google provider: ${n} anchors -> ${elements} elements. ` +
      `Check Distance Matrix pricing for this volume before large runs.`,
  );
}
const seconds =
  provider === "google"
    ? await buildGoogle(key)
    : provider === "road"
      ? buildRoad()
      : buildSynthetic();

fs.writeFileSync(
  path.join(root, "data", "matrix.json"),
  JSON.stringify({ mode: "drive", provider, n, seconds }),
);
console.log(`matrix: ${n}x${n} ${provider} drive matrix -> data/matrix.json`);
