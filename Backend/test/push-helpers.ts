import crypto from 'node:crypto';
import { romeParts } from '../src/lib/rome.js';
import type { PushResult } from '../src/push/result.js';
import { pushResult } from '../src/push/result.js';
import type { Device, PushPayload, Reminder, ReminderSource } from '../src/types.js';

/** Date for a Rome wall-clock time "YYYY-MM-DD HH:MM[:SS]" (DST-aware), like PHP `new DateTimeImmutable($s, Rome)`. */
export function rome(s: string): Date {
  const [d, t] = s.split(' ');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, m, sec = 0] = t.split(':').map(Number);
  const want = Date.UTC(Y, M - 1, D, h, m, sec);
  let ts = want - 2 * 3600_000;
  for (let i = 0; i < 4; i++) {
    const p = romeParts(new Date(ts));
    const diff = want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}
export const unix = (s: string) => Math.floor(rome(s).getTime() / 1000);
export const plusMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

/** A Web Push subscription with real P-256 keys (so encryption works); returns the receiver's private key too. */
export function mkSubscription(endpoint = `https://push.example.com/a/${crypto.randomBytes(4).toString('hex')}`) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    privateKey: ecdh.getPrivateKey(),
  };
}

export function mkDevice(name = 'a'): Device & { type: 'webpush' } {
  return { type: 'webpush', subscription: mkSubscription(`https://push.example.com/${name}/${crypto.randomBytes(4).toString('hex')}`).subscription };
}

export function mkRem(id: string, weekdays: number[], hour: number, minute: number,
  source: ReminderSource = { type: 'cotralBus', poleCode: '1021' }, stopName = 'Acilia'): Reminder {
  return { id, stopName, weekdays, hour, minute, source };
}

/** Test / dry-run sender: records every message; `statuses` are returned in order (then 201), or `decide` picks. */
export class FakeSender {
  sent: { device: Device; payload: PushPayload }[] = [];
  statuses: number[] = [];
  decide: ((device: Device, payload: PushPayload) => number) | null = null;
  send = async (device: Device, payload: PushPayload): Promise<PushResult> => {
    this.sent.push({ device, payload });
    const status = this.decide ? this.decide(device, payload) : (this.statuses.shift() ?? 201);
    return pushResult(status, status === 0 ? 'fake transport error' : '', status === 404 || status === 410);
  };
  tags = () => this.sent.map((s) => s.payload.tag);
}

/**
 * Independent RFC 8291 / RFC 8188 (aes128gcm) decryptor, written from the RFCs (same as Madovai-Web's
 * tests/php/push/node-decrypt.js) — used to check what the web-push library produced.
 */
export function decryptAes128gcm(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  if (rs < 18) throw new Error('bad record size');
  if (cipher.length > rs) throw new Error('multi-record bodies not handled here');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const hkdf = (ikm: Buffer, s: Buffer, info: Buffer, len: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 0x02) throw new Error('missing padding delimiter');
  return plain.subarray(0, end - 1).toString('utf8');
}
