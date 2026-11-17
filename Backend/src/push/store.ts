import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { state } from '../db.js';
import { NotReady } from '../lib/errors.js';
import type { Device, Reminder } from '../types.js';
import { romeNow, romeWallTs } from './clock.js';

/**
 * Devices + reminders in DATA_DIR/state.sqlite. Port of Madovai-Web's ReminderStore.php, generalised from Web Push
 * subscriptions to devices of three types (webpush / fcm / apns).
 *
 *   devices(id = sha256("<type>:<endpoint|token>"), type, payload = normalised Device JSON,
 *           created_at, updated_at, last_ok_at, last_test_at)
 *   reminders(device_id, id, json, last_done_date yyyymmdd Rome, retry_count, retry_at, retry_date, PK(device_id,id))
 *
 * `retry_date` pins a retry chain to the Rome day it started on, so a chain interrupted by midnight never wedges.
 *
 * Schema versions (PRAGMA user_version): 1 = the PHP schema (subscriptions + reminders.sub_id), migrated in place so
 * an existing Madovai-Web data dir keeps its subscriptions; 2 = this schema.
 */

export const MAX_DEVICES = 5000;
export const SCHEMA_VERSION = 2;

export interface CandidateRow {
  deviceId: string;
  id: string;
  /** Stored JSON: markDone/markRetry are guarded by it, so a concurrent re-sync that edited the reminder wins. */
  json: string;
  reminder: Reminder;
  lastDoneDate: number;
  retryCount: number;
  retryAt: number;
  retryDate: number;
  device: Device;
}

export interface ReminderRow {
  id: string;
  json: string;
  last_done_date: number;
  retry_count: number;
  retry_at: number;
  retry_date: number;
}

