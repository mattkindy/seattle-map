// TomTom Flow Segment Data reports current vs free-flow travel time on
// the road fragment nearest a coordinate. The slowdown factor is
// currentTravelTime / freeFlowTravelTime; the two speeds are carried
// through for display. Live conditions, so the run's wall-clock time is
// the slice it captures (run at 5pm for the evening peak). Free tier,
// self-serve key in TOMTOM_API_KEY.
// https://developer.tomtom.com/traffic-api/documentation/tomtom-maps/traffic-flow/flow-segment-data

import { createPool, retry, sleep } from "../lib/pool.ts";
import type { ProviderCtx } from "../lib/providers.ts";
import { clampFactor, type Reading, type SpeedProvider } from "./index.ts";

const ENDPOINT =
  "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json";
// Freemium keys are limited to 5 queries per second; pace below that so
// bursts from concurrent workers do not trip the limiter.
// https://docs.tomtom.com/platform/documentation/api-best-practices/qps-limits
const POOL = { concurrency: 4, qps: 4 };

interface FlowSegment {
  currentSpeed: number;
  freeFlowSpeed: number;
  currentTravelTime: number;
  freeFlowTravelTime: number;
  roadClosure: boolean;
}

type PointReading = Omit<Reading, "lat" | "lng">;

const NO_DATA: PointReading = {
  factor: 1,
  currentKmh: null,
  freeFlowKmh: null,
};

async function readPoint(key: string, lat: number, lng: number): Promise<PointReading> {
  return retry(async () => {
    const res = await fetch(
      `${ENDPOINT}?key=${key}&point=${lat},${lng}&unit=KMPH`,
    );
    if (res.status === 400) {
      // No road fragment within snapping range of this point (parks,
      // greenbelts, industrial waterfront). Not an error: the roads that
      // do exist nearby stay at free-flow.
      const err = new Error("no road data") as Error & { permanent: boolean };
      err.permanent = true;
      throw err;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep(retryAfter * 1000);
      throw new Error("http 429");
    }
    if (!res.ok) {
      throw new Error(`http ${res.status}`);
    }
    const body = (await res.json()) as { flowSegmentData?: FlowSegment };
    const f = body.flowSegmentData;
    if (!f) {
      return NO_DATA;
    }
    if (f.roadClosure) {
      return { factor: clampFactor(Infinity), currentKmh: 0, freeFlowKmh: f.freeFlowSpeed };
    }
    const factor = f.freeFlowTravelTime
      ? clampFactor(f.currentTravelTime / f.freeFlowTravelTime)
      : 1;
    return { factor, currentKmh: f.currentSpeed, freeFlowKmh: f.freeFlowSpeed };
  });
}

export const tomtom: SpeedProvider = {
  name: "tomtom",
  available: (ctx: ProviderCtx) => Boolean(ctx.env.TOMTOM_API_KEY),
  async read(points, ctx) {
    const key = ctx.env.TOMTOM_API_KEY as string;
    const pool = createPool(POOL);
    let done = 0;
    let noData = 0;
    let failed = 0;
    const out = await pool.map(points, async (p): Promise<Reading> => {
      let r = NO_DATA;
      try {
        r = await readPoint(key, p.lat, p.lng);
      } catch (err) {
        if ((err as { permanent?: boolean }).permanent) {
          noData++;
        } else {
          failed++;
        }
      }
      done++;
      if (done % 25 === 0 || done === points.length) {
        ctx.log(
          `\rtomtom: ${done}/${points.length} (${noData} no road, ${failed} failed)`,
        );
      }
      return { lat: p.lat, lng: p.lng, ...r };
    });
    ctx.log("\n");
    return out;
  },
};
