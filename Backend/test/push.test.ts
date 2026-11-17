import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequest, NotReady } from '../src/lib/errors.js';
import { DIRECTION_LABELS, payloadJson, reminderPayload, testPayload } from '../src/push/notifier.js';
import { isDue, ReminderRunner } from '../src/push/runner.js';
import { MAX_DEVICES, ReminderStore } from '../src/push/store.js';
import {
  endpointError, isNonPublicIp, validateDevice, validateReminder, validateReminders, validateSource, validateSubscription,
} from '../src/push/validation.js';
import type { DepartureStatus, Reminder } from '../src/types.js';
import { FakeSender, mkDevice, mkRem, plusMinutes, rome, unix } from './push-helpers.js';

const st = (time: string, delayMinutes: number | null, isCancelled = false, nextUsefulTime: string | null = null): DepartureStatus =>
  ({ time, delayMinutes, isCancelled, nextUsefulTime });

// ======================================================================= notifier (test_notifier.php)
describe('notifier texts', () => {
  const bus = mkRem('abc', [2], 7, 30);
  const atac: Reminder = { ...bus, stopName: 'Termini', source: { type: 'atacStop', stopId: '05000' } };
  const train: Reminder = { ...bus, source: { type: 'cotralTrain', stationName: 'Acilia', route: 'RL_PSP-CC' } };

  it('bus texts', () => {
    const p = reminderPayload(bus, st('07:45', 0));
    expect(p.title).toBe('Prossimo bus alle 07:45');
    expect(p.body).toBe('Il prossimo bus per Acilia non fa ritardo.');
    expect(p.tag).toBe('abc');
    expect(p.url).toBe('./#/promemoria');
    expect(reminderPayload(bus, st('07:45', null)).body).toBe('Il prossimo bus per Acilia non fa ritardo.');
    expect(reminderPayload(bus, st('07:45', -3)).body).toBe('Il prossimo bus per Acilia non fa ritardo.');
    expect(reminderPayload(bus, st('07:45', 1)).body).toBe('Il prossimo bus per Acilia è in ritardo di 1 minuto.');
    expect(reminderPayload(bus, st('07:45', 7)).body).toBe('Il prossimo bus per Acilia è in ritardo di 7 minuti.');
    expect(reminderPayload(bus, st('07:45', null, true, '08:05')).body).toBe('Il prossimo bus per Acilia è stato soppresso. Prossimo utile: 08:05.');
    expect(reminderPayload(bus, st('07:45', null, true, null)).body).toBe("Il prossimo bus per Acilia è stato soppresso. Nessun'altra corsa in programma.");
    expect(reminderPayload(bus, st('07:45', null, true, '')).body).toBe("Il prossimo bus per Acilia è stato soppresso. Nessun'altra corsa in programma.");
  });

  it('atac stop is a bus, train has the direction', () => {
    expect(reminderPayload(atac, st('07:45', 2)).title).toBe('Prossimo bus alle 07:45');
    const tp = reminderPayload(train, st('07:50', 4));
    expect(tp.title).toBe('Prossimo treno alle 07:50');
    expect(tp.body).toBe('Il prossimo treno per Acilia, direzione Porta San Paolo → Cristoforo Colombo è in ritardo di 4 minuti.');
    expect(reminderPayload(train, st('07:50', null, true)).body)
      .toBe("Il prossimo treno per Acilia, direzione Porta San Paolo → Cristoforo Colombo è stato soppresso. Nessun'altra corsa in programma.");
    const json = payloadJson(tp);
    expect(Buffer.byteLength(json)).toBeLessThan(1000);
    expect(JSON.parse(json)).toEqual(tp);
    expect(json).toContain('→');
    expect(Object.keys(JSON.parse(json))).toEqual(['title', 'body', 'tag', 'url']);
    expect(Object.keys(DIRECTION_LABELS)).toHaveLength(8);
  });

  it('test payload', () => {
    expect(testPayload()).toEqual({ title: 'Notifiche attive', body: 'I promemoria di Madovai ti avviseranno su questo dispositivo.', tag: 'madovai-test', url: './#/promemoria' });
  });
});