function createV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_ok_at INTEGER,
      last_test_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      json TEXT NOT NULL,
      last_done_date INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0,
      retry_date INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device_id, id)
    );
    CREATE INDEX IF NOT EXISTS reminders_done ON reminders(last_done_date);
  `);
}

/** v1 (PHP) -> v2: every Web Push subscription becomes a "webpush" device, reminders and their state are kept. */
function migrateFromPhp(db: Database.Database): void {
  const hasSubs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscriptions'").get();
  if (!hasSubs) { createV2(db); return; }
  db.exec('ALTER TABLE reminders RENAME TO reminders_v1');
  db.exec('DROP INDEX IF EXISTS reminders_done');
  createV2(db);
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth, created_at, updated_at, last_ok_at, last_test_at FROM subscriptions').all() as
    { id: string; endpoint: string; p256dh: string; auth: string; created_at: number; updated_at: number; last_ok_at: number | null; last_test_at: number | null }[];
  const insDev = db.prepare('INSERT OR IGNORE INTO devices (id, type, payload, created_at, updated_at, last_ok_at, last_test_at) VALUES (?,?,?,?,?,?,?)');
  const copyRem = db.prepare(`INSERT OR IGNORE INTO reminders (id, device_id, json, last_done_date, retry_count, retry_at, retry_date)
    SELECT id, ?, json, last_done_date, retry_count, retry_at, retry_date FROM reminders_v1 WHERE sub_id = ?`);
  for (const s of subs) {
    const device: Device = { type: 'webpush', subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } } };
    const id = ReminderStore.deviceId(device);
    insDev.run(id, 'webpush', JSON.stringify(device), s.created_at, s.updated_at, s.last_ok_at, s.last_test_at);
    copyRem.run(id, s.id);
  }
  db.exec('DROP TABLE reminders_v1; DROP TABLE subscriptions;');
}

export class ReminderStore {
  constructor(public readonly db: Database.Database = state()) {
    ReminderStore.migrate(db);
  }

  static migrate(db: Database.Database): void {
    if ((db.pragma('user_version', { simple: true }) as number) >= SCHEMA_VERSION) return;
    db.transaction(() => {
      const v = db.pragma('user_version', { simple: true }) as number;
      if (v < 1) createV2(db);
      else if (v === 1) migrateFromPhp(db);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }).immediate();
  }

  /** What identifies a device: the push endpoint (Web Push) or the registration token (FCM / APNs). */
  static deviceKey(device: Device): string {
    return device.type === 'webpush' ? device.subscription.endpoint : device.token;
  }

  static deviceId(device: Device): string {
    return crypto.createHash('sha256').update(`${device.type}:${ReminderStore.deviceKey(device)}`).digest('hex');
  }

  /**
   * Canonical signature of what makes a reminder fire: weekdays/hour/minute/source.
   * Equal signatures => state (done today / retries) is preserved on re-sync.
   */
  static scheduleSignature(r: Partial<Reminder>): string {
    const days = [...new Set((r.weekdays ?? []).map((d) => Math.trunc(Number(d))))].sort((a, b) => a - b);
    const src = (r.source ?? {}) as Record<string, unknown>;
    const sorted = Object.fromEntries(Object.keys(src).sort().map((k) => [k, src[k]]));
    return crypto.createHash('sha1').update(JSON.stringify([days, r.hour ?? -1, r.minute ?? -1, sorted])).digest('hex');
  }

  /**
   * last_done_date for a freshly saved/edited reminder: today when it is scheduled for today at a minute that is
   * already over (it must not fire retroactively), otherwise 0. A reminder saved during its own minute still fires.
   */
  static initialDoneDate(r: Reminder, now: Date): number {
    const n = romeNow(now);
    if (!r.weekdays.includes(n.weekday)) return 0;
    const minuteStart = n.ts - n.second;
    return romeWallTs(now, r.hour, r.minute) < minuteStart ? n.ymd : 0;
  }

  /**
   * Inserts/updates a device (keeps created_at / last_ok_at; refreshes the payload, e.g. new Web Push keys).
   * Call inside a transaction when combined with other writes. Throws NotReady (503) when the table is full.
   */
  upsertDevice(device: Device, nowTs: number): string {
    const id = ReminderStore.deviceId(device);
    const exists = this.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(id);
    if (!exists) {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
      if (count >= MAX_DEVICES) throw new NotReady('Servizio promemoria al completo, riprova più tardi');
      this.db.prepare('INSERT INTO devices (id, type, payload, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run(id, device.type, JSON.stringify(device), nowTs, nowTs);
    } else {
      this.db.prepare('UPDATE devices SET payload = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(device), nowTs, id);
    }
    return id;
  }

  /** upsertDevice in its own transaction (push-test). */
  saveDevice(device: Device, nowTs: number): string {
    return this.db.transaction(() => this.upsertDevice(device, nowTs)).immediate();
  }

  /**
   * Replaces the whole reminder list of a device in ONE transaction. Reminders whose id AND schedule are unchanged
   * keep their done/retry state; edited or new ones start clean, except that a reminder whose time already passed
   * earlier today is marked as done for today (no retroactive firing).
   */
  replaceReminders(device: Device, reminders: Reminder[], now: Date): number {
    const ts = Math.floor(now.getTime() / 1000);
    this.db.transaction(() => {
      const deviceId = this.upsertDevice(device, ts);
      const old = new Map<string, ReminderRow>();
      for (const row of this.db.prepare('SELECT id, json, last_done_date, retry_count, retry_at, retry_date FROM reminders WHERE device_id = ?').all(deviceId) as ReminderRow[]) {
        old.set(row.id, row);
      }
      this.db.prepare('DELETE FROM reminders WHERE device_id = ?').run(deviceId);
      const ins = this.db.prepare('INSERT INTO reminders (id, device_id, json, last_done_date, retry_count, retry_at, retry_date) VALUES (?,?,?,?,?,?,?)');
      for (const r of reminders) {
        const prev = old.get(r.id);
        let prevR: Reminder | null = null;
        try { prevR = prev ? JSON.parse(prev.json) : null; } catch { prevR = null; }
        const state = prev && prevR && typeof prevR === 'object' && ReminderStore.scheduleSignature(prevR) === ReminderStore.scheduleSignature(r)
          ? [prev.last_done_date, prev.retry_count, prev.retry_at, prev.retry_date]
          : [ReminderStore.initialDoneDate(r, now), 0, 0, 0];
        ins.run(r.id, deviceId, JSON.stringify(r), ...state);
      }
    }).immediate();
    return reminders.length;
  }

  deleteDevice(deviceId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM reminders WHERE device_id = ?').run(deviceId);
      this.db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId);
    }).immediate();
  }

  device(deviceId: string): Device | null {
    const r = this.db.prepare('SELECT payload FROM devices WHERE id = ?').get(deviceId) as { payload: string } | undefined;
    return r ? (JSON.parse(r.payload) as Device) : null;
  }

  touchOk(deviceId: string, ts: number): void {
    this.db.prepare('UPDATE devices SET last_ok_at = ? WHERE id = ?').run(ts, deviceId);
  }

  /** Rate limit for push tests: 0 (and the attempt is recorded) when allowed, otherwise the seconds to wait. */
  claimTest(deviceId: string, ts: number, minInterval = 30): number {
    const r = this.db.prepare('UPDATE devices SET last_test_at = ? WHERE id = ? AND (last_test_at IS NULL OR last_test_at <= ?)')
      .run(ts, deviceId, ts - minInterval);
    if (r.changes > 0) return 0;
    const last = (this.db.prepare('SELECT last_test_at AS t FROM devices WHERE id = ?').get(deviceId) as { t: number | null } | undefined)?.t ?? 0;
    return Math.max(1, minInterval - (ts - last));
  }

  /** Reminders that haven't completed today, with their device (the runner applies the exact due test). */
  candidates(dateInt: number): CandidateRow[] {
    const rows = this.db.prepare(`SELECT r.device_id, r.id, r.json, r.last_done_date, r.retry_count, r.retry_at, r.retry_date, d.payload
      FROM reminders r JOIN devices d ON d.id = r.device_id
      WHERE r.last_done_date != ? ORDER BY r.device_id, r.id`).all(dateInt) as (ReminderRow & { device_id: string; payload: string })[];
    const out: CandidateRow[] = [];
    for (const row of rows) {
      let reminder: Reminder, device: Device;
      try {
        reminder = JSON.parse(row.json);
        device = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (!reminder || typeof reminder !== 'object' || !device || typeof device !== 'object') continue;
      out.push({
        deviceId: row.device_id, id: row.id, json: row.json, reminder,
        lastDoneDate: row.last_done_date, retryCount: row.retry_count, retryAt: row.retry_at, retryDate: row.retry_date,
        device,
      });
    }
    return out;
  }

  /** Raw rows (tests / diagnostics). */
  reminderRows(deviceId: string): ReminderRow[] {
    return this.db.prepare('SELECT id, json, last_done_date, retry_count, retry_at, retry_date FROM reminders WHERE device_id = ? ORDER BY id').all(deviceId) as ReminderRow[];
  }

  markDone(deviceId: string, id: string, json: string, dateInt: number): void {
    this.db.prepare('UPDATE reminders SET last_done_date = ?, retry_count = 0, retry_at = 0, retry_date = 0 WHERE device_id = ? AND id = ? AND json = ?')
      .run(dateInt, deviceId, id, json);
  }

  markRetry(deviceId: string, id: string, json: string, count: number, retryAt: number, dateInt: number): void {
    this.db.prepare('UPDATE reminders SET retry_count = ?, retry_at = ?, retry_date = ? WHERE device_id = ? AND id = ? AND json = ?')
      .run(count, retryAt, dateInt, deviceId, id, json);
  }

  /** Removes devices with no sign of life (client sync or successful push) for `days` days. */
  pruneStale(nowTs: number, days = 90): number {
    const cutoff = nowTs - days * 86400;
    const ids = this.db.prepare('SELECT id FROM devices WHERE MAX(created_at, updated_at, COALESCE(last_ok_at, 0)) < ?').pluck().all(cutoff) as string[];
    for (const id of ids) this.deleteDevice(id);
    this.db.prepare('DELETE FROM reminders WHERE device_id NOT IN (SELECT id FROM devices)').run();
    return ids.length;
  }
}

let shared: ReminderStore | null = null;

/** The store on the shared state database (re-created if the handle was closed and reopened). */
export function getStore(): ReminderStore {
  const db = state();
  if (!shared || shared.db !== db) shared = new ReminderStore(db);
  return shared;
}
