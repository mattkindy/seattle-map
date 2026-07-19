// Shared data shapes that cross module boundaries. Module-specific
// contracts (SpeedProvider, MatrixProvider, RoadGraph) live with the
// modules that own them.

export interface Anchor {
  id: number;
  lat: number;
  lng: number;
}

/** [i, j, kind]: kind 0 = land mesh edge, 1 = bridge crossing. */
export type MeshEdge = [number, number, number];

export interface Grid {
  bounds: { north: number; south: number; east: number; west: number };
  count: number;
  anchors: Anchor[];
  edges: MeshEdge[];
  /** Coarse water outlines as [lng, lat] rings, for the basemap. */
  water?: Array<{ name: string; ring: Array<[number, number]> }>;
}

// A time slice names one traffic condition. "freeflow" is the reserved
// baseline (posted speed limits, no traffic layer); every other slice is
// a capture from a speed provider at some moment.
export const FREEFLOW = "freeflow";

export interface TrafficFile {
  slice: string;
  label: string;
  provider: string;
  capturedAt: string;
  readings: import("./traffic/index.ts").Reading[];
}

export interface MatrixFile {
  mode: "drive";
  provider: string;
  slice: string;
  /** Speed provider the slice came from; null for freeflow. */
  traffic: string | null;
  n: number;
  seconds: (number | null)[][];
}

export interface EmbeddedAnchor extends Anchor {
  /** Time-space position, km-comparable after Procrustes. */
  tx: number;
  ty: number;
  stress: number;
}

export interface EmbeddingFile {
  provider: string;
  slice: string;
  traffic: string | null;
  stress: number;
  anchors: EmbeddedAnchor[];
}