// ======================================================================= validation (test_validation.php)
describe('validation', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const goodSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: pub.toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const goodRem = { id: '3F2504E0-4F89-41D3-9A0C-0305E82C3301', stopName: 'Acilia', weekdays: [2, 3, 4], hour: 7, minute: 30, source: { type: 'cotralBus', poleCode: '1021' } };
  const offCurve = Buffer.from(pub);
  offCurve[64] ^= 1;
  const bad = (f: () => unknown) => expect(f).toThrow(BadRequest);

  it('subscription', () => {
    expect(validateSubscription(goodSub)).toEqual(goodSub);
    const cases: Record<string, unknown> = {
      'http endpoint': { ...goodSub, endpoint: 'http://fcm.googleapis.com/x' },
      'ip endpoint': { ...goodSub, endpoint: 'https://10.0.0.1/x' },
      'ipv6 endpoint': { ...goodSub, endpoint: 'https://[::1]/x' },
      'localhost endpoint': { ...goodSub, endpoint: 'https://localhost/x' },
      'single label host': { ...goodSub, endpoint: 'https://intranet/x' },
      '.internal host': { ...goodSub, endpoint: 'https://svc.internal/x' },
      'custom port': { ...goodSub, endpoint: 'https://fcm.googleapis.com:8443/x' },
      userinfo: { ...goodSub, endpoint: 'https://u:p@fcm.googleapis.com/x' },
      'too long endpoint': { ...goodSub, endpoint: 'https://fcm.googleapis.com/' + 'a'.repeat(600) },
      'whitespace endpoint': { ...goodSub, endpoint: 'https://fcm.googleapis.com/x y' },
      'ftp endpoint': { ...goodSub, endpoint: 'ftp://fcm.googleapis.com/x' },
      fragment: { ...goodSub, endpoint: 'https://fcm.googleapis.com/x#y' },
      'missing keys': { endpoint: goodSub.endpoint },
      'p256dh wrong length': { ...goodSub, keys: { p256dh: pub.subarray(0, 64).toString('base64url'), auth: goodSub.keys.auth } },
      'p256dh off curve': { ...goodSub, keys: { p256dh: offCurve.toString('base64url'), auth: goodSub.keys.auth } },
      'p256dh std base64': { ...goodSub, keys: { p256dh: pub.toString('base64'), auth: goodSub.keys.auth } },
      'auth wrong length': { ...goodSub, keys: { p256dh: goodSub.keys.p256dh, auth: crypto.randomBytes(15).toString('base64url') } },
      'auth not a string': { ...goodSub, keys: { p256dh: goodSub.keys.p256dh, auth: 5 } },
      'endpoint not a string': { ...goodSub, endpoint: 5 },
      null: null,
    };
    for (const [name, sub] of Object.entries(cases)) expect(() => validateSubscription(sub), name).toThrow(BadRequest);
    expect(validateSubscription({ endpoint: goodSub.endpoint }, false).endpoint).toBe(goodSub.endpoint);
    for (const ep of ['https://web.push.apple.com/QGx', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://fcm.googleapis.com/fcm/send/eABC:APA91b-_x', 'https://fcm.googleapis.com:443/x']) {
      expect(endpointError(ep), ep).toBeNull();
    }
    // exact PHP messages
    expect(() => validateSubscription(null)).toThrow('subscription mancante');
    expect(() => validateSubscription({ ...goodSub, endpoint: 'http://fcm.googleapis.com/x' })).toThrow('endpoint deve essere https');
    expect(() => validateSubscription({ ...goodSub, endpoint: 'https://10.0.0.1/x' })).toThrow('endpoint con IP non consentito');
    expect(() => validateSubscription({ ...goodSub, endpoint: 'https://fcm.googleapis.com:8443/x' })).toThrow('endpoint con porta non consentita');
    expect(() => validateSubscription({ ...goodSub, endpoint: 'https://svc.internal/x' })).toThrow('endpoint host non consentito');
    expect(() => validateSubscription({ endpoint: goodSub.endpoint })).toThrow('subscription.keys mancanti');
    expect(() => validateSubscription({ ...goodSub, keys: { ...goodSub.keys, p256dh: offCurve.toString('base64url') } })).toThrow('keys.p256dh non valida');
  });

  it('private / reserved addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isNonPublicIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '142.250.180.10', '2a00:1450:4002:80a::200a']) expect(isNonPublicIp(ip), ip).toBe(false);
  });

  it('devices (fcm / apns)', () => {
    const fcm = 'eX4mpLe:APA91b' + 'A'.repeat(140);
    expect(validateDevice({ type: 'fcm', token: fcm, extra: 1 })).toEqual({ type: 'fcm', token: fcm });
    bad(() => validateDevice({ type: 'fcm', token: 'short' }));
    bad(() => validateDevice({ type: 'fcm', token: 'a'.repeat(99) }));
    expect(validateDevice({ type: 'fcm', token: 'a'.repeat(100) })).toBeTruthy();
    expect(validateDevice({ type: 'fcm', token: 'a'.repeat(4096) })).toBeTruthy();
    bad(() => validateDevice({ type: 'fcm', token: 'a'.repeat(4097) }));
    bad(() => validateDevice({ type: 'fcm', token: 'a'.repeat(120) + '/' }));
    bad(() => validateDevice({ type: 'fcm' }));
    const hex = 'AB'.repeat(32);
    expect(validateDevice({ type: 'apns', token: hex, environment: 'production' })).toEqual({ type: 'apns', token: hex.toLowerCase(), environment: 'production' });
    expect(validateDevice({ type: 'apns', token: hex })).toEqual({ type: 'apns', token: hex.toLowerCase(), environment: 'sandbox' });
    bad(() => validateDevice({ type: 'apns', token: hex, environment: 'prod' }));
    bad(() => validateDevice({ type: 'apns', token: hex.slice(2) }));
    bad(() => validateDevice({ type: 'apns', token: 'zz' + hex.slice(2) }));
    bad(() => validateDevice({ type: 'webpush' }));
    bad(() => validateDevice({ type: 'sms', token: 'x' }));
    bad(() => validateDevice(null));
    expect(() => validateDevice(undefined)).toThrow('device mancante');
    expect(() => validateDevice({ type: 'x' })).toThrow('device.type non valido');
    expect(validateDevice({ type: 'webpush', subscription: goodSub })).toEqual({ type: 'webpush', subscription: goodSub });
  });

  it('reminder', () => {
    expect(validateReminder(goodRem)).toEqual(goodRem);
    const r = { ...goodRem, weekdays: [4, 2, 2, 3, 1, 7], extra: 'ignored' };
    expect(validateReminder(r).weekdays).toEqual([1, 2, 3, 4, 7]);
    expect(validateReminder(r)).not.toHaveProperty('extra');
    expect(validateReminder({ ...goodRem, stopName: '  Acilia \n' }).stopName).toBe('Acilia');
    const tr = { ...goodRem, source: { type: 'cotralTrain', stationName: 'Acilia', route: 'RL_PSP-CC' } };
    expect(validateReminder(tr).source).toEqual(tr.source);
    const at = { ...goodRem, source: { type: 'atacStop', stopId: '05000' } };
    expect(validateReminder(at).source).toEqual(at.source);
    for (const route of Object.keys(DIRECTION_LABELS)) {
      expect(validateSource({ type: 'cotralTrain', stationName: 'X', route })).toEqual({ type: 'cotralTrain', stationName: 'X', route });
    }
    const { stopName: _s, ...noName } = goodRem;
    const { source: _src, ...noSource } = goodRem;
    const cases: Record<string, unknown> = {
      'id empty': { ...goodRem, id: '' },
      'id too long': { ...goodRem, id: 'a'.repeat(65) },
      'id bad chars': { ...goodRem, id: 'a b' },
      'id not string': { ...goodRem, id: 12 },
      'stopName empty': { ...goodRem, stopName: '  ' },
      'stopName too long': { ...goodRem, stopName: 'a'.repeat(121) },
      'stopName control char': { ...goodRem, stopName: 'a\x00b' },
      'stopName lone surrogate': { ...goodRem, stopName: 'a\ud800b' },
      'stopName missing': noName,
      'hour 24': { ...goodRem, hour: 24 },
      'hour -1': { ...goodRem, hour: -1 },
      'hour string': { ...goodRem, hour: '7' },
      'hour float': { ...goodRem, hour: 7.5 },
      'minute 60': { ...goodRem, minute: 60 },
      'weekdays empty': { ...goodRem, weekdays: [] },
      'weekdays 0': { ...goodRem, weekdays: [0, 1] },
      'weekdays 8': { ...goodRem, weekdays: [8] },
      'weekdays string': { ...goodRem, weekdays: ['2'] },
      'weekdays not array': { ...goodRem, weekdays: 2 },
      'weekdays > 14 items': { ...goodRem, weekdays: Array(15).fill(1) },
      'source missing': noSource,
      'source unknown type': { ...goodRem, source: { type: 'metro', stopId: '1' } },
      'cotralBus no pole': { ...goodRem, source: { type: 'cotralBus' } },
      'cotralBus long pole': { ...goodRem, source: { type: 'cotralBus', poleCode: '1'.repeat(65) } },
      'train bad route': { ...goodRem, source: { type: 'cotralTrain', stationName: 'A', route: 'RL_XX' } },
      'train no station': { ...goodRem, source: { type: 'cotralTrain', route: 'RL_CC-PSP' } },
      'atac no stopId': { ...goodRem, source: { type: 'atacStop' } },
      'atac stopId int': { ...goodRem, source: { type: 'atacStop', stopId: 5 } },
    };
    for (const [name, rem] of Object.entries(cases)) expect(() => validateReminder(rem), name).toThrow(BadRequest);
    expect(() => validateReminder({ ...goodRem, hour: '7' })).toThrow('hour deve essere 0-23');
    expect(() => validateReminder({ ...goodRem, weekdays: [0] })).toThrow('weekdays deve contenere interi 1-7');
    expect(() => validateReminder(noName)).toThrow('stopName mancante');
  });

  it('reminder list', () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ ...goodRem, id: `r${i}` }));
    expect(validateReminders(list)).toHaveLength(30);
    expect(() => validateReminders([...list, { ...goodRem, id: 'r30' }])).toThrow('Troppi promemoria (max 30)');
    expect(() => validateReminders([goodRem, goodRem])).toThrow('id promemoria duplicato');
    bad(() => validateReminders('x'));
    bad(() => validateReminders({ a: goodRem }));
    expect(validateReminders([])).toEqual([]);
    expect(validateReminders({})).toEqual([]); // PHP json_decode('{}', true) === []
  });
});

