import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { decodeProtectedHeader, importJWK, importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApnsChannel, APNS_PRODUCTION, APNS_SANDBOX } from '../src/push/apns.js';
import { FCM_SCOPE, FcmChannel } from '../src/push/fcm.js';
import { payloadJson, testPayload } from '../src/push/notifier.js';
import { resetVapidCache, vapidKeys, vapidPath } from '../src/push/vapid.js';
import { sendWebPush } from '../src/push/webpush.js';
import type { PushPayload } from '../src/types.js';
import { decryptAes128gcm, mkSubscription } from './push-helpers.js';

const payload: PushPayload = { title: 'Prossimo bus alle 07:45', body: 'Il prossimo bus per Città è in ritardo di 3 minuti.', tag: 'r1', url: './#/promemoria' };

interface Captured { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }

/** Local HTTP/1.1 server that records requests and answers with `respond`. */
async function httpServer(respond: (req: Captured, res: http.ServerResponse) => void) {
  const seen: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const c = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(c);
      respond(c, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madovai-push-channels-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ======================================================================= VAPID
describe('VAPID keys', () => {
  it('generated on first use, chmod 600, PHP-compatible format, stable', () => {
    const dir = path.join(tmp, 'vapid1');
    const k = vapidKeys(dir);
    const file = vapidPath(dir);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.keys(raw)).toEqual(['publicKey', 'privateKeyPem', 'createdAt']);
    expect(Buffer.from(k.publicKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(k.privateKey, 'base64url')).toHaveLength(32);
    resetVapidCache();
    expect(vapidKeys(dir)).toEqual(k);
  });

  it('loads a vapid.json written by Madovai-Web (SEC1 "EC PRIVATE KEY" PEM)', () => {
    const dir = path.join(tmp, 'vapid-php');
    fs.mkdirSync(dir);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
    fs.writeFileSync(vapidPath(dir), JSON.stringify({ publicKey: pub, privateKeyPem: privateKey.export({ format: 'pem', type: 'sec1' }), createdAt: '2026-01-01T00:00:00+00:00' }));
    expect(vapidKeys(dir).publicKey).toBe(pub);
  });
});

// ======================================================================= Web Push end to end
describe('Web Push channel (local receiver, independent decryptor)', () => {
  let receiver: Awaited<ReturnType<typeof httpServer>>;
  let nextStatus = 201;
  beforeAll(async () => {
    process.env.PUSH_ALLOW_INSECURE = '1';
    receiver = await httpServer((_c, res) => {
      if (nextStatus === 301) { res.writeHead(301, { Location: 'http://127.0.0.1:1/elsewhere' }); res.end(); return; }
      if (nextStatus === -1) return; // never answer (timeout)
      res.writeHead(nextStatus, { 'Content-Type': 'text/plain' });
      res.end(nextStatus >= 300 ? `  rejected with ${nextStatus}  ` : '');
    });
  });
  afterAll(async () => {
    delete process.env.PUSH_ALLOW_INSECURE;
    await receiver.close();
  });
  beforeEach(() => { nextStatus = 201; receiver.seen.length = 0; });

  it('encrypts (RFC 8291 aes128gcm) what the receiver can decrypt, with a valid VAPID JWT and the PHP headers', async () => {
    const keys = vapidKeys(path.join(tmp, 'vapid-wp'));
    for (const msg of [payloadJson(payload), payloadJson(testPayload()), 'a', 'é'.repeat(1500)]) {
      const { subscription, privateKey } = mkSubscription(`${receiver.base}/push/abc?x=1`);
      const r = await sendWebPush(subscription, msg, keys);
      expect(r).toEqual({ status: 201, ok: true, gone: false, error: '' });
      const req = receiver.seen.at(-1)!;
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/push/abc?x=1');
      const plain = decryptAes128gcm(req.body, privateKey, Buffer.from(subscription.keys.p256dh, 'base64url'), Buffer.from(subscription.keys.auth, 'base64url'));
      expect(plain).toBe(msg);
      expect(req.body.readUInt32BE(16)).toBe(4096);
      expect(req.body[20]).toBe(65);
      expect(req.headers['content-encoding']).toBe('aes128gcm');
      expect(req.headers['content-type']).toBe('application/octet-stream');
      expect(req.headers.ttl).toBe('600');
      expect(req.headers.urgency).toBe('high');
      const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(String(req.headers.authorization));
      expect(m).not.toBeNull();
      expect(m![2]).toBe(keys.publicKey);
      const raw = Buffer.from(keys.publicKey, 'base64url');
      const pubKey = await importJWK({ kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, 'ES256');
      const { payload: claims, protectedHeader } = await jwtVerify(m![1], pubKey, { audience: receiver.base });
      expect(protectedHeader.alg).toBe('ES256');
      expect(claims.sub).toBe(keys.subject);
      expect(claims.exp! - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
      expect(claims.exp! - Date.now() / 1000).toBeGreaterThan(3600);
    }
  });

  it('maps statuses: 404/410 gone, 5xx error with body snippet, redirects not followed, timeout = status 0', async () => {
    const keys = vapidKeys(path.join(tmp, 'vapid-wp'));
    const { subscription } = mkSubscription(`${receiver.base}/push/x`);
    nextStatus = 410;
    expect(await sendWebPush(subscription, 'x', keys)).toMatchObject({ status: 410, ok: false, gone: true });
    nextStatus = 404;
    expect(await sendWebPush(subscription, 'x', keys)).toMatchObject({ status: 404, gone: true });
    nextStatus = 500;
    expect(await sendWebPush(subscription, 'x', keys)).toEqual({ status: 500, ok: false, gone: false, error: 'rejected with 500' });
    nextStatus = 301;
    expect(await sendWebPush(subscription, 'x', keys)).toMatchObject({ status: 301, ok: false, gone: false });
    expect(receiver.seen).toHaveLength(4);
    nextStatus = -1;
    expect(await sendWebPush(subscription, 'x', keys, 300)).toEqual({ status: 0, ok: false, gone: false, error: 'timeout' });
  });

  it('refuses non-public endpoints outside test mode (no request made)', async () => {
    delete process.env.PUSH_ALLOW_INSECURE;
    try {
      const keys = vapidKeys(path.join(tmp, 'vapid-wp'));
      const before = receiver.seen.length;
      const { subscription } = mkSubscription(`${receiver.base}/push/x`);
      expect(await sendWebPush(subscription, 'x', keys)).toMatchObject({ status: 0, error: 'endpoint non consentito' });
      expect(receiver.seen.length).toBe(before);
    } finally {
      process.env.PUSH_ALLOW_INSECURE = '1';
    }
  });
});

// ======================================================================= FCM HTTP v1 (mock server)
describe('FCM channel (mock OAuth2 + FCM server, throwaway service account)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let server: Awaited<ReturnType<typeof httpServer>>;
  let tokenCalls = 0;
  let sendStatus: number | (() => number) = 200;
  let sendBody = '{"name":"projects/demo-project/messages/0:1"}';
  const sa = () => ({
    project_id: 'demo-project',
    client_email: 'madovai@demo-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    token_uri: `${server.base}/token`,
  });

  beforeAll(async () => {
    server = await httpServer((c, res) => {
      if (c.url === '/token') {
        tokenCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: `ya29.test-${tokenCalls}`, expires_in: 3599, token_type: 'Bearer' }));
        return;
      }
      const status = typeof sendStatus === 'function' ? sendStatus() : sendStatus;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200 ? sendBody : sendBody);
    });
  });
  afterAll(() => server.close());
  beforeEach(() => { server.seen.length = 0; tokenCalls = 0; sendStatus = 200; sendBody = '{"name":"projects/demo-project/messages/0:1"}'; });

  it('gets an OAuth2 token with an RS256 JWT grant, caches it, and posts the v1 message', async () => {
    const ch = new FcmChannel({ serviceAccount: sa(), baseUrl: server.base });
    const token = 'dXk3:APA91b' + 'x'.repeat(140);
    expect(await ch.send(token, payload)).toEqual({ status: 200, ok: true, gone: false, error: '' });
    expect(await ch.send(token, payload)).toMatchObject({ ok: true });
    expect(tokenCalls).toBe(1); // cached

    const tokReq = server.seen[0];
    expect(tokReq.url).toBe('/token');
    expect(tokReq.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(tokReq.body.toString());
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const spki = await importSPKI(publicKey.export({ format: 'pem', type: 'spki' }) as string, 'RS256');
    const { payload: claims, protectedHeader } = await jwtVerify(form.get('assertion')!, spki, {
      issuer: 'madovai@demo-project.iam.gserviceaccount.com', audience: `${server.base}/token`,
    });
    expect(protectedHeader).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims.scope).toBe(FCM_SCOPE);
    expect(claims.exp! - claims.iat!).toBe(3600);

    const sendReq = server.seen[1];
    expect(sendReq.method).toBe('POST');
    expect(sendReq.url).toBe('/v1/projects/demo-project/messages:send');
    expect(sendReq.headers.authorization).toBe('Bearer ya29.test-1');
    expect(JSON.parse(sendReq.body.toString())).toEqual({
      message: {
        token,
        notification: { title: payload.title, body: payload.body },
        data: { tag: 'r1', url: './#/promemoria' },
        android: { priority: 'HIGH', ttl: '600s', notification: { tag: 'r1' } },
      },
    });
  });

  it('UNREGISTERED / 404 = gone; INVALID_ARGUMENT is an error, not gone; 401 refreshes the token once', async () => {
    const ch = new FcmChannel({ serviceAccount: sa(), baseUrl: server.base });
    const token = 'a'.repeat(150);
    sendStatus = 404;
    sendBody = JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } });
    expect(await ch.send(token, payload)).toEqual({ status: 404, ok: false, gone: true, error: 'UNREGISTERED: Requested entity was not found.' });
    sendStatus = 400;
    sendBody = JSON.stringify({ error: { code: 400, message: 'The registration token is not a valid FCM registration token', status: 'INVALID_ARGUMENT', details: [{ errorCode: 'UNREGISTERED' }] } });
    expect(await ch.send(token, payload)).toMatchObject({ status: 400, gone: true });
    sendBody = JSON.stringify({ error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } });
    expect(await ch.send(token, payload)).toMatchObject({ status: 400, gone: false, error: 'INVALID_ARGUMENT: bad' });

    let n = 0;
    sendStatus = () => (++n === 1 ? 401 : 200);
    sendBody = '{}';
    const before = tokenCalls;
    expect(await ch.send(token, payload)).toMatchObject({ status: 200, ok: true });
    expect(tokenCalls).toBe(before + 1);
    expect(server.seen.at(-1)!.headers.authorization).toBe(`Bearer ya29.test-${tokenCalls}`);
  });

  it('token endpoint failure = status 0, nothing sent', async () => {
    const ch = new FcmChannel({ serviceAccount: { ...sa(), token_uri: `${server.base}/nope` }, baseUrl: 'http://127.0.0.1:1' });
    const r = await ch.send('a'.repeat(150), payload);
    expect(r.status).toBe(0);
    expect(r.ok).toBe(false);
  });
});

