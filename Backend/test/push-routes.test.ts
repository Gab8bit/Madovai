import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { romeParts } from '../src/lib/rome.js';
import { decryptAes128gcm, mkSubscription } from './push-helpers.js';

// ---- local push services, then env, then the app (config is read at import time) ----
interface Captured { url: string; headers: http.IncomingHttpHeaders; body: Buffer }
const received: Captured[] = [];
let receiverStatus = 201;
const receiver = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'ya29.routes', expires_in: 3600 }));
    } else {
      res.writeHead(receiverStatus, { 'Content-Type': 'application/json' });
      res.end(receiverStatus < 300 ? '{}' : '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}');
    }
  });
});
await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madovai-push-routes-'));
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(path.join(tmp, 'sa.json'), JSON.stringify({
  type: 'service_account', project_id: 'demo-project', client_email: 'sa@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }), token_uri: `${base}/token`,
}));
Object.assign(process.env, {
  DATA_DIR: tmp, PUSH_ALLOW_INSECURE: '1', FCM_SERVICE_ACCOUNT_FILE: path.join(tmp, 'sa.json'), FCM_BASE_URL: base,
  APNS_KEY_FILE: '', RATE_LIMIT_PER_MINUTE: '100000', REMINDERS_ENABLED: '0',
});

const { buildApp } = await import('../src/app.js');
const { getStore, ReminderStore } = await import('../src/push/store.js');
const { runOnce, startReminderScheduler } = await import('../src/push/scheduler.js');
const { closeAll } = await import('../src/db.js');
const app = await buildApp({ logger: false });

