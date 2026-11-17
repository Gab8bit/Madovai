/**
 * In-memory TTL cache with single-flight: when N clients ask for the same thing at once only ONE upstream request
 * runs (Cotral / Roma Mobilità / ASTRAL are not ours to hammer) and everyone awaits the same promise. On failure, a
 * stale value up to `maxStaleMs` old is served instead of an error (a few-seconds-old bus time beats an error page).
 *
 * The backend is a single long-running process, so this replaces Madovai-Web's file cache.
 */
interface Entry<T> { value: T; at: number }

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_ENTRIES = 5000;

export async function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>, maxStaleMs = 300_000): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  const now = Date.now();
  if (hit && now - hit.at <= ttlMs) return hit.value;

  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;

  const p = (async () => {
    try {
      const value = await producer();
      store.set(key, { value, at: Date.now() });
      if (store.size > MAX_ENTRIES) prune();
      return value;
    } catch (err) {
      if (hit && Date.now() - hit.at <= maxStaleMs) return hit.value;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Peek without producing (e.g. to reuse a fresh value inside a fan-out). */
export function peek<T>(key: string, ttlMs: number): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined;
  return hit && Date.now() - hit.at <= ttlMs ? hit.value : undefined;
}

export function invalidate(prefix = ''): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

/** Drops the oldest half when the cache grows too large (bounded memory). */
function prune(): void {
  const entries = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [k] of entries.slice(0, Math.floor(entries.length / 2))) store.delete(k);
}
