// RAPTOR: round-based public transit routing over a GTFS timetable.
// Each round allows one more boarding; within a round, every pattern
// that gained an improved stop is scanned once, boarding the earliest
// catchable trip and improving arrival times downstream. Foot
// transfers run between rounds. Four rounds (three transfers) covers
// city trips.
//
// One run answers "leaving the origin at T, when is the earliest I can
// be at every stop"; the transit matrix calls it once per source
// anchor.

import type { Timetable } from "./gtfs.ts";

const INF = 0x7fffffff;

export interface RaptorOptions {
  rounds?: number;
}

/**
 * Earliest arrival at every stop.
 * @param access stop index -> seconds to reach it on foot from the
 *   origin (already includes the walk).
 * @param departSec departure time at the origin, seconds after
 *   midnight of the service day.
 */
export function raptor(
  tt: Timetable,
  access: ReadonlyMap<number, number>,
  departSec: number,
  opts: RaptorOptions = {},
): Int32Array {
  const rounds = opts.rounds ?? 4;
  const n = tt.stopIds.length;
  const best = new Int32Array(n).fill(INF);
  const current = new Int32Array(n).fill(INF);
  let marked = new Set<number>();

  for (const [stop, walkSec] of access) {
    const t = departSec + walkSec;
    if (t < best[stop]) {
      best[stop] = t;
      current[stop] = t;
      marked.add(stop);
    }
  }
  applyTransfers(tt, best, current, marked);

  for (let k = 0; k < rounds && marked.size > 0; k++) {
    // patterns touched by any marked stop
    const queue = new Map<number, number>(); // pattern -> earliest marked position
    for (const stop of marked) {
      for (const pi of tt.patternsAtStop[stop]) {
        const pattern = tt.patterns[pi];
        // first position of this stop in the pattern
        let pos = -1;
        for (let i = 0; i < pattern.stops.length; i++) {
          if (pattern.stops[i] === stop) {
            pos = i;
            break;
          }
        }
        if (pos < 0) {
          continue;
        }
        const prev = queue.get(pi);
        if (prev === undefined || pos < prev) {
          queue.set(pi, pos);
        }
      }
    }

    marked = new Set<number>();
    for (const [pi, startPos] of queue) {
      const p = tt.patterns[pi];
      const stops = p.stops;
      const len = stops.length;
      let trip = -1; // current onboard trip index
      for (let pos = startPos; pos < len; pos++) {
        const stop = stops[pos];
        // improve arrival with the onboard trip
        if (trip >= 0) {
          const arr = p.arr[trip * len + pos];
          if (arr < best[stop]) {
            best[stop] = arr;
            current[stop] = arr;
            marked.add(stop);
          }
        }
        // catch an earlier trip at this stop? board time comes from the
        // previous round's arrival (current holds this round's states;
        // RAPTOR's correctness allows the tighter bound best[])
        const reach = best[stop];
        if (reach < INF) {
          // binary search: earliest trip departing this position >= reach
          let lo = 0;
          let hi = p.tripCount - 1;
          let found = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (p.dep[mid * len + pos] >= reach) {
              found = mid;
              hi = mid - 1;
            } else {
              lo = mid + 1;
            }
          }
          if (found >= 0 && (trip < 0 || found < trip)) {
            trip = found;
          }
        }
      }
    }
    applyTransfers(tt, best, current, marked);
  }
  return best;
}

function applyTransfers(
  tt: Timetable,
  best: Int32Array,
  current: Int32Array,
  marked: Set<number>,
): void {
  const added: number[] = [];
  for (const stop of marked) {
    for (const [to, sec] of tt.transfers[stop]) {
      const t = best[stop] + sec;
      if (t < best[to]) {
        best[to] = t;
        current[to] = t;
        added.push(to);
      }
    }
  }
  for (const s of added) {
    marked.add(s);
  }
}
