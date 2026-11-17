/**
 * Builds DATA_DIR/madovai.sqlite (static GTFS: Cotral bus + rail, Rome/Atac) — port of Madovai-Web's
 * bin/build-data.php. The server already does this by itself (at startup when missing, then daily); the CLI is for
 * manual runs and tests:
 *
 *   node dist/cli/build-data.js [--data-dir=DIR] [--from-dir=DIR | --from-zips=DIR] [--quiet]
 *
 *   --data-dir=DIR   where to write madovai.sqlite (default: DATA_DIR or <root>/data)
 *   --from-dir=DIR   use already extracted feeds in DIR/bus, DIR/rail, DIR/atac (no download)
 *   --from-zips=DIR  use DIR/cotral_bus.zip, DIR/cotral_rail.zip, DIR/atac.zip (no download)
 *   --quiet          no progress output
 *
 * The new DB is built in a temp file next to the final one and renamed into place atomically, so a failed build
 * never breaks the running server (which reopens the new file by itself).
 */
const opts: Record<string, string | true> = {};
for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (!m || !['data-dir', 'from-dir', 'from-zips', 'quiet', 'help'].includes(m[1])) {
    process.stderr.write(`Opzione sconosciuta: ${arg}\n`);
    process.exit(2);
  }
  opts[m[1]] = m[2] ?? true;
}
if (opts.help) {
  process.stdout.write('Uso: node dist/cli/build-data.js [--data-dir=DIR] [--from-dir=DIR | --from-zips=DIR] [--quiet]\n');
  process.exit(0);
}
const str = (k: string): string | undefined => (typeof opts[k] === 'string' && opts[k] !== '' ? (opts[k] as string) : undefined);
// config.ts reads DATA_DIR when first imported: set it before loading anything else.
if (str('data-dir')) process.env.DATA_DIR = str('data-dir');

const { config } = await import('../config.js');
const { runBuild } = await import('../gtfs/build.js');

const quiet = opts.quiet === true;
const say = (m: string) => { if (!quiet) process.stderr.write(m + '\n'); };
const finalPath = `${config.dataDir}/madovai.sqlite`;

try {
  const stats = await runBuild({
    dataDir: config.dataDir,
    fromDir: str('from-dir'),
    fromZips: str('from-zips'),
    log: say,
  });
  say('');
  say(`OK ${finalPath}`);
  for (const [k, v] of Object.entries(stats)) {
    say(`  ${k.padEnd(22)} ${typeof v === 'number' && k.endsWith('_bytes') ? (v / 1048576).toFixed(1) + ' MB' : v}`);
  }
  process.exit(0);
} catch (err) {
  const e = err as Error;
  process.stderr.write(`ERRORE: ${e.message}\n${quiet ? '' : (e.stack ?? '') + '\n'}`);
  process.exit(1);
}
