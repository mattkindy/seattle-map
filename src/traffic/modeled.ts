// Modeled peak profile: no external data. A slowdown that peaks in the
// core and decays outward, standing in for rush hour so the pipeline runs
// without a key. It reports only a factor (no measured speeds) and is
// labeled modeled, not measured. Always available, so it is the fallback
// of last resort. Swap in a measured provider by setting its key.

import { clampFactor, type SpeedProvider } from "./index.ts";

const CORE = { lat: 47.606, lng: -122.335 }; // downtown
const PEAK = 0.9; // up to +90% travel time at the core
const SCALE_KM = 4; // falloff distance
const kmPerDegLng = 111.32 * Math.cos((47.61 * Math.PI) / 180);

export const modeled: SpeedProvider = {
  name: "modeled",
  available: () => true,
  async read(points) {
    return points.map((p) => {
      const d = Math.hypot(
        (p.lat - CORE.lat) * 111.32,
        (p.lng - CORE.lng) * kmPerDegLng,
      );
      const factor = clampFactor(1 + PEAK * Math.exp(-((d / SCALE_KM) ** 2)));
      return { lat: p.lat, lng: p.lng, factor, currentKmh: null, freeFlowKmh: null };
    });
  },
};
