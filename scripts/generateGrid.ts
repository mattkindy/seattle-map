// generateGrid.ts: lay a hex grid of anchor points over Seattle and
// drop the ones that land in water. Output: data/grid.json.
//
// The water test is a coarse polygon model (Puget Sound to the west,
// Lake Washington to the east, Ship Canal / Lake Union / Green Lake
// inside), enough to keep anchors off the big water bodies. Routing
// providers snap to the nearest road anyway, so precision here only
// affects visual density, and a stray anchor on a shoreline is harmless.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Anchor, Grid, MeshEdge } from "../src/types.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Bounding box: Shoreline down to Rainier Beach, Puget Sound to Lake
// Washington's east shore. Deliberately city-focused for v1 (no
// Eastside), so the grid is dense where the map is interesting.
const BOUNDS = {
  north: 47.734,
  south: 47.5,
  west: -122.43,
  east: -122.24,
};

// Hex spacing in degrees latitude (~0.0045 deg ≈ 500 m between rows).
// Dense enough that every water crossing gets opposite-bank anchors
// close to its bridge; price out the matrix before a paid run.
const ROW_SPACING = 0.0045;

// Longitude degrees are compressed by cos(latitude); correct the column
// spacing so hexes are near-equilateral on the ground.
const LAT_MID = (BOUNDS.north + BOUNDS.south) / 2;
const COL_SPACING =
  (ROW_SPACING / Math.cos((LAT_MID * Math.PI) / 180)) * (2 / Math.sqrt(3));

type Ring = Array<[number, number]>; // [lng, lat]

// Coarse water polygons. The canal and bays are deliberately thin: an
// over-wide polygon deletes land rows (Interbay, lower Fremont) and
// tears the mesh where there is no water.
const WATER: Array<{ name: string; ring: Ring }> = [
  // Puget Sound: everything west of a ragged coastline, incl. Elliott Bay.
  {
    name: "puget-sound",
    ring: [
      [-122.43, 47.5],
      [-122.43, 47.734],
      [-122.395, 47.734],
      [-122.408, 47.69],
      [-122.404, 47.668],
      [-122.42, 47.64],
      [-122.407, 47.6],
      [-122.34, 47.6],
      [-122.335, 47.59],
      [-122.36, 47.575],
      [-122.4, 47.5],
    ],
  },
  // Lake Washington: everything east of the west shoreline.
  {
    name: "lake-washington",
    ring: [
      [-122.24, 47.5],
      [-122.24, 47.734],
      [-122.275, 47.734],
      [-122.28, 47.7],
      [-122.265, 47.66],
      [-122.255, 47.64],
      [-122.27, 47.6],
      [-122.285, 47.58],
      [-122.26, 47.55],
      [-122.255, 47.5],
    ],
  },
  // Union Bay (Montlake to Laurelhurst).
  {
    name: "union-bay",
    ring: [
      [-122.3, 47.648],
      [-122.3, 47.662],
      [-122.266, 47.662],
      [-122.266, 47.648],
    ],
  },
  // Lake Union proper (Westlake to Eastlake, SLU to Gas Works).
  {
    name: "lake-union",
    ring: [
      [-122.343, 47.623],
      [-122.343, 47.649],
      [-122.327, 47.649],
      [-122.3235, 47.638],
      [-122.327, 47.623],
    ],
  },
  // North Lake Union: the lobe by Gas Works, up to the canal mouth.
  {
    name: "lake-union-north",
    ring: [
      [-122.339, 47.649],
      [-122.339, 47.6535],
      [-122.327, 47.6535],
      [-122.327, 47.649],
    ],
  },
  // Portage Bay between Eastlake and Montlake.
  {
    name: "portage-bay",
    ring: [
      [-122.331, 47.644],
      [-122.331, 47.654],
      [-122.303, 47.654],
      [-122.303, 47.644],
    ],
  },
  // Montlake Cut: joins Portage Bay to Union Bay.
  {
    name: "montlake-cut",
    ring: [
      [-122.306, 47.6455],
      [-122.306, 47.6515],
      [-122.295, 47.6515],
      [-122.295, 47.6455],
    ],
  },
  // Green Lake.
  {
    name: "green-lake",
    ring: [
      [-122.345, 47.673],
      [-122.345, 47.687],
      [-122.325, 47.687],
      [-122.325, 47.673],
    ],
  },
  // Salmon Bay: the locks to the Ballard Bridge.
  {
    name: "salmon-bay",
    ring: [
      [-122.413, 47.66],
      [-122.413, 47.672],
      [-122.383, 47.666],
      [-122.383, 47.656],
    ],
  },
  // Fremont cut: thin diagonal from the Ballard Bridge to Lake Union.
  {
    name: "fremont-canal",
    ring: [
      [-122.383, 47.656],
      [-122.383, 47.664],
      [-122.343, 47.651],
      [-122.343, 47.643],
    ],
  },
  // Duwamish waterway / Harbor Island between SODO and West Seattle.
  {
    name: "duwamish",
    ring: [
      [-122.359, 47.52],
      [-122.359, 47.588],
      [-122.335, 47.588],
      [-122.335, 47.52],
    ],
  },
];

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function inWater(lng: number, lat: number): boolean {
  return WATER.some((w) => pointInRing(lng, lat, w.ring));
}

