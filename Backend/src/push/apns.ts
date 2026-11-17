import fs from 'node:fs';
import http2 from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { PushPayload } from '../types.js';
import { errorSnippet, pushResult, type PushResult } from './result.js';
import { PUSH_TTL_SECONDS, SEND_TIMEOUT_MS } from './settings.js';

/**
 * Apple Push Notification service (iOS), token-based auth over HTTP/2 (node:http2).
 *
 * Provider token: ES256 JWT {iss: teamId, iat} with header kid = keyId, signed with the .p8 key; Apple wants it
 * reused for 20-60 minutes, we refresh every 50. One HTTP/2 session per host is kept open and reused.
 * Needs the paid Apple Developer Program (for the key) — until configured the channel stays off.
 */

export const APNS_PRODUCTION = 'https://api.push.apple.com';
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

export interface ApnsOptions {
  /** Contents of the AuthKey_XXXX.p8 file (PKCS#8 PEM). */
  key: string;
  keyId: string;
  teamId: string;
  /** App bundle id. */
  topic: string;
  /** Origin override for both environments (tests: an h2c http:// server). */
  host?: string;
  timeoutMs?: number;
}

/**
 * Reasons that mean "this token will never work again": drop the device. (Not DeviceTokenNotForTopic: that is a
 * server misconfiguration — wrong APNS_TOPIC — and must not wipe every iOS device.)
 */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered']);

export class ApnsChannel {
  private readonly opts: ApnsOptions;
  private readonly timeoutMs: number;
  private jwt: { value: string; at: number } | null = null;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();

  constructor(opts: ApnsOptions) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  static fromFile(file: string, o: Omit<ApnsOptions, 'key'>): ApnsChannel {
    return new ApnsChannel({ ...o, key: fs.readFileSync(file, 'utf8') });
  }

  get topic(): string { return this.opts.topic; }

  origin(environment: 'sandbox' | 'production'): string {
    return this.opts.host || (environment === 'production' ? APNS_PRODUCTION : APNS_SANDBOX);
  }

  /** Provider authentication token, re-signed every 50 minutes (or on demand after ExpiredProviderToken). */
  async providerToken(force = false): Promise<string> {
    if (!force && this.jwt && Date.now() - this.jwt.at < TOKEN_REFRESH_MS) return this.jwt.value;
    const key = await importPKCS8(this.opts.key, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.opts.keyId })
      .setIssuer(this.opts.teamId)
      .setIssuedAt()
      .sign(key);
    this.jwt = { value, at: Date.now() };
    return value;
  }

  /** The APNs JSON body for a payload (exported for tests/docs). */
  static body(p: PushPayload) {
    return { aps: { alert: { title: p.title, body: p.body }, sound: 'default' }, tag: p.tag, url: p.url };
  }

  private session(origin: string): http2.ClientHttp2Session {
    const s = this.sessions.get(origin);
    if (s && !s.closed && !s.destroyed) return s;
    const session = http2.connect(origin);
    const drop = () => { if (this.sessions.get(origin) === session) this.sessions.delete(origin); };
    session.on('error', drop);
    session.on('goaway', drop);
    session.on('close', drop);
    // Idle connections are closed after 10 minutes and reopened on demand; never keep the process alive.
    session.setTimeout(10 * 60 * 1000, () => session.close());
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  async send(token: string, environment: 'sandbox' | 'production', payload: PushPayload): Promise<PushResult> {
    const first = await this.attempt(token, environment, payload, false);
    if (first.status === 403 && first.error.startsWith('ExpiredProviderToken')) return this.attempt(token, environment, payload, true);
    return first;
  }

  private async attempt(token: string, environment: 'sandbox' | 'production', payload: PushPayload, freshJwt: boolean): Promise<PushResult> {
    let jwt: string;
    try {
      jwt = await this.providerToken(freshJwt);
    } catch (err) {
      return pushResult(0, `chiave APNs non valida: ${(err as Error).message}`);
    }
    const origin = this.origin(environment);
    const body = JSON.stringify(ApnsChannel.body(payload));
    return new Promise<PushResult>((resolve) => {
      let settled = false;
      const done = (r: PushResult) => { if (!settled) { settled = true; resolve(r); } };
      let req: http2.ClientHttp2Stream;
      try {
        req = this.session(origin).request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': this.opts.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + PUSH_TTL_SECONDS),
          // Same tag = the newer notification replaces the older one (max 64 bytes; reminder ids are <= 64 chars).
          'apns-collapse-id': payload.tag,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        });
      } catch (err) {
        done(pushResult(0, (err as Error).message));
        return;
      }
      req.setTimeout(this.timeoutMs, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        done(pushResult(0, 'timeout'));
      });
      let status = 0;
      let data = '';
      req.setEncoding('utf8');
      req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
      req.on('data', (chunk: string) => { data += chunk; });
      req.on('end', () => {
        if (status >= 200 && status < 300) return done(pushResult(status));
        let reason = '';
        try { reason = (JSON.parse(data) as { reason?: string }).reason ?? ''; } catch { /* empty body */ }
        done(pushResult(status, errorSnippet(reason || data), status === 410 || GONE_REASONS.has(reason)));
      });
      req.on('error', (err) => done(pushResult(0, err.message)));
      req.end(body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