afterAll(async () => {
  await app.close();
  closeAll();
  await new Promise<void>((r) => receiver.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => { received.length = 0; receiverStatus = 201; });

const goodRem = { id: 'r1', stopName: 'Acilia', weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 30, source: { type: 'cotralBus', poleCode: '1021' } };
const fcmToken = 'fcmTok:APA91b' + 'Z'.repeat(140);
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
const devCount = () => getStore().db.prepare('SELECT COUNT(*) FROM devices').pluck().get();

describe('GET push config', () => {
  it('v1 reports the channels', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/push/config' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(Object.keys(j)).toEqual(['webPush', 'fcm', 'apns']);
    expect(Buffer.from(j.webPush.publicKey, 'base64url')).toHaveLength(65);
    expect(j.fcm).toEqual({ enabled: true });
    expect(j.apns).toEqual({ enabled: false, topic: null });
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(fs.existsSync(path.join(tmp, 'vapid.json'))).toBe(true);
  });

  it('legacy push-key.php returns exactly the PHP shape', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/push-key.php' });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json())).toEqual(['publicKey']);
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('POST reminders / DELETE devices', () => {
  it('v1 webpush + fcm devices, state stored', async () => {
    const { subscription } = mkSubscription(`${base}/wp/1`);
    let r = await post('/api/v1/reminders', { device: { type: 'webpush', subscription }, reminders: [goodRem] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, count: 1 });
    expect(r.headers['cache-control']).toBe('no-store');
    r = await post('/api/v1/reminders', { device: { type: 'fcm', token: fcmToken }, reminders: [goodRem, { ...goodRem, id: 'r2' }] });
    expect(r.json()).toEqual({ ok: true, count: 2 });
    const id = ReminderStore.deviceId({ type: 'fcm', token: fcmToken });
    expect(getStore().reminderRows(id).map((x) => x.id)).toEqual(['r1', 'r2']);
    r = await app.inject({ method: 'DELETE', url: '/api/v1/devices', payload: { device: { type: 'fcm', token: fcmToken } } });
    expect(r.json()).toEqual({ ok: true });
    expect(getStore().device(id)).toBeNull();
    r = await app.inject({ method: 'DELETE', url: '/api/v1/devices', payload: { device: { type: 'webpush', subscription: { endpoint: subscription.endpoint } } } });
    expect(r.json()).toEqual({ ok: true });
    expect(devCount()).toBe(0);
  });

  it('legacy reminders.php (subscription) and ?action=unsubscribe', async () => {
    const { subscription } = mkSubscription(`${base}/wp/legacy`);
    let r = await post('/api/reminders.php', { subscription: { ...subscription, expirationTime: null }, reminders: [goodRem] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, count: 1 });
    expect(devCount()).toBe(1);
    r = await post('/api/reminders.php?action=unsubscribe', { subscription: { endpoint: subscription.endpoint } });
    expect(r.json()).toEqual({ ok: true });
    expect(devCount()).toBe(0);
  });

  it('400s with the PHP messages (no type coercion), 503 for an unconfigured channel', async () => {
    const { subscription } = mkSubscription(`${base}/wp/2`);
    const device = { type: 'webpush', subscription };
    const cases: [unknown, string][] = [
      [{ device, reminders: [{ ...goodRem, hour: '7' }] }, 'hour deve essere 0-23'],
      [{ device }, 'reminders mancante'],
      [{ reminders: [] }, 'device mancante'],
      [{ device: { type: 'fcm', token: 'short' }, reminders: [] }, 'device.token non valido'],
      [{ device, reminders: [goodRem, goodRem] }, 'id promemoria duplicato'],
      [[1, 2], 'device mancante'],
    ];
    for (const [body, msg] of cases) {
      const r = await post('/api/v1/reminders', body);
      expect(r.statusCode, msg).toBe(400);
      expect(r.json()).toEqual({ error: msg });
    }
    let r = await app.inject({ method: 'POST', url: '/api/v1/reminders', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect([r.statusCode, r.json()]).toEqual([400, { error: 'Corpo JSON non valido' }]);
    r = await post('/api/reminders.php', { subscription: { endpoint: 'ftp://x.y/z' }, reminders: [] });
    expect([r.statusCode, r.json()]).toEqual([400, { error: 'endpoint non valido' }]);
    r = await post('/api/v1/reminders', { device: { type: 'apns', token: 'ab'.repeat(32), environment: 'sandbox' }, reminders: [goodRem] });
    expect([r.statusCode, r.json()]).toEqual([503, { error: 'Notifiche iOS (APNs) non configurate sul server' }]);
    expect(devCount()).toBe(0);
  });
});

describe('POST push/test', () => {
  it('webpush: delivers the test notification (decryptable), then 429 + Retry-After', async () => {
    const { subscription, privateKey: uaPriv } = mkSubscription(`${base}/wp/test`);
    let r = await post('/api/v1/push/test', { device: { type: 'webpush', subscription } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, status: 201 });
    const msg = received.find((x) => x.url === '/wp/test')!;
    const plain = decryptAes128gcm(msg.body, uaPriv, Buffer.from(subscription.keys.p256dh, 'base64url'), Buffer.from(subscription.keys.auth, 'base64url'));
    expect(JSON.parse(plain)).toEqual({ title: 'Notifiche attive', body: 'I promemoria di Madovai ti avviseranno su questo dispositivo.', tag: 'madovai-test', url: './#/promemoria' });
    r = await post('/api/push-test.php', { subscription });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ error: expect.stringMatching(/^Attendi \d+ secondi prima di un nuovo test$/), retryAfter: expect.any(Number) });
    expect(Number(r.headers['retry-after'])).toBe(r.json().retryAfter);
  });

  it('gone subscription is deleted; fcm device goes through the FCM mock', async () => {
    const { subscription } = mkSubscription(`${base}/wp/gone`);
    receiverStatus = 410;
    let r = await post('/api/push-test.php', { subscription });
    expect(r.json()).toEqual({ ok: false, gone: true, status: 410, error: 'Sottoscrizione non più valida: riattiva le notifiche' });
    expect(getStore().device(ReminderStore.deviceId({ type: 'webpush', subscription }))).toBeNull();

    receiverStatus = 200;
    r = await post('/api/v1/push/test', { device: { type: 'fcm', token: fcmToken } });
    expect(r.json()).toEqual({ ok: true, status: 200 });
    const send = received.find((x) => x.url === '/v1/projects/demo-project/messages:send')!;
    expect(send.headers.authorization).toBe('Bearer ya29.routes');
    expect(JSON.parse(send.body.toString()).message.notification.title).toBe('Notifiche attive');

    receiverStatus = 404;
    const other = 'fcmOther:APA91b' + 'Q'.repeat(140);
    r = await post('/api/v1/push/test', { device: { type: 'fcm', token: other } });
    expect(r.json()).toMatchObject({ ok: false, gone: true, status: 404 });
    expect(getStore().device(ReminderStore.deviceId({ type: 'fcm', token: other }))).toBeNull();
  });
});

describe('scheduler', () => {
  const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return this; }, level: 'silent', silent() {} } as never;

  it('runOnce: a reminder saved for the current minute is pushed end to end (fetch injected)', async () => {
    const now = new Date();
    const p = romeParts(now);
    const { subscription, privateKey: uaPriv } = mkSubscription(`${base}/wp/sched`);
    const r = await post('/api/v1/reminders', { device: { type: 'webpush', subscription }, reminders: [{ ...goodRem, id: 'now', hour: p.hour, minute: p.minute }] });
    expect(r.json()).toEqual({ ok: true, count: 1 });
    const fetch = vi.fn(async () => ({ time: '12:34', delayMinutes: 3, isCancelled: false, nextUsefulTime: null }));
    await runOnce(silent, now, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const msg = received.find((x) => x.url === '/wp/sched')!;
    const plain = JSON.parse(decryptAes128gcm(msg.body, uaPriv, Buffer.from(subscription.keys.p256dh, 'base64url'), Buffer.from(subscription.keys.auth, 'base64url')));
    expect(plain).toEqual({ title: 'Prossimo bus alle 12:34', body: 'Il prossimo bus per Acilia è in ritardo di 3 minuti.', tag: 'now', url: './#/promemoria' });
    await runOnce(silent, now, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1); // done for today
  });

  it('runOnce without an injected fetch: missing live module = no data = retry policy (no push)', async () => {
    const now = new Date();
    const p = romeParts(now);
    const { subscription } = mkSubscription(`${base}/wp/nolive`);
    await post('/api/v1/reminders', { device: { type: 'webpush', subscription }, reminders: [{ ...goodRem, id: 'nl', hour: p.hour, minute: p.minute }] });
    const sender = vi.fn();
    await runOnce(silent, now, { sender, fetch: async () => null });
    expect(sender).not.toHaveBeenCalled();
    const row = getStore().reminderRows(ReminderStore.deviceId({ type: 'webpush', subscription }))[0];
    expect(row.retry_count).toBe(1);
  });

  it('ticks aligned to :00 every minute and never overlaps', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-05T05:29:30.000Z') });
    try {
      const calls: number[] = [];
      let release: () => void = () => {};
      const fakeStore = {
        candidates: () => { calls.push(Date.now()); return [{ deviceId: 'd', id: 'x', json: '{}', reminder: { id: 'x', stopName: 'A', weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 7, minute: 30, source: { type: 'cotralBus', poleCode: '1' } }, lastDoneDate: 0, retryCount: 0, retryAt: 0, retryDate: 0, device: { type: 'fcm', token: 'x' } }]; },
        pruneStale: () => 0, touchOk() {}, markDone() {}, markRetry() {}, deleteDevice() {},
      };
      // The first run's status fetch hangs for ~2.5 minutes: the next two ticks must be skipped.
      const fetch = () => new Promise<null>((r) => { release = () => r(null); });
      const stop = startReminderScheduler(silent, { store: () => fakeStore as never, fetch, sender: async () => ({ status: 201, ok: true, gone: false, error: '' }) });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_300); // 07:30:00.250 Rome
      expect(calls).toEqual([Date.parse('2026-10-05T05:30:00.250Z')]);
      await vi.advanceTimersByTimeAsync(120_000); // ticks at 07:31 and 07:32 skipped (still running)
      expect(calls).toHaveLength(1);
      release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toEqual([Date.parse('2026-10-05T05:30:00.250Z'), Date.parse('2026-10-05T05:33:00.250Z')]);
      stop();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpenAPI', () => {
  it('documents the v1 push routes (tagged push), hides the legacy aliases', async () => {
    const r = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    for (const [p, m] of [['/api/v1/push/config', 'get'], ['/api/v1/reminders', 'post'], ['/api/v1/devices', 'delete'], ['/api/v1/push/test', 'post']]) {
      expect(doc.paths[p]?.[m]?.tags, `${m} ${p}`).toEqual(['push']);
    }
    expect(Object.keys(doc.paths).filter((p) => p.endsWith('.php'))).toEqual([]);
    expect(doc.paths['/api/v1/reminders'].post.requestBody.content['application/json'].schema.properties.device.oneOf).toHaveLength(3);
  });
});