// Real crossings. A mesh edge may cross water only near one of these,
// so the mesh tears along the canal and the Duwamish except where a
// bridge actually exists. [name, lat, lng]
const BRIDGES: Array<[string, number, number]> = [
  ["Ballard Bridge", 47.6598, -122.3764],
  ["Fremont Bridge", 47.6476, -122.3497],
  ["Aurora Bridge", 47.6462, -122.3476],
  ["University Bridge", 47.6529, -122.3205],
  ["Montlake Bridge", 47.6473, -122.3045],
  ["West Seattle Bridge", 47.5706, -122.3524],
  ["1st Ave S Bridge", 47.5422, -122.334],
];
const BRIDGE_RADIUS_KM = 0.35;

const kmPerDegLngLocal = 111.32 * Math.cos((LAT_MID * Math.PI) / 180);
function kmBetween(a: Anchor, b: Anchor): number {
  return Math.hypot(
    (a.lat - b.lat) * 111.32,
    (a.lng - b.lng) * kmPerDegLngLocal,
  );
}

function segmentBridgeIdx(a: Anchor, b: Anchor): number {
  // Distance from each bridge point to segment a-b, in km; a crossing
  // belongs to a bridge only when the segment passes nearly over it.
  const ax = a.lng * kmPerDegLngLocal;
  const ay = a.lat * 111.32;
  const bx = b.lng * kmPerDegLngLocal;
  const by = b.lat * 111.32;
  let best = -1;
  let bd = Infinity;
  BRIDGES.forEach(([, blat, blng], i) => {
    const px = blng * kmPerDegLngLocal;
    const py = blat * 111.32;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return bd < BRIDGE_RADIUS_KM ? best : -1;
}

export async function main(): Promise<void> {
  const anchors: Anchor[] = [];
  let row = 0;
  for (let lat = BOUNDS.south; lat <= BOUNDS.north; lat += ROW_SPACING) {
    const offset = row % 2 === 0 ? 0 : COL_SPACING / 2;
    for (let lng = BOUNDS.west + offset; lng <= BOUNDS.east; lng += COL_SPACING) {
      if (!inWater(lng, lat)) {
        anchors.push({
          id: anchors.length,
          lat: Number(lat.toFixed(6)),
          lng: Number(lng.toFixed(6)),
        });
      }
    }
    row++;
  }

  // Mesh edges: neighbors within 1.5 grid steps. An edge whose sampled
  // midpoints fall in water is dropped unless the crossing sits at a
  // bridge, in which case it is kept and tagged.
  const STEP_KM = ROW_SPACING * 111.32;
  const edges: MeshEdge[] = [];
  const crossingCandidates: Array<{ i: number; j: number; km: number; bridge: number }> = [];
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const a = anchors[i];
      const b = anchors[j];
      const km = kmBetween(a, b);
      // Bridge crossings span the water, so opposite-bank anchors sit
      // farther apart than on-land neighbors; give them extra reach. The
      // two-shortest-per-bridge cap below keeps long diagonals out.
      if (km > STEP_KM * 4.5) {
        continue;
      }
      let wet = false;
      for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const lat = a.lat + (b.lat - a.lat) * t;
        const lng = a.lng + (b.lng - a.lng) * t;
        if (inWater(lng, lat)) {
          wet = true;
          break;
        }
      }
      if (!wet) {
        if (km <= STEP_KM * 1.6) {
          edges.push([i, j, 0]);
        }
      } else {
        const bridge = segmentBridgeIdx(a, b);
        if (bridge >= 0) {
          crossingCandidates.push({ i, j, km, bridge });
        }
      }
    }
  }
  // One bridge = its two shortest crossing pairs, so every crossing
  // renders as a short, near-perpendicular deck instead of a fan of
  // long diagonals.
  crossingCandidates.sort((p, q) => p.km - q.km);
  const perBridge = new Map<number, number>();
  for (const c of crossingCandidates) {
    const used = perBridge.get(c.bridge) ?? 0;
    if (used < 2) {
      edges.push([c.i, c.j, 1]);
      perBridge.set(c.bridge, used + 1);
    }
  }
  const bridgeEdges = edges.filter((e) => e[2] === 1).length;

  const out: Grid = { bounds: BOUNDS, count: anchors.length, anchors, edges };
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "grid.json"),
    JSON.stringify(out, null, 2),
  );
  console.log(
    `grid: ${anchors.length} land anchors, ${edges.length} edges (${bridgeEdges} bridge) -> data/grid.json`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
