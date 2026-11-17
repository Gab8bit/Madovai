import { config } from '../config.js';
import { UpstreamError } from './errors.js';

const UA = 'MadovaiBackend/1.0';

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
// Note: a custom TLS trust (ASTRAL's incomplete chain) needs undici's own fetch + Agent — Node's global fetch rejects
// an Agent from the npm undici package (different bundled version). See src/live/astral.ts.

async function request(url: string, opts: FetchOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body,
      headers: { 'User-Agent': UA, ...(opts.headers ?? {}) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? config.requestTimeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    const e = err as Error;
    throw new UpstreamError(e.name === 'TimeoutError' ? 'timeout' : (e.cause as Error)?.message || e.message);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`HTTP ${res.status}`, res.status);
  }
  return res;
}

export async function fetchText(url: string, opts?: FetchOptions): Promise<string> {
  return (await request(url, opts)).text();
}

export async function fetchBuffer(url: string, opts?: FetchOptions): Promise<Buffer> {
  return Buffer.from(await (await request(url, opts)).arrayBuffer());
}

export async function postJson<T = unknown>(url: string, body: unknown, opts: Omit<FetchOptions, 'method' | 'body'> = {}): Promise<T> {
  const res = await request(url, {
    ...opts,
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  return (await res.json()) as T;
}

/** Streams a (large) download straight to a file; never buffered in memory. */
export async function downloadToFile(url: string, file: string, timeoutMs = 600_000): Promise<number> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { Readable } = await import('node:stream');
  const res = await request(url, { timeoutMs });
  if (!res.body) throw new UpstreamError('risposta vuota');
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(file));
  const { statSync } = await import('node:fs');
  return statSync(file).size;
}