// ======================================================================= APNs (local h2c HTTP/2 server)
describe('APNs channel (local HTTP/2 server, throwaway P-256 key)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p8 = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  let server: http2.Http2Server;
  let base = '';
  const seen: { headers: http2.IncomingHttpHeaders; body: string }[] = [];
  let respond: (n: number) => [number, string] = () => [200, ''];

  beforeAll(async () => {
    server = http2.createServer();
    server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c) => (body += c));
      stream.on('end', () => {
        seen.push({ headers, body });
        const [status, json] = respond(seen.length);
        stream.respond({ ':status': status, 'apns-id': crypto.randomUUID(), ...(json ? { 'content-type': 'application/json' } : {}) });
        stream.end(json);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { seen.length = 0; respond = () => [200, '']; });

  const channel = () => new ApnsChannel({ key: p8, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'dev.gab8bit.madovai', host: base });
  const token = 'ab'.repeat(32);

  it('POSTs /3/device/<token> over HTTP/2 with an ES256 provider JWT and the APNs headers; JWT reused', async () => {
    const ch = channel();
    try {
      expect(await ch.send(token, 'sandbox', payload)).toEqual({ status: 200, ok: true, gone: false, error: '' });
      expect(await ch.send(token, 'production', payload)).toMatchObject({ ok: true });
      const h = seen[0].headers;
      expect(h[':method']).toBe('POST');
      expect(h[':path']).toBe(`/3/device/${token}`);
      expect(h['apns-topic']).toBe('dev.gab8bit.madovai');
      expect(h['apns-push-type']).toBe('alert');
      expect(h['apns-priority']).toBe('10');
      expect(Number(h['apns-expiration']) - Date.now() / 1000).toBeGreaterThan(590);
      expect(Number(h['apns-expiration']) - Date.now() / 1000).toBeLessThanOrEqual(600);
      expect(h['apns-collapse-id']).toBe('r1');
      const jwt = String(h.authorization).replace(/^bearer /, '');
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG' });
      const spki = await importSPKI(publicKey.export({ format: 'pem', type: 'spki' }) as string, 'ES256');
      const { payload: claims } = await jwtVerify(jwt, spki, { issuer: 'TEAM123456' });
      expect(Math.abs(claims.iat! - Date.now() / 1000)).toBeLessThan(5);
      expect(JSON.parse(seen[0].body)).toEqual({ aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' }, tag: 'r1', url: './#/promemoria' });
      expect(seen[1].headers.authorization).toBe(h.authorization); // provider token reused
    } finally {
      ch.close();
    }
  });

  it('410 / BadDeviceToken / Unregistered = gone; other errors are not; ExpiredProviderToken re-signs once', async () => {
    const ch = channel();
    try {
      respond = () => [410, JSON.stringify({ reason: 'Unregistered', timestamp: 1 })];
      expect(await ch.send(token, 'sandbox', payload)).toEqual({ status: 410, ok: false, gone: true, error: 'Unregistered' });
      respond = () => [400, JSON.stringify({ reason: 'BadDeviceToken' })];
      expect(await ch.send(token, 'sandbox', payload)).toMatchObject({ status: 400, gone: true, error: 'BadDeviceToken' });
      respond = () => [400, JSON.stringify({ reason: 'DeviceTokenNotForTopic' })];
      expect(await ch.send(token, 'sandbox', payload)).toMatchObject({ status: 400, gone: false });
      respond = () => [429, JSON.stringify({ reason: 'TooManyRequests' })];
      expect(await ch.send(token, 'sandbox', payload)).toMatchObject({ status: 429, gone: false, error: 'TooManyRequests' });
      seen.length = 0;
      respond = (n) => (n === 1 ? [403, JSON.stringify({ reason: 'ExpiredProviderToken' })] : [200, '']);
      expect(await ch.send(token, 'sandbox', payload)).toMatchObject({ status: 200, ok: true });
      expect(seen).toHaveLength(2);
      expect(seen[1].headers.authorization).not.toBe(seen[0].headers.authorization);
    } finally {
      ch.close();
    }
  });

  it('environment picks the Apple host; unreachable host = status 0', async () => {
    const ch = new ApnsChannel({ key: p8, keyId: 'K', teamId: 'T', topic: 'x' });
    expect(ch.origin('production')).toBe(APNS_PRODUCTION);
    expect(ch.origin('sandbox')).toBe(APNS_SANDBOX);
    expect(APNS_PRODUCTION).toBe('https://api.push.apple.com');
    expect(APNS_SANDBOX).toBe('https://api.sandbox.push.apple.com');
    const dead = new ApnsChannel({ key: p8, keyId: 'K', teamId: 'T', topic: 'x', host: 'http://127.0.0.1:1' });
    expect((await dead.send(token, 'sandbox', payload)).status).toBe(0);
    dead.close();
  });
});
