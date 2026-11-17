import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (one level above src/ or dist/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;
const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v: string | undefined, d: number) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * App-wide configuration: upstream URLs (constants, never user-supplied) + deployment settings from environment
 * variables (see .env.example). Mirrors Madovai-Web's src/Config.php and the iOS app's Config.swift.
 */
export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  /** Writable folder: GTFS SQLite, state SQLite, VAPID keys. A Docker volume in production. */
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  /** Comma-separated allowed origins for CORS, or "*" (native apps don't send an Origin; browsers do). */
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  /** Trust X-Forwarded-* headers (behind Cloudflare / a reverse proxy). */
  trustProxy: bool(env.TRUST_PROXY, true),
  logLevel: env.LOG_LEVEL || 'info',
  /** Requests per minute per IP on the public API. */
  rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 300),

  /** Daily GTFS rebuild, Rome time "HH:MM" (empty = never). Also built at startup when missing. */
  gtfsRebuildAt: env.GTFS_REBUILD_AT ?? '04:30',
  /** Run the per-minute reminder scheduler inside this process. */
  remindersEnabled: bool(env.REMINDERS_ENABLED, true),

  webPush: {
    /** "mailto:…" or "https://…" contact sent to push services (Apple rejects pushes without a valid one). */
    subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  fcm: {
    /** Firebase service-account JSON (Project settings → Service accounts). Empty = FCM disabled. */
    serviceAccountFile: env.FCM_SERVICE_ACCOUNT_FILE || '',
  },
  apns: {
    /** .p8 auth key from the Apple Developer portal. Empty = APNs disabled (needs the paid Apple Developer Program). */
    keyFile: env.APNS_KEY_FILE || '',
    keyId: env.APNS_KEY_ID || '',
    teamId: env.APNS_TEAM_ID || '',
    /** The iOS app bundle id, e.g. dev.gab8bit.madovai */
    topic: env.APNS_TOPIC || '',
    production: bool(env.APNS_PRODUCTION, false),
  },

  upstream: {
    cotralBase: 'http://travel.mob.cotralspa.it:7777/beApp',
    /** Default client id published in the MIT-licensed ChromuSx/cotral project (same one the iOS app uses). */
    cotralUserId: '1BB73DCDAFA007572FC51E7407AB497C',
    cotralDelta: '261',
    gtfsBusZip: 'http://travel.mob.cotralspa.it:7777/GTFS/GTFS_COTRAL.zip',
    gtfsRailZip: 'http://travel.mob.cotralspa.it:7777/GTFS/GTFS_FERRO.zip',
    /** Overridable only for tests (a local stub). */
    astralBase: env.ASTRAL_BASE_URL || 'https://gestionecorse.astralspa.it/api',
    atacGtfsZip: 'https://romamobilita.it/sites/default/files/rome_static_gtfs.zip',
    atacVehiclePositions: 'https://romamobilita.it/sites/default/files/rome_rtgtfs_vehicle_positions_feed.pb',
    atacTripUpdates: 'https://romamobilita.it/sites/default/files/rome_rtgtfs_trip_updates_feed.pb',
  },
  requestTimeoutMs: 15000,
  timezone: 'Europe/Rome',
} as const;

export function ensureDataDir(): string {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}
