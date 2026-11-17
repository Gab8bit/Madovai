import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { gtfsReady, gtfsSchemaVersion, reopenGtfs } from '../db.js';
import { romeParts } from '../lib/rome.js';
import { SCHEMA_VERSION, type BuildStats } from './builder.js';
import { Store } from './store.js';
import type { BuildOptions } from './build.js';

/**
 * Background static-data jobs (what cron did for the PHP site): build madovai.sqlite at startup when it is missing
 * or was built with an older schema (meta.schema_version < SCHEMA_VERSION; the old file keeps serving meanwhile),
 * then every day at `config.gtfsRebuildAt` (Rome time "HH:MM"). The build runs in a worker thread so the API stays
 * responsive, writes a temp file and renames it into place (db.gtfs() reopens the new file by itself).
 */

/**
 * The worker next to this module: worker.js when compiled. From TypeScript sources (tsx watch, vitest) loader
 * hooks are not inherited by worker threads, so a tiny bootstrap registers tsx inside the worker first.
 */
function workerSpec(): { file: URL | string; eval: boolean } {
  const ext = path.extname(fileURLToPath(import.meta.url)) === '.ts' ? '.ts' : '.js';
  const file = new URL(`./worker${ext}`, import.meta.url);
  if (ext === '.js') return { file, eval: false };
  const tsxDir = path.dirname(createRequire(import.meta.url).resolve('tsx/package.json'));
  const api = pathToFileURL(path.join(tsxDir, 'dist/esm/api/index.mjs')).href;
  const code = `import(${JSON.stringify(api)}).then((m) => { m.register(); return import(${JSON.stringify(file.href)}); })`;
  return { file: code, eval: true };
}

type JobLog = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

let current: Promise<BuildStats> | null = null;
let currentWorker: Worker | null = null;

/** Runs one build in a worker thread; a call while a build is running joins that build. */
export function buildInWorker(log: JobLog, opts: Partial<Omit<BuildOptions, 'log'>> = {}): Promise<BuildStats> {
  if (current) return current;
  const spec = workerSpec();
  current = new Promise<BuildStats>((resolve, reject) => {
    const worker = new Worker(spec.file, {
      eval: spec.eval,
      workerData: { dataDir: config.dataDir, ...opts },
      // A small young generation keeps the build's RSS low (the live heap stays well under 100 MB).
      resourceLimits: { maxYoungGenerationSizeMb: 8, maxOldGenerationSizeMb: 256 },
    });
    currentWorker = worker;
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    worker.on('message', (m: { type: string; msg?: string; stats?: BuildStats; message?: string }) => {
      if (m.type === 'log') log.info({ gtfsBuild: true }, m.msg);
      else if (m.type === 'done') settle(() => resolve(m.stats!));
      else if (m.type === 'error') settle(() => reject(new Error(m.message)));
    });
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('exit', (code) => settle(() => reject(new Error(`worker GTFS terminato (codice ${code})`))));
  }).finally(() => {
    current = null;
    currentWorker = null;
  });
  return current;
}

function parseHHMM(s: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hour = +m[1];
  const minute = +m[2];
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** Builds the in-memory search index now rather than on the first /search (a few tens of ms). */
function warmSearch(log: JobLog): void {
  try {
    Store.open().warmSearch();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'search index not built');
  }
}

export function startGtfsJobs(log: FastifyBaseLogger): () => void {
  const run = (reason: string) => {
    if (current) {
      log.warn({ reason }, 'GTFS build already running, skipped');
      return;
    }
    log.info({ reason }, 'GTFS build started');
    buildInWorker(log)
      .then((stats) => {
        reopenGtfs();
        log.info({ stats }, 'GTFS build completed');
        warmSearch(log);
      })
      .catch((err: Error) => log.error({ err: err.message }, 'GTFS build failed'));
  };

  if (!gtfsReady()) run('database missing');
  else {
    if (gtfsSchemaVersion() < SCHEMA_VERSION) run('database schema outdated');
    setImmediate(() => warmSearch(log));
  }

  const at = config.gtfsRebuildAt ? parseHHMM(config.gtfsRebuildAt) : null;
  if (config.gtfsRebuildAt && !at) log.warn({ value: config.gtfsRebuildAt }, 'GTFS_REBUILD_AT is not "HH:MM": daily rebuild disabled');
  let lastRunYmd = 0;
  // A 20 s tick on Rome wall-clock time (DST-proof); runs at most once a day.
  const timer = at
    ? setInterval(() => {
        const now = romeParts();
        if (now.hour === at.hour && now.minute === at.minute && lastRunYmd !== now.ymd) {
          lastRunYmd = now.ymd;
          run('daily schedule');
        }
      }, 20_000)
    : null;
  timer?.unref();

  return () => {
    if (timer) clearInterval(timer);
    void currentWorker?.terminate();
  };
}
