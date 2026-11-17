import { buildApp } from './app.js';
import { config, ensureDataDir } from './config.js';
import { closeAll } from './db.js';
import { startGtfsJobs } from './gtfs/jobs.js';
import { startReminderScheduler } from './push/scheduler.js';

/**
 * Entry point: HTTP API + the background jobs that the PHP version ran from cron
 * (nightly GTFS rebuild in a worker thread, per-minute reminder scheduler).
 */
async function main(): Promise<void> {
  ensureDataDir();
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  const stopGtfs = startGtfsJobs(app.log);
  const stopReminders = config.remindersEnabled ? startReminderScheduler(app.log) : () => {};

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopGtfs();
    stopReminders();
    await app.close();
    closeAll();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
