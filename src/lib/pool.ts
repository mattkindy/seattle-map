// A shared work pool with a concurrency cap and an optional
// queries-per-second ceiling. Providers use this instead of hand-rolled
// worker loops and sleeps, so pacing policy lives in one place.

export interface PoolOptions {
  concurrency: number;
  /** Maximum request starts per second across the whole pool. */
  qps?: number;
}

export interface Pool {
  run<T>(fn: () => Promise<T>): Promise<T>;
  map<T, R>(
    items: readonly T[],
    fn: (item: T, i: number) => Promise<R>,
  ): Promise<R[]>;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function createPool({ concurrency, qps }: PoolOptions): Pool {
  let active = 0;
  let nextSlot = 0;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active >= concurrency) {
      await new Promise<void>((r) => waiters.push(r));
    }
    active++;
    if (qps) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + 1000 / qps;
      if (wait > 0) {
        await sleep(wait);
      }
    }
  }

  function release(): void {
    active--;
    waiters.shift()?.();
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function map<T, R>(
    items: readonly T[],
    fn: (item: T, i: number) => Promise<R>,
  ): Promise<R[]> {
    return Promise.all(items.map((item, i) => run(() => fn(item, i))));
  }

  return { run, map };
}

export interface RetryOptions {
  attempts?: number;
  /** Base backoff in ms; attempt k waits k * backoffMs. */
  backoffMs?: number;
}

// Retry transient failures with linear backoff. A thrown error whose
// `permanent` property is true aborts immediately (e.g. HTTP 400: the
// request will never succeed, do not burn attempts on it).
export async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, backoffMs = 300 }: RetryOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let k = 1; k <= attempts; k++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { permanent?: boolean }).permanent) {
        throw err;
      }
      lastErr = err;
      if (k < attempts) {
        await sleep(k * backoffMs);
      }
    }
  }
  throw lastErr;
}
