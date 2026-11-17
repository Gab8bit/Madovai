/**
 * Concurrent fan-out with an overall deadline (the Node equivalent of Madovai-Web's curl_multi `Multi::fetch`):
 * every task starts at once; whatever has not settled when the deadline expires — or rejected — yields `undefined`
 * (a failed sub-request is skipped, never fatal). Tasks still running keep going in the background (and, being
 * wrapped in `cached()`, still fill the cache for the next caller).
 */
export async function settleWithin<K, T>(keys: K[], task: (key: K) => Promise<T>, deadlineMs: number): Promise<Map<K, T>> {
  const out = new Map<K, T>();
  if (keys.length === 0) return out;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadlineMs)); });
  const all = Promise.allSettled(keys.map(async (k) => {
    const v = await task(k);
    out.set(k, v);
  }));
  try {
    await Promise.race([all, deadline]);
  } finally {
    clearTimeout(timer);
  }
  // Snapshot: results arriving after the deadline must not mutate what the caller iterates.
  return new Map(out);
}