// ======================================================================= due logic (test_runner.php "isDue (table)")
describe('isDue', () => {
  const row = (reminder: Reminder, lastDoneDate = 0, retryCount = 0, retryAt = 0, retryDate = 0) => ({ reminder, lastDoneDate, retryCount, retryAt, retryDate });
  const mon = mkRem('m', [2], 7, 30);
  // 2026-10-04 is a Sunday, 2026-10-05 a Monday.
  const table: [string, ReturnType<typeof row>, string, boolean][] = [
    ['Monday 07:29 -> not yet', row(mon), '2026-10-05 07:29', false],
    ['Monday 07:30 -> due', row(mon), '2026-10-05 07:30', true],
    ['Monday 07:34 (grace) -> due', row(mon), '2026-10-05 07:34', true],
    ['Monday 07:35 (grace over) -> not due', row(mon), '2026-10-05 07:35', false],
    ['Monday done today -> not due', row(mon, 20261005), '2026-10-05 07:30', false],
    ['Monday done last week -> due', row(mon, 20260928), '2026-10-05 07:30', true],
    ['Tuesday -> not due', row(mon), '2026-10-06 07:30', false],
    ['Sunday=1: weekdays [1] fires on Sunday', row(mkRem('s', [1], 7, 30)), '2026-10-04 07:30', true],
    ['Sunday=1: weekdays [1] not on Monday', row(mkRem('s', [1], 7, 30)), '2026-10-05 07:30', false],
    ['Sunday=1: weekdays [2..7] not on Sunday', row(mkRem('s', [2, 3, 4, 5, 6, 7], 7, 30)), '2026-10-04 07:30', false],
    ['Saturday=7: weekdays [7] fires on Saturday', row(mkRem('s', [7], 7, 30)), '2026-10-03 07:30', true],
    ['Saturday=7: weekdays [7] not on Friday', row(mkRem('s', [7], 7, 30)), '2026-10-02 07:30', false],
    ['Friday=6', row(mkRem('s', [6], 7, 30)), '2026-10-02 07:30', true],
    ['multi-day set', row(mkRem('s', [2, 4, 6], 7, 30)), '2026-10-07 07:31', true],
    ['midnight reminder 00:00', row(mkRem('s', [2], 0, 0)), '2026-10-05 00:02', true],
    ['23:59 reminder', row(mkRem('s', [2], 23, 59)), '2026-10-05 23:59', true],
    ['retry 3: before retry_at -> no', row(mon, 0, 3, unix('2026-10-05 07:40'), 20261005), '2026-10-05 07:39', false],
    ['retry 3: at retry_at -> due', row(mon, 0, 3, unix('2026-10-05 07:40'), 20261005), '2026-10-05 07:40', true],
    ['retry 3: long after retry_at but inside window -> due', row(mon, 0, 3, unix('2026-10-05 07:40'), 20261005), '2026-10-05 08:10', true],
    ['retry 3: past retry window -> no', row(mon, 0, 3, unix('2026-10-05 07:40'), 20261005), '2026-10-05 08:31', false],
    ['retry 14 -> due', row(mon, 0, 14, unix('2026-10-05 07:58'), 20261005), '2026-10-05 07:58', true],
    ['retry 15 -> never due', row(mon, 0, 15, unix('2026-10-05 07:58'), 20261005), '2026-10-05 08:00', false],
    ['retry>0 past grace but retry_at reached -> due', row(mon, 0, 1, unix('2026-10-05 07:42'), 20261005), '2026-10-05 07:42', true],
    ['retry>0 inside grace but retry_at not reached -> no', row(mon, 0, 1, unix('2026-10-05 07:32'), 20261005), '2026-10-05 07:31', false],
    ['stale retry state from last week ignored: fresh window works', row(mon, 0, 7, unix('2026-09-28 07:50'), 20260928), '2026-10-05 07:30', true],
    ['stale retry state from last week ignored: no phantom retry', row(mon, 0, 7, unix('2026-09-28 07:50'), 20260928), '2026-10-05 07:50', false],
    ['retry state but done today -> no', row(mon, 20261005, 3, 0, 20261005), '2026-10-05 07:50', false],
    // DST: Rome wall-clock time on the days the clocks change (2026-03-29 spring forward, 2026-10-25 fall back; Sundays)
    ['DST spring forward: 07:30 CEST fires at 07:30', row(mkRem('s', [1], 7, 30)), '2026-03-29 07:30', true],
    ['DST fall back: 07:30 CET fires at 07:30', row(mkRem('s', [1], 7, 30)), '2026-10-25 07:30', true],
    ['DST fall back: not at 06:30 CET', row(mkRem('s', [1], 7, 30)), '2026-10-25 06:30', false],
  ];
  it.each(table)('%s', (_name, r, now, expected) => {
    expect(isDue(r, rome(now))).toBe(expected);
  });
});

