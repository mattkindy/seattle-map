// Synthetic Seattle drive model: always available, so the whole
// pipeline runs end to end with zero setup. Not pretending to be
// measured data; it encodes the two facts that make Seattle
// interesting: north-south is fast (I-5/99 corridors) and east-west
// across water is slow (a handful of bridges).
//
// Speed model: trips decompose into a north-south component (45 km/h
// effective) and an east-west component (22 km/h effective). A trip
// crossing the Ship Canal pays a bridge penalty; a trip whose straight
// line crosses Lake Union or Green Lake pays a detour factor. Plus a
// flat 90 s of trip overhead (parking, signals at the ends).

import type { Anchor } from "../types.ts";
import type { MatrixProvider } from "./index.ts";

const KM_PER_DEG_LAT = 111.32;
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);

const NS_KMH = 45;
const EW_KMH = 22;
const OVERHEAD_S = 90;
const SHIP_CANAL_LAT = 47.655;
const CANAL_PENALTY_S = 240;

interface Rect {
  south: number;
  north: number;
  west: number;
  east: number;
}

const LAKE_UNION: Rect = { south: 47.62, north: 47.655, west: -122.345, east: -122.305 };
const GREEN_LAKE: Rect = { south: 47.673, north: 47.687, west: -122.345, east: -122.325 };

function crossesRect(a: Anchor, b: Anchor, rect: Rect): boolean {
  // Does the segment's midpoint land in the rect while the endpoints
  // straddle it? Coarse but adequate for a detour factor.
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  return (
    midLat > rect.south &&
    midLat < rect.north &&
    midLng > rect.west &&
    midLng < rect.east
  );
}

function syntheticSeconds(a: Anchor, b: Anchor): number {
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

export const synthetic: MatrixProvider = {
  name: "synthetic",
  available: () => true,
  async build(anchors) {
    const n = anchors.length;
    const seconds: (number | null)[][] = [];
    for (let i = 0; i < n; i++) {
      const row: (number | null)[] = new Array(n);
      for (let j = 0; j < n; j++) {
        row[j] = i === j ? 0 : syntheticSeconds(anchors[i], anchors[j]);
      }
      seconds.push(row);
    }
    return seconds;
  },
};
