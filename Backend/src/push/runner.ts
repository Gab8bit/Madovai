import type { DepartureStatus, Reminder } from '../types.js';
import { romeNow, romeWallTs } from './clock.js';
import { reminderPayload, payloadJson } from './notifier.js';
import type { Sender } from './send.js';
import type { CandidateRow, ReminderStore } from './store.js';

/**
 * Server-side equivalent of iOS `ReminderScheduler.run` — a port of Madovai-Web's ReminderRunner.php: invoked every
 * minute, finds due reminders, fetches the next departure, sends the push.
 *
 * Retry policy (identical to iOS/PHP): fetch failure or no data => NO notification, retry in 120 s; the 15th failed
 * attempt gives up silently until the next scheduled day; a retry chain never outlives 60 minutes after the
 * scheduled time. A push service saying the device is gone deletes the device (and skips its other reminders).
 */

export const GRACE_SECONDS = 300;
export const RETRY_INTERVAL = 120;
export const MAX_ATTEMPTS = 15;
export const RETRY_WINDOW = 3600;
/** Devices served in parallel (one device's reminders stay sequential). */
export const CONCURRENCY = 8;

export type StatusFetcher = (reminder: Reminder) => Promise<DepartureStatus | null>;

export interface RunStats { due: number; sent: number; failed: number; gone: number; gaveUp: number }

type DueRow = Pick<CandidateRow, 'reminder' | 'lastDoneDate' | 'retryCount' | 'retryAt' | 'retryDate'>;

/** Pure due test. */
export function isDue(row: DueRow, now: Date): boolean {
  const r = row.reminder;
  const n = romeNow(now);
  // 1 = Sunday … 7 = Saturday, as Apple's Calendar.
  if (!r.weekdays.map(Number).includes(n.weekday)) return false;
  if (row.lastDoneDate === n.ymd) return false;
  const sched = romeWallTs(now, r.hour, r.minute);
  // A retry chain only counts on the day it started.
  const retries = row.retryDate === n.ymd ? row.retryCount : 0;
  if (retries > 0) return retries < MAX_ATTEMPTS && n.ts >= row.retryAt && n.ts < sched + RETRY_WINDOW;
  return n.ts >= sched && n.ts < sched + GRACE_SECONDS;
}

export interface RunnerOptions {
  log?: (msg: string) => void;
  /** false = dry run: send, but never touch the state. */
  persist?: boolean;
  concurrency?: number;
}

export class ReminderRunner {
  private readonly log: (msg: string) => void;
  private readonly persist: boolean;
  private readonly concurrency: number;

  constructor(
    private readonly store: ReminderStore,
    private readonly fetch: StatusFetcher,
    private readonly sender: Sender,
    opts: RunnerOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.persist = opts.persist ?? true;
    this.concurrency = Math.max(1, opts.concurrency ?? CONCURRENCY);
  }

  async run(now: Date): Promise<RunStats> {
    const { ymd: today, ts } = romeNow(now);
    const stats: RunStats = { due: 0, sent: 0, failed: 0, gone: 0, gaveUp: 0 };
    // Same source asked twice in a run -> one upstream fetch (shared promise, also across parallel devices).
    const statusMemo = new Map<string, Promise<DepartureStatus | null>>();

    const byDevice = new Map<string, CandidateRow[]>();
    for (const row of this.store.candidates(today)) {
      if (!isDue(row, now)) continue;
      const list = byDevice.get(row.deviceId);
      if (list) list.push(row); else byDevice.set(row.deviceId, [row]);
    }

    const status = (rem: Reminder, label: string): Promise<DepartureStatus | null> => {
      const key = JSON.stringify(rem.source);
      let p = statusMemo.get(key);
      if (!p) {
        p = this.fetch(rem).then((s) => s ?? null, (err: unknown) => {
          this.log(`fetch error for ${label}: ${(err as Error)?.message ?? String(err)}`);
          return null;
        });
        statusMemo.set(key, p);
      }
      return p;
    };

    const serveDevice = async (rows: CandidateRow[]) => {
      for (const row of rows) {
        stats.due++;
        const rem = row.reminder;
        const label = `${rem.id} (${rem.stopName} ${rem.hour}:${String(rem.minute).padStart(2, '0')})`;
        const st = await status(rem, label);

        let failure: string;
        if (st === null) {
          failure = 'no data';
        } else {
          const payload = reminderPayload(rem, st);
          const result = await this.sender(row.device, payload);
          if (result.ok) {
            stats.sent++;
            this.log(`sent ${label} [${row.device.type}]: ${payloadJson(payload)}`);
            if (this.persist) {
              this.store.touchOk(row.deviceId, ts);
              this.store.markDone(row.deviceId, row.id, row.json, today);
            }
            continue;
          }
          if (result.gone) {
            stats.gone++;
            this.log(`device gone (${result.status} ${result.error}) — removing ${row.device.type} ${row.deviceId}`);
            if (this.persist) this.store.deleteDevice(row.deviceId);
            return; // the device's other reminders go with it
          }
          failure = `push failed: HTTP ${result.status} ${result.error}`;
        }

        // Failure: same policy as iOS (attempt counter, 2 min retry, give up at 15).
        const attempt = (row.retryDate === today ? row.retryCount : 0) + 1;
        stats.failed++;
        if (attempt < MAX_ATTEMPTS) {
          this.log(`${failure} for ${label} — attempt ${attempt}, retry in ${RETRY_INTERVAL} s`);
          if (this.persist) this.store.markRetry(row.deviceId, row.id, row.json, attempt, ts + RETRY_INTERVAL, today);
        } else {
          stats.gaveUp++;
          this.log(`${failure} for ${label} — attempt ${attempt}, giving up until the next scheduled day`);
          if (this.persist) this.store.markDone(row.deviceId, row.id, row.json, today);
        }
      }
    };

    const queue = [...byDevice.values()];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, async () => {
      for (let rows = queue.shift(); rows; rows = queue.shift()) {
        try {
          await serveDevice(rows);
        } catch (err) {
          this.log(`error serving device ${rows[0].deviceId}: ${(err as Error).message}`);
        }
      }
    });
    await Promise.all(workers);
    return stats;
  }
}
