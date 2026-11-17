import { parentPort, workerData } from 'node:worker_threads';
import { runBuild, type BuildOptions } from './build.js';

/**
 * Worker-thread entry point of the background GTFS build (see jobs.ts): the heavy parsing/inserting runs here so
 * the HTTP server's event loop stays responsive. Messages to the parent: {type:'log'|'done'|'error'}.
 */
const opts = workerData as Omit<BuildOptions, 'log'>;
const port = parentPort!;

try {
  const stats = await runBuild({ ...opts, log: (msg) => port.postMessage({ type: 'log', msg }) });
  port.postMessage({ type: 'done', stats });
} catch (err) {
  const e = err as Error;
  port.postMessage({ type: 'error', message: e.message, locked: e.name === 'BuildLockedError' || /già in corso/.test(e.message) });
}
