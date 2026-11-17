import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';

/**
 * A GTFS feed as a set of named text files read as streams — either an already extracted directory or a zip read
 * in place with yauzl (entries are inflated on the fly: nothing is ever extracted to disk and no file is ever held
 * whole in memory, so the 235 MB Atac stop_times.txt only exists as a stream). Port of src/Gtfs/FeedSource.php.
 */
export interface FeedSource {
  readonly label: string;
  has(file: string): boolean;
  /**
   * Calls `onLine` for every line of `file` (header included), without the trailing "\n" (a "\r" of CRLF files is
   * kept, like PHP's fgets keeps it). Returns false when the file is not part of the feed.
   */
  eachLine(file: string, onLine: (line: string) => void): Promise<boolean>;
  close(): void;
}

/** Splits a byte stream into UTF-8 lines with no per-line Buffer allocation. */
async function streamLines(stream: Readable, onLine: (line: string) => void): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  try {
    for await (const chunk of stream) {
      const s = carry + decoder.write(chunk as Buffer);
      let start = 0;
      let nl: number;
      while ((nl = s.indexOf('\n', start)) !== -1) {
        onLine(s.slice(start, nl));
        start = nl + 1;
      }
      carry = start === 0 ? s : s.slice(start);
    }
  } finally {
    stream.destroy();
  }
  carry += decoder.end();
  if (carry !== '') onLine(carry);
}

class DirFeed implements FeedSource {
  constructor(private readonly dir: string) {}
  get label() { return `dir:${this.dir}`; }
  has(file: string): boolean {
    try { return fs.statSync(path.join(this.dir, file)).isFile(); } catch { return false; }
  }
  async eachLine(file: string, onLine: (line: string) => void): Promise<boolean> {
    if (!this.has(file)) return false;
    await streamLines(fs.createReadStream(path.join(this.dir, file), { highWaterMark: 1 << 20 }), onLine);
    return true;
  }
  close(): void {}
}

class ZipFeed implements FeedSource {
  constructor(private readonly file: string, private readonly zip: yauzl.ZipFile, private readonly entries: Map<string, yauzl.Entry>) {}
  get label() { return `zip:${this.file}`; }
  has(file: string): boolean { return this.entries.has(file); }
  async eachLine(file: string, onLine: (line: string) => void): Promise<boolean> {
    const entry = this.entries.get(file);
    if (!entry) return false;
    const stream = await new Promise<Readable>((resolve, reject) => {
      this.zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s)));
    });
    await streamLines(stream, onLine);
    return true;
  }
  close(): void { this.zip.close(); }
}

export function feedFromDir(dir: string): FeedSource {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Cartella GTFS inesistente: ${dir}`);
  return new DirFeed(dir.replace(/\/+$/, ''));
}

/** Opens a zip and indexes its entries by basename (folders inside the zip are ignored, like the PHP version). */
export async function feedFromZip(file: string): Promise<FeedSource> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, z) => (err ? reject(new Error(`Zip non valido: ${file}: ${err.message}`)) : resolve(z)));
  });
  const entries = new Map<string, yauzl.Entry>();
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (e: yauzl.Entry) => {
      if (!e.fileName.endsWith('/')) entries.set(path.posix.basename(e.fileName), e);
      zip.readEntry();
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  return new ZipFeed(file, zip, entries);
}
