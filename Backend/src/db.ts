import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, ensureDataDir } from './config.js';
import { NotReady } from './lib/errors.js';

/**
 * SQLite access.
 *  - gtfs():  read-only static data built by the GTFS builder (data/madovai.sqlite). Schema: docs/API.md.
 *  - state(): read-write user state (push devices + reminders) (data/state.sqlite).
 *
 * The builder writes a new file and atomically renames it over the old one; `reopenGtfs()` makes the next query use it.
 */
let gtfsHandle: Database.Database | null = null;
let gtfsInode = 0;
let stateHandle: Database.Database | null = null;

export const gtfsPath = () => path.join(config.dataDir, 'madovai.sqlite');

export function gtfsReady(): boolean {
  return fs.existsSync(gtfsPath());
}

export function gtfs(): Database.Database {
  const file = gtfsPath();
  let ino = 0;
  try { ino = fs.statSync(file).ino; } catch { throw new NotReady(); }
  if (!gtfsHandle || ino !== gtfsInode) {
    gtfsHandle?.close();
    gtfsHandle = new Database(file, { readonly: true, fileMustExist: true });
    gtfsHandle.pragma('cache_size = -20000');
    gtfsInode = ino;
  }
  return gtfsHandle;
}

/** meta.schema_version of the static database (0 when missing or unreadable). */
export function gtfsSchemaVersion(): number {
  try {
    const v = gtfs().prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
    return Number(v ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function reopenGtfs(): void {
  gtfsHandle?.close();
  gtfsHandle = null;
}

export function state(): Database.Database {
  if (!stateHandle) {
    ensureDataDir();
    stateHandle = new Database(path.join(config.dataDir, 'state.sqlite'));
    stateHandle.pragma('journal_mode = WAL');
    stateHandle.pragma('busy_timeout = 5000');
  }
  return stateHandle;
}

export function closeAll(): void {
  gtfsHandle?.close();
  stateHandle?.close();
  gtfsHandle = stateHandle = null;
}
