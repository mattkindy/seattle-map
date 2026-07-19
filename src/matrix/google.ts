// Google Distance Matrix, batched in 25x25 blocks (the API's
// per-request element cap is 625). Costs money: price out count^2
// elements before running on a dense grid. A slice would map to a
// departure_time here (duration_in_traffic); for now the baseline is
// next Wednesday 13:00 local, a neutral midday.

import { createPool } from "../lib/pool.ts";
import type { Anchor } from "../types.ts";
import type { MatrixProvider } from "./index.ts";

const BLOCK = 25;
// Stay far under the default elements-per-minute quota.
const POOL = { concurrency: 1, qps: 0.8 };

interface MatrixElement {
  status: string;
  duration: { value: number };
  duration_in_traffic?: { value: number };
}

async function fetchBlock(
  key: string,
  origins: Anchor[],
  destinations: Anchor[],
  departureTime: number,
): Promise<(number | null)[][]> {
  const fmt = (list: Anchor[]) => list.map((p) => `${p.lat},${p.lng}`).join("|");
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
  const body = (await res.json()) as {
    status: string;
    rows: Array<{ elements: MatrixElement[] }>;
  };
  if (body.status !== "OK") {
    throw new Error(`distance matrix status ${body.status}`);
  }
  return body.rows.map((r) =>
    r.elements.map((e) =>
      e.status === "OK" ? (e.duration_in_traffic ?? e.duration).value : null,
    ),
  );
}

function nextWednesday13LocalEpoch(): number {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7));
  d.setHours(13, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export const google: MatrixProvider = {
  name: "google",
  available: (ctx) => Boolean(ctx.env.GOOGLE_MAPS_API_KEY),
  async build(anchors, ctx) {
    const key = ctx.env.GOOGLE_MAPS_API_KEY as string;
    const n = anchors.length;
    ctx.log(
      `google provider: ${n} anchors -> ${n * n} elements. ` +
        `Check Distance Matrix pricing for this volume before large runs.\n`,
    );
    const departure = nextWednesday13LocalEpoch();
    const seconds: (number | null)[][] = Array.from({ length: n }, () =>
      new Array(n).fill(null),
    );
    const blocks = Math.ceil(n / BLOCK);
    const jobs: Array<[number, number]> = [];
    for (let bi = 0; bi < blocks; bi++) {
      for (let bj = 0; bj < blocks; bj++) {
        jobs.push([bi, bj]);
      }
    }
    const pool = createPool(POOL);
    let done = 0;
    await pool.map(jobs, async ([bi, bj]) => {
      const origins = anchors.slice(bi * BLOCK, (bi + 1) * BLOCK);
      const dests = anchors.slice(bj * BLOCK, (bj + 1) * BLOCK);
      const block = await fetchBlock(key, origins, dests, departure);
      for (let i = 0; i < origins.length; i++) {
        for (let j = 0; j < dests.length; j++) {
          seconds[bi * BLOCK + i][bj * BLOCK + j] = block[i][j];
        }
      }
      done++;
      ctx.log(`\rblocks: ${done}/${jobs.length}`);
    });
    ctx.log("\n");
    for (let i = 0; i < n; i++) {
      seconds[i][i] = 0;
    }
    return seconds;
  },
};
