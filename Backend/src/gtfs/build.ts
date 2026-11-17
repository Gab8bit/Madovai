import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { downloadToFile } from '../lib/http.js';
import { Builder, type BuildStats, type Feeds, type Logger } from './builder.js';
import { feedFromDir, feedFromZip, type FeedSource } from './feed.js';

/**
 * One complete static-data build (port of bin/build-data.php): get the three feeds (download, or local zips / an
 * extracted folder), build into a temp file, atomically rename it to DATA_DIR/madovai.sqlite. A lock file makes
 * sure two builds (nightly job, CLI) never overlap. Used by the CLI and by the background worker thread.
 */
export interface BuildOptions {
  dataDir: string;
  /** Folder with bus/ rail/ atac/ subfolders already extracted. */
  fromDir?: string;
  /** Folder with cotral_bus.zip, cotral_rail.zip, atac.zip already downloaded. */
  fromZips?: string;
  log?: Logger;
}

export class BuildLockedError extends Error {
  constructor() { super("Un'altra build è già in corso."); }
}

const LOCK_STALE_MS = 3 * 3600_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Exclusive lock: a file holding the owner's pid. A lock left by a dead process (or older than 3 h) is taken over. */
export function acquireBuildLock(dataDir: string): () => void {
  const file = path.join(dataDir, 'build.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = true;
      try {
        const pid = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        const age = Date.now() - fs.statSync(file).mtimeMs;
        // Our own pid = a leftover of a crashed earlier run of this process image (in Docker the pid is often
        // always 1); overlapping builds inside one process are prevented by startGtfsJobs.
        stale = !(pid > 0) || pid === process.pid || !pidAlive(pid) || age > LOCK_STALE_MS;
      } catch { /* vanished meanwhile: retry */ }
      if (!stale) throw new BuildLockedError();
      fs.rmSync(file, { force: true });
    }
  }
  throw new BuildLockedError();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBuild(opts: BuildOptions): Promise<BuildStats> {
  const say: Logger = opts.log ?? ((m) => process.stderr.write(m + '\n'));
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const finalPath = path.join(opts.dataDir, 'madovai.sqlite');
  const release = acquireBuildLock(opts.dataDir);
  // We hold the lock: leftovers of an interrupted build (killed process / terminated worker) can go.
  for (const name of fs.readdirSync(opts.dataDir)) {
    if (name.startsWith('madovai.sqlite.tmp-') || name.startsWith('build-tmp-')) {
      fs.rmSync(path.join(opts.dataDir, name), { recursive: true, force: true });
    }
  }
  let tmpDir: string | null = null;
  const opened: FeedSource[] = [];
  try {
    const info: Record<string, string> = {};
    let feeds: Feeds;
    if (opts.fromDir) {
      const dir = opts.fromDir.replace(/\/+$/, '');
      feeds = { bus: feedFromDir(`${dir}/bus`), rail: feedFromDir(`${dir}/rail`), atac: feedFromDir(`${dir}/atac`) };
      info.source = `dir:${dir}`;
    } else {
      let zips: Record<keyof Feeds, string>;
      if (opts.fromZips) {
        const d = opts.fromZips.replace(/\/+$/, '');
        zips = { bus: `${d}/cotral_bus.zip`, rail: `${d}/cotral_rail.zip`, atac: `${d}/atac.zip` };
        info.source = `zips:${d}`;
      } else {
        tmpDir = path.join(opts.dataDir, `build-tmp-${process.pid}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        const urls: Record<keyof Feeds, string> = {
          bus: config.upstream.gtfsBusZip,
          rail: config.upstream.gtfsRailZip,
          atac: config.upstream.atacGtfsZip,
        };
        zips = { bus: '', rail: '', atac: '' };
        for (const k of ['bus', 'rail', 'atac'] as const) {
          const dest = `${tmpDir}/${k}.zip`;
          say(`download ${k}: ${urls[k]}`);
          const t = performance.now();
          for (let attempt = 1; ; attempt++) {
            try {
              await downloadToFile(urls[k], dest);
              break;
            } catch (err) {
              if (attempt >= 3) throw err;
              say(`  tentativo ${attempt} fallito: ${(err as Error).message}`);
              await sleep(5000);
            }
          }
          say(`  ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB in ${((performance.now() - t) / 1000).toFixed(1)}s`);
          zips[k] = dest;
          info[`url_${k}`] = urls[k];
        }
      }
      feeds = { bus: await feedFromZip(zips.bus), rail: await feedFromZip(zips.rail), atac: await feedFromZip(zips.atac) };
    }
    opened.push(feeds.bus, feeds.rail, feeds.atac);
    return await new Builder(say).build(feeds, finalPath, info);
  } finally {
    for (const f of opened) {
      try { f.close(); } catch { /* ignore */ }
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    release();
  }
}