// ======================================================================= runner + store (test_runner.php)
describe('runner and store', () => {
  let db: Database.Database;
  let store: ReminderStore;
  const ok = async (): Promise<DepartureStatus> => st('07:45', 2);
  const idOf = (d: ReturnType<typeof mkDevice>) => ReminderStore.deviceId(d);

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ReminderStore(db);
  });

  it('success path: one push per day, fires again next week', async () => {
    const sender = new FakeSender();
    let fetches = 0;
    const subA = mkDevice('a');
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const runner = new ReminderRunner(store, async () => { fetches++; return ok(); }, sender.send);
    expect((await runner.run(rome('2026-10-05 07:29'))).due).toBe(0);
    expect((await runner.run(rome('2026-10-05 07:30'))).sent).toBe(1);
    expect(sender.sent[0].payload.title).toBe('Prossimo bus alle 07:45');
    expect(sender.sent[0].payload.body).toBe('Il prossimo bus per Acilia è in ritardo di 2 minuti.');
    expect(sender.sent[0].payload.tag).toBe('r1');
    expect(sender.sent[0].device).toEqual(subA);
    await runner.run(rome('2026-10-05 07:31'));
    await runner.run(rome('2026-10-05 07:32'));
    expect(sender.sent).toHaveLength(1);
    expect(fetches).toBe(1);
    const rows = store.reminderRows(idOf(subA));
    expect([rows[0].last_done_date, rows[0].retry_count]).toEqual([20261005, 0]);
    await runner.run(rome('2026-10-12 07:31'));
    expect(sender.sent).toHaveLength(2);
    expect(db.prepare('SELECT last_ok_at FROM devices').pluck().get()).toBeGreaterThan(0);
  });

  it('retry policy: no notification, retry after 120 s, success resets', async () => {
    const sender = new FakeSender();
    let mode: 'fail' | 'ok' | 'throw' = 'fail';
    let fetches = 0;
    const fetch = async () => { fetches++; if (mode === 'throw') throw new Error('boom'); return mode === 'fail' ? null : ok(); };
    const subA = mkDevice('a');
    const id = idOf(subA);
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const runner = new ReminderRunner(store, fetch, sender.send);
    await runner.run(rome('2026-10-05 07:30'));
    let row = store.reminderRows(id)[0];
    expect(sender.sent).toHaveLength(0);
    expect(row.retry_count).toBe(1);
    expect(row.retry_at).toBe(unix('2026-10-05 07:32'));
    expect(row.last_done_date).toBe(0);
    await runner.run(rome('2026-10-05 07:31'));
    expect(fetches).toBe(1);
    mode = 'ok';
    await runner.run(rome('2026-10-05 07:32'));
    expect(sender.sent).toHaveLength(1);
    row = store.reminderRows(id)[0];
    expect([row.last_done_date, row.retry_count]).toEqual([20261005, 0]);

    // 15 attempts then silent give-up, scheduler ticking every minute
    db.exec('DELETE FROM reminders');
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const sender2 = new FakeSender();
    mode = 'fail';
    fetches = 0;
    const runner2 = new ReminderRunner(store, fetch, sender2.send);
    for (let m = 0; m <= 150; m++) await runner2.run(plusMinutes(rome('2026-10-05 07:30'), m));
    expect(fetches).toBe(15);
    expect(sender2.sent).toHaveLength(0);
    row = store.reminderRows(id)[0];
    expect([row.last_done_date, row.retry_count]).toEqual([20261005, 0]);
    fetches = 0;
    await runner2.run(rome('2026-10-12 07:30'));
    expect(fetches).toBe(1);
    mode = 'throw';
    db.exec('UPDATE reminders SET last_done_date = 0, retry_count = 0');
    await runner2.run(rome('2026-10-12 07:31'));
    expect(store.reminderRows(id)[0].retry_count).toBe(1);
  });

  it('60-minute chain abandon: with retries every 2 min only 15 fit, the window still bounds slow chains', async () => {
    const subA = mkDevice('a');
    const id = idOf(subA);
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    // A chain at attempt 5 whose next retry is only due after the window: never attempted again today.
    db.prepare('UPDATE reminders SET retry_count = 5, retry_at = ?, retry_date = 20261005').run(unix('2026-10-05 08:31'));
    let fetches = 0;
    const runner = new ReminderRunner(store, async () => { fetches++; return null; }, new FakeSender().send);
    for (let m = 0; m <= 120; m++) await runner.run(plusMinutes(rome('2026-10-05 07:30'), m));
    expect(fetches).toBe(0);
    expect(store.reminderRows(id)[0].retry_count).toBe(5);
  });

  it('midnight-crossing retry chain does not wedge', async () => {
    const subA = mkDevice('a');
    store.replaceReminders(subA, [mkRem('r1', [1, 2, 3, 4, 5, 6, 7], 23, 59)], rome('2026-10-05 20:00'));
    let mode = 'fail';
    let fetches = 0;
    const sender = new FakeSender();
    const runner = new ReminderRunner(store, async () => { fetches++; return mode === 'fail' ? null : ok(); }, sender.send);
    await runner.run(rome('2026-10-05 23:59'));
    fetches = 0;
    await runner.run(rome('2026-10-06 00:01'));
    expect(fetches).toBe(0);
    mode = 'ok';
    await runner.run(rome('2026-10-06 23:59'));
    expect(sender.sent).toHaveLength(1);
  });

  it('push failures: gone device deleted, others served; 5xx/transport -> retry; 404 -> gone', async () => {
    const subA = mkDevice('a');
    const subB = mkDevice('b');
    const idA = idOf(subA);
    const idB = idOf(subB);
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30), mkRem('r2', [2], 7, 30, { type: 'atacStop', stopId: '5' })], rome('2026-10-05 06:00'));
    store.replaceReminders(subB, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const sender = new FakeSender();
    sender.decide = (d) => (d.type === 'webpush' && d.subscription.endpoint === subA.subscription.endpoint ? 410 : 201);
    const s = await new ReminderRunner(store, ok, sender.send).run(rome('2026-10-05 07:30'));
    expect(s.gone).toBe(1);
    expect(store.device(idA)).toBeNull();
    expect(store.reminderRows(idA)).toEqual([]);
    expect(store.reminderRows(idB)).toHaveLength(1);
    expect(s.sent).toBe(1);
    expect(sender.sent).toHaveLength(2); // A.r1 (gone) + B.r1; A.r2 skipped

    db.exec('DELETE FROM reminders; DELETE FROM devices');
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const sender2 = new FakeSender();
    sender2.statuses = [500, 0, 404];
    const runner = new ReminderRunner(store, ok, sender2.send);
    await runner.run(rome('2026-10-05 07:30'));
    let row = store.reminderRows(idA)[0];
    expect([row.last_done_date, row.retry_count]).toEqual([0, 1]);
    await runner.run(rome('2026-10-05 07:32'));
    row = store.reminderRows(idA)[0];
    expect(row.retry_count).toBe(2);
    await runner.run(rome('2026-10-05 07:34'));
    expect(store.device(idA)).toBeNull();
  });

  it('one fetch per identical source per run (also across devices)', async () => {
    const subA = mkDevice('a');
    const subB = mkDevice('b');
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30), mkRem('r2', [2], 7, 30, undefined, 'Acilia bis')], rome('2026-10-05 06:00'));
    store.replaceReminders(subB, [mkRem('r1', [2], 7, 30), mkRem('r3', [2], 7, 30, { type: 'atacStop', stopId: '9' })], rome('2026-10-05 06:00'));
    let fetches = 0;
    const sender = new FakeSender();
    const s = await new ReminderRunner(store, async () => { fetches++; await new Promise((r) => setTimeout(r, 5)); return ok(); }, sender.send).run(rome('2026-10-05 07:30'));
    expect([s.sent, fetches]).toEqual([4, 2]);
  });

  it('works for fcm and apns devices too', async () => {
    const fcm = { type: 'fcm' as const, token: 'f'.repeat(150) };
    const apns = { type: 'apns' as const, token: 'a'.repeat(64), environment: 'sandbox' as const };
    store.replaceReminders(fcm, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    store.replaceReminders(apns, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const sender = new FakeSender();
    sender.decide = (d) => (d.type === 'apns' ? 410 : 200);
    const s = await new ReminderRunner(store, ok, sender.send).run(rome('2026-10-05 07:30'));
    expect([s.sent, s.gone]).toEqual([1, 1]);
    expect(store.device(ReminderStore.deviceId(fcm))).toEqual(fcm);
    expect(store.device(ReminderStore.deviceId(apns))).toBeNull();
  });

  it('dry run does not touch state', async () => {
    const subA = mkDevice('a');
    store.replaceReminders(subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
    const sender = new FakeSender();
    const runner = new ReminderRunner(store, ok, sender.send, { persist: false });
    await runner.run(rome('2026-10-05 07:30'));
    await runner.run(rome('2026-10-05 07:31'));
    expect(sender.sent).toHaveLength(2);
    expect(store.reminderRows(idOf(subA))[0].last_done_date).toBe(0);
  });

  it('replace preserves / resets state', async () => {
    const subA = mkDevice('a');
    const idA = idOf(subA);
    const list = [mkRem('r1', [2], 7, 30), mkRem('r2', [2], 7, 45), mkRem('r3', [2], 12, 0)];
    const byId = () => Object.fromEntries(store.reminderRows(idA).map((r) => [r.id, r]));
    store.replaceReminders(subA, list, rome('2026-10-05 06:00'));
    let sender = new FakeSender();
    let runner = new ReminderRunner(store, ok, sender.send);
    await runner.run(rome('2026-10-05 07:30'));
    expect(sender.tags()).toEqual(['r1']);
    // user renames an unrelated reminder at 07:32 and re-syncs the whole list
    list[2] = { ...list[2], stopName: 'Altro nome' };
    store.replaceReminders(subA, list, rome('2026-10-05 07:32'));
    await runner.run(rome('2026-10-05 07:33'));
    expect(sender.sent).toHaveLength(1);
    expect(byId().r1.last_done_date).toBe(20261005);
    expect(JSON.parse(byId().r3.json).stopName).toBe('Altro nome');
    // cosmetic change of r1 (name) keeps state too
    list[0] = { ...list[0], stopName: 'Acilia (nuovo nome)' };
    store.replaceReminders(subA, list, rome('2026-10-05 07:34'));
    expect(byId().r1.last_done_date).toBe(20261005);
    // weekdays given in another order = same schedule
    list[0] = { ...list[0], weekdays: [2] };
    // retry state preserved
    db.exec("UPDATE reminders SET last_done_date = 0, retry_count = 4, retry_at = 123, retry_date = 20261005 WHERE id = 'r2'");
    store.replaceReminders(subA, list, rome('2026-10-05 07:35'));
    const r2 = byId().r2;
    expect([r2.last_done_date, r2.retry_count, r2.retry_at, r2.retry_date]).toEqual([0, 4, 123, 20261005]);
    // schedule edit resets: r1 moved to 07:40 (future today) -> not done, fires at 07:40
    list[0] = { ...list[0], minute: 40 };
    store.replaceReminders(subA, list, rome('2026-10-05 07:36'));
    expect([byId().r1.last_done_date, byId().r1.retry_count]).toEqual([0, 0]);
    sender = new FakeSender();
    runner = new ReminderRunner(store, ok, sender.send, { concurrency: 1 });
    await runner.run(rome('2026-10-05 07:40'));
    expect(sender.tags()).toEqual(['r1', 'r2']);
    // source change resets too (time already passed -> done, no retro fire)
    list[0] = { ...list[0], source: { type: 'atacStop', stopId: '9' } };
    store.replaceReminders(subA, list, rome('2026-10-05 07:41'));
    expect(byId().r1.last_done_date).toBe(20261005);
    // removing a reminder removes its row
    store.replaceReminders(subA, [list[1]], rome('2026-10-05 07:42'));
    expect(store.reminderRows(idA).map((r) => r.id)).toEqual(['r2']);
    expect(store.replaceReminders(subA, [], rome('2026-10-05 07:43'))).toBe(0);
    expect(store.device(idA)).not.toBeNull();
    store.deleteDevice(idA);
    expect(store.device(idA)).toBeNull();
  });

  it('re-sync refreshes the device payload (new Web Push keys)', () => {
    const subA = mkDevice('a');
    store.replaceReminders(subA, [], rome('2026-10-05 06:00'));
    const fresh = { ...subA, subscription: { ...subA.subscription, keys: mkDevice('x').subscription.keys } };
    store.replaceReminders(fresh, [], rome('2026-10-05 06:01'));
    expect(store.device(idOf(subA))).toEqual(fresh);
    expect(db.prepare('SELECT COUNT(*) FROM devices').pluck().get()).toBe(1);
  });

  it.each([
    ['created at 09:00 for 07:30 today (Mon) -> done today', mkRem('x', [2], 7, 30), '2026-10-05 09:00:00', 20261005],
    ['created 07:36 for 07:30 (6 min ago) -> done today', mkRem('x', [2], 7, 30), '2026-10-05 07:36:00', 20261005],
    ['created 07:31:10 for 07:30 (earlier minute) -> done today', mkRem('x', [2], 7, 30), '2026-10-05 07:31:10', 20261005],
    ['created 07:30:20 for 07:30 (current minute) -> will fire', mkRem('x', [2], 7, 30), '2026-10-05 07:30:20', 0],
    ['created 07:00 for 07:30 -> will fire', mkRem('x', [2], 7, 30), '2026-10-05 07:00:00', 0],
    ['created Mon 09:00 for Tue 07:30 -> untouched', mkRem('x', [3], 7, 30), '2026-10-05 09:00:00', 0],
    ['created Mon 09:00 for Mon 07:30 + Tue -> done today only', mkRem('x', [2, 3], 7, 30), '2026-10-05 09:00:00', 20261005],
  ] as const)('no retroactive firing: %s', (_name, rem, at, expected) => {
    const subA = mkDevice('a');
    store.replaceReminders(subA, [rem], rome(at));
    expect(store.reminderRows(idOf(subA))[0].last_done_date).toBe(expected);
  });

  it('late-created reminder does not fire today, fires next week', async () => {
    const subA = mkDevice('a');
    store.replaceReminders(subA, [mkRem('x', [2], 7, 30)], rome('2026-10-05 09:00:00'));
    const sender = new FakeSender();
    await new ReminderRunner(store, ok, sender.send).run(rome('2026-10-05 09:01'));
    expect(sender.sent).toHaveLength(0);
    await new ReminderRunner(store, ok, sender.send).run(rome('2026-10-12 07:30'));
    expect(sender.sent).toHaveLength(1);
  });

  it('device cap, test rate limit, prune', () => {
    const ins = db.prepare("INSERT INTO devices (id, type, payload, created_at, updated_at) VALUES (?, 'fcm', '{}', 1, 1)");
    db.transaction(() => { for (let i = 0; i < MAX_DEVICES; i++) ins.run(`fake${i}`); })();
    expect(() => store.replaceReminders(mkDevice('new'), [mkRem('r', [2], 7, 30)], rome('2026-10-05 09:00'))).toThrow(NotReady);
    expect(db.prepare('SELECT COUNT(*) FROM reminders').pluck().get()).toBe(0);
    db.exec('DELETE FROM devices');

    const sub = mkDevice('t');
    const id = idOf(sub);
    store.replaceReminders(sub, [], rome('2026-10-05 09:00'));
    const t = unix('2026-10-05 09:00');
    expect(store.claimTest(id, t)).toBe(0);
    expect(store.claimTest(id, t + 5)).toBe(25);
    expect(store.claimTest(id, t + 29)).toBe(1);
    expect(store.claimTest(id, t + 30)).toBe(0);

    db.exec('DELETE FROM reminders; DELETE FROM devices');
    const now = unix('2026-10-05 09:00');
    const add = db.prepare("INSERT INTO devices (id, type, payload, created_at, updated_at, last_ok_at) VALUES (?, 'fcm', '{}', ?, ?, ?)");
    const rem = db.prepare("INSERT INTO reminders (id, device_id, json) VALUES ('r', ?, '{}')");
    for (const [n, c, u, o] of [['old', 1, 1, null], ['oldbutok', 1, 1, now - 86400], ['oldsynced', 1, now - 86400, null], ['fresh', now, now, null]] as const) {
      add.run(n, c, u, o);
      rem.run(n);
    }
    expect(store.pruneStale(now)).toBe(1);
    expect(db.prepare('SELECT id FROM devices ORDER BY id').pluck().all()).toEqual(['fresh', 'oldbutok', 'oldsynced']);
    expect(db.prepare('SELECT COUNT(*) FROM reminders').pluck().get()).toBe(3);
  });

  it('schema: user_version 2, idempotent migrate, columns', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    ReminderStore.migrate(db);
    expect(db.prepare('PRAGMA table_info(reminders)').all().map((c) => (c as { name: string }).name))
      .toEqual(['id', 'device_id', 'json', 'last_done_date', 'retry_count', 'retry_at', 'retry_date']);
    expect(db.prepare('PRAGMA table_info(devices)').all().map((c) => (c as { name: string }).name))
      .toEqual(['id', 'type', 'payload', 'created_at', 'updated_at', 'last_ok_at', 'last_test_at']);
  });

  it('migrates a Madovai-Web (PHP, user_version 1) state.sqlite, keeping subscriptions and reminder state', async () => {
    const old = new Database(':memory:');
    old.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_ok_at INTEGER, last_test_at INTEGER);
      CREATE TABLE reminders (id TEXT NOT NULL, sub_id TEXT NOT NULL, json TEXT NOT NULL, last_done_date INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, retry_date INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sub_id, id));
      CREATE INDEX reminders_done ON reminders(last_done_date);
      PRAGMA user_version = 1;`);
    const dev = mkDevice('php');
    const phpId = crypto.createHash('sha256').update(dev.subscription.endpoint).digest('hex');
    old.prepare('INSERT INTO subscriptions VALUES (?,?,?,?,?,?,?,?)').run(phpId, dev.subscription.endpoint, dev.subscription.keys.p256dh, dev.subscription.keys.auth, 10, 20, 30, 40);
    old.prepare('INSERT INTO reminders VALUES (?,?,?,?,?,?,?)').run('r1', phpId, JSON.stringify(mkRem('r1', [2], 7, 30)), 20261005, 0, 0, 0);
    old.prepare('INSERT INTO reminders VALUES (?,?,?,?,?,?,?)').run('r2', phpId, JSON.stringify(mkRem('r2', [2], 7, 45)), 0, 3, 99, 20261005);
    const s = new ReminderStore(old);
    expect(old.pragma('user_version', { simple: true })).toBe(2);
    const id = ReminderStore.deviceId(dev);
    expect(s.device(id)).toEqual(dev);
    expect(old.prepare('SELECT created_at, updated_at, last_ok_at, last_test_at FROM devices').get()).toEqual({ created_at: 10, updated_at: 20, last_ok_at: 30, last_test_at: 40 });
    expect(s.reminderRows(id).map((r) => [r.id, r.last_done_date, r.retry_count, r.retry_at, r.retry_date])).toEqual([['r1', 20261005, 0, 0, 0], ['r2', 0, 3, 99, 20261005]]);
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name IN ('subscriptions', 'reminders_v1')").all()).toEqual([]);
    // and it keeps working: unchanged schedule keeps state on re-sync
    s.replaceReminders(dev, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 08:00'));
    expect(s.reminderRows(id)[0].last_done_date).toBe(20261005);
  });
});
