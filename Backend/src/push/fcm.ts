import fs from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import type { PushPayload } from '../types.js';
import { errorSnippet, pushResult, type PushResult } from './result.js';
import { PUSH_TTL_SECONDS, SEND_TIMEOUT_MS } from './settings.js';

/**
 * Firebase Cloud Messaging, HTTP v1 API (Android).
 *
 * Auth: OAuth2 "JWT bearer" grant (RFC 7523) — a JWT signed RS256 with the service account's private key is
 * exchanged at its token_uri for an access token, cached until shortly before it expires.
 * Send: POST {base}/v1/projects/{project_id}/messages:send.
 */

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmOptions {
  serviceAccount: ServiceAccount;
  /** API origin (default https://fcm.googleapis.com). */
  baseUrl?: string;
  /** Token endpoint override (default: the service account's token_uri, else Google's). */
  tokenUrl?: string;
  timeoutMs?: number;
}

export function readServiceAccount(file: string): ServiceAccount {
  const sa = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServiceAccount>;
  if (typeof sa.project_id !== 'string' || typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
    throw new Error(`${file}: non è un service account Firebase (mancano project_id / client_email / private_key)`);
  }
  return sa as ServiceAccount;
}

export class FcmChannel {
  private readonly sa: ServiceAccount;
  private readonly baseUrl: string;
  private readonly tokenUrl: string;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(opts: FcmOptions) {
    this.sa = opts.serviceAccount;
    this.baseUrl = (opts.baseUrl || 'https://fcm.googleapis.com').replace(/\/+$/, '');
    this.tokenUrl = opts.tokenUrl || this.sa.token_uri || GOOGLE_TOKEN_URL;
    this.timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  get projectId(): string { return this.sa.project_id; }

  /** OAuth2 access token, cached until 60 s before expiry; concurrent callers share one token request. */
  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.pending ??= this.fetchToken().finally(() => { this.pending = null; });
    return this.pending;
  }

  /** Forget the cached token (after a 401). */
  invalidateToken(): void {
    this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const key = await importPKCS8(this.sa.private_key, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.sa.client_email)
      .setAudience(this.tokenUrl)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token OAuth2 rifiutato (HTTP ${res.status}): ${errorSnippet(text)}`);
    const d = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (typeof d.access_token !== 'string') throw new Error('token OAuth2: risposta senza access_token');
    const ttl = typeof d.expires_in === 'number' ? d.expires_in : 3600;
    this.token = { value: d.access_token, expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000 };
    return d.access_token;
  }

  /** The FCM v1 message for a payload (exported for tests/docs). */
  static message(token: string, p: PushPayload) {
    return {
      message: {
        token,
        notification: { title: p.title, body: p.body },
        data: { tag: p.tag, url: p.url },
        android: {
          priority: 'HIGH',
          ttl: `${PUSH_TTL_SECONDS}s`,
          // Same tag = the newer notification replaces the older one (as the Web Push `tag`).
          notification: { tag: p.tag },
        },
      },
    };
  }

  async send(token: string, payload: PushPayload): Promise<PushResult> {
    const first = await this.attempt(token, payload);
    if (first.status !== 401) return first;
    this.invalidateToken();
    return this.attempt(token, payload);
  }

  private async attempt(token: string, payload: PushPayload): Promise<PushResult> {
    let bearer: string;
    try {
      bearer = await this.accessToken();
    } catch (err) {
      return pushResult(0, (err as Error).name === 'TimeoutError' ? 'timeout (token OAuth2)' : (err as Error).message);
    }
    try {
      const res = await fetch(`${this.baseUrl}/v1/projects/${encodeURIComponent(this.sa.project_id)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(FcmChannel.message(token, payload)),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await res.text().catch(() => '');
      if (res.ok) return pushResult(res.status);
      let code = '';
      let message = '';
      try {
        const e = (JSON.parse(text) as { error?: { message?: string; status?: string; details?: { errorCode?: string }[] } }).error;
        code = e?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? e?.status ?? '';
        message = e?.message ?? '';
      } catch { /* not JSON */ }
      const gone = res.status === 404 || code === 'UNREGISTERED';
      return pushResult(res.status, errorSnippet([code, message].filter(Boolean).join(': ') || text), gone);
    } catch (err) {
      const e = err as Error;
      return pushResult(0, e.name === 'TimeoutError' ? 'timeout' : (e.cause as Error)?.message || e.message);
    }
  }
}
