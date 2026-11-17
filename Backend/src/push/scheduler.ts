import type { FastifyBaseLogger } from 'fastify';
import { romeNow } from './clock.js';
import { ReminderRunner, type StatusFetcher } from './runner.js';
import { closeChannels, send, type Sender } from './send.js';
import { getStore, type ReminderStore } from './store.js';

/**
 * In-process replacement for Madovai-Web's `* * * * * php bin/remind.php` cron line: runs the reminder runner once a
 * minute, aligned to :00, never two runs at once (a slow run makes the next tick skip, as the PHP flock did).
 * Every 10 minutes it also prunes devices with no sign of life for 90 days. Returns a stop function.
 */

const MINUTE = 60_000;
/** Fire a little after the boundary so the clock reading is never 59.999 s of the previous minute. */
const AFTER_BOUNDARY_MS = 250;

let fetcher: StatusFetcher | null = null;

/**
 * `departureStatus(reminder)` from the live module, imported lazily (and retried on every run until it loads):
 * a missing/broken live module must not break the push module. A failed import = no data = the retry policy.
 */
async function loadFetcher(log: FastifyBaseLogger): Promise<StatusFetcher> {
  if (fetcher) return fetcher;
  try {
    const spec = '../live/departureStatus.js';
    const mod = (await import(spec)) as { departureStatus?: StatusFetcher };
    if (typeof mod.departureStatus !== 'function') throw new Error('departureStatus is not exported');
    fetcher = mod.departureStatus;
    return fetcher;
  } catch (err) {
    log.error({ err }, 'reminders: live/departureStatus not available');
    return async () => null;
  }
}

export interface SchedulerDeps {
  /** Injectable for tests. */
  store?: () => ReminderStore;
  fetch?: StatusFetcher;
  sender?: Sender;
  now?: () => Date;
}

/** One scheduler tick (exported for tests). */
export async function runOnce(log: FastifyBaseLogger, now: Date, deps: SchedulerDeps = {}): Promise<void> {
  const store = (deps.store ?? getStore)();
  const fetch = deps.fetch ?? (await loadFetcher(log));
  const runner = new ReminderRunner(store, fetch, deps.sender ?? send, {
    log: (m) => (/error|failed|giving up|gone/.test(m) ? log.warn(`reminders: ${m}`) : log.info(`reminders: ${m}`)),
  });
  const stats = await runner.run(now);
  if (stats.due > 0) log.info({ stats }, 'reminders: run done');
  if (romeNow(now).minute % 10 === 0) {
    const n = store.pruneStale(Math.floor(now.getTime() / 1000));
    if (n > 0) log.info(`reminders: pruned ${n} stale devices`);
  }
}

export function startReminderScheduler(log: FastifyBaseLogger, deps: SchedulerDeps = {}): () => void {
  const clock = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const delay = MINUTE - (clock().getTime() % MINUTE) + AFTER_BOUNDARY_MS;
    timer = setTimeout(tick, delay);
  };

  const tick = () => {
    scheduleNext();
    if (running) {
      log.warn('reminders: previous run still in progress, skipping this minute');
      return;
    }
    running = true;
    runOnce(log, clock(), deps)
      .catch((err) => log.error({ err }, 'reminders: run failed'))
      .finally(() => { running = false; });
  };

  scheduleNext();
  log.info('reminders: scheduler started (every minute)');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    closeChannels();
  };
}
