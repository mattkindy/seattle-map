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

// Coarse water polygons as [lng, lat] rings.
const WATER = [
  // Puget Sound: everything west of a ragged coastline.
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
  // Lake Union + Portage Bay.
  {
    name: "lake-union",
    ring: [
      [-122.345, 47.62],
      [-122.345, 47.655],
      [-122.32, 47.655],
      [-122.305, 47.645],
      [-122.31, 47.62],
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
  // Ship Canal / Salmon Bay west of Lake Union.
  {
    name: "ship-canal",
    ring: [
      [-122.415, 47.655],
      [-122.415, 47.668],
      [-122.345, 47.662],
      [-122.345, 47.65],
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

const out = { bounds: BOUNDS, count: anchors.length, anchors };
fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(
  path.join(root, "data", "grid.json"),
  JSON.stringify(out, null, 2),
);
console.log(`grid: ${anchors.length} land anchors written to data/grid.json`);
