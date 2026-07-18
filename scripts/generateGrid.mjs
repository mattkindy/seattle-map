// generateGrid.mjs — lay a hex grid of anchor points over Seattle and
// drop the ones that land in water. Output: data/grid.json.
//
// The water test is a coarse polygon model (Puget Sound to the west,
// Lake Washington to the east, Ship Canal / Lake Union / Green Lake
// inside), enough to keep anchors off the big water bodies. Routing
// providers snap to the nearest road anyway, so precision here only
// affects visual density, and a stray anchor on a shoreline is harmless.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Hex spacing in degrees latitude (~0.0055 deg ≈ 610 m between rows).
// Yields roughly 180-220 land anchors, a good v1 density: enough for
// the warp to bend around the water, few enough that a 25x25-blocked
// matrix fetch stays cheap.
const ROW_SPACING = 0.0055;

// Longitude degrees are compressed by cos(latitude); correct the column
// spacing so hexes are near-equilateral on the ground.
const LAT_MID = (BOUNDS.north + BOUNDS.south) / 2;
const COL_SPACING =
  (ROW_SPACING / Math.cos((LAT_MID * Math.PI) / 180)) * (2 / Math.sqrt(3));

// Coarse water polygons as [lng, lat] rings. The canal and bays are
// deliberately thin: an over-wide polygon deletes land rows (Interbay,
// lower Fremont) and tears the mesh where there is no water.
const WATER = [
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
      [-122.32, 47.649],
      [-122.317, 47.638],
      [-122.322, 47.623],
    ],
  },
  // Portage Bay between Eastlake and Montlake.
  {
    name: "portage-bay",
    ring: [
      [-122.322, 47.644],
      [-122.322, 47.657],
      [-122.303, 47.657],
      [-122.303, 47.644],
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
      [-122.338, 47.588],
      [-122.338, 47.52],
    ],
  },
];

function pointInRing(lng, lat, ring) {
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

function inWater(lng, lat) {
  return WATER.some((w) => pointInRing(lng, lat, w.ring));
}

const anchors = [];
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

// Real crossings. A mesh edge may cross water only near one of these,
// so the mesh tears along the canal and the Duwamish except where a
// bridge actually exists. [name, lat, lng]
const BRIDGES = [
  ["Ballard Bridge", 47.6598, -122.3764],
  ["Fremont Bridge", 47.6476, -122.3497],
  ["Aurora Bridge", 47.6462, -122.3476],
  ["I-5 Ship Canal Bridge", 47.6529, -122.3284],
  ["University Bridge", 47.6529, -122.3205],
  ["Montlake Bridge", 47.6473, -122.3045],
  ["West Seattle Bridge", 47.5706, -122.3524],
  ["1st Ave S Bridge", 47.5422, -122.3340],
];
const BRIDGE_RADIUS_KM = 0.55;

const kmPerDegLngLocal = 111.32 * Math.cos((LAT_MID * Math.PI) / 180);
function kmBetween(a, b) {
  return Math.hypot(
    (a.lat - b.lat) * 111.32,
    (a.lng - b.lng) * kmPerDegLngLocal,
  );
}
function nearBridge(lat, lng) {
  return BRIDGES.some(
    ([, blat, blng]) =>
      Math.hypot((lat - blat) * 111.32, (lng - blng) * kmPerDegLngLocal) <
      BRIDGE_RADIUS_KM,
  );
}

// Mesh edges: neighbors within 1.5 grid steps. An edge whose sampled
// midpoints fall in water is dropped unless the crossing sits at a
// bridge, in which case it is kept and tagged.
const STEP_KM = ROW_SPACING * 111.32;
const edges = [];
for (let i = 0; i < anchors.length; i++) {
  for (let j = i + 1; j < anchors.length; j++) {
    const a = anchors[i];
    const b = anchors[j];
    const km = kmBetween(a, b);
    // Bridge crossings span the water, so opposite-bank anchors sit
    // farther apart than on-land neighbors; give them extra reach.
    if (km > STEP_KM * 2.8) {
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
      const midLat = (a.lat + b.lat) / 2;
      const midLng = (a.lng + b.lng) / 2;
      if (nearBridge(midLat, midLng)) {
        edges.push([i, j, 1]);
      }
    }
  }
}
const bridgeEdges = edges.filter((e) => e[2] === 1).length;

const out = { bounds: BOUNDS, count: anchors.length, anchors, edges };
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(
  path.join(root, "data", "grid.json"),
  JSON.stringify(out, null, 2),
);
console.log(`grid: ${anchors.length} land anchors, ${edges.length} edges (${bridgeEdges} bridge) -> data/grid.json`);
