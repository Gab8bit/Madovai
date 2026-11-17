import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { NotReady } from '../lib/errors.js';

/**
 * VAPID (RFC 8292) application-server identity: a P-256 key pair in DATA_DIR/vapid.json (chmod 600), generated
 * automatically on first use (no separate CLI). The file format is the one Madovai-Web's bin/gen-vapid.php writes
 * ({publicKey, privateKeyPem, createdAt}), so an existing PHP data dir keeps working: browsers bind each push
 * subscription to this public key, regenerating it would silently invalidate all of them.
 */
export interface VapidKeys {
  /** base64url, 65-byte uncompressed P-256 point (the browser's applicationServerKey) */
  publicKey: string;
  /** base64url, 32-byte private scalar (what the web-push library wants) */
  privateKey: string;
  subject: string;
}

const cache = new Map<string, VapidKeys>();

export const vapidPath = (dir = config.dataDir) => path.join(dir, 'vapid.json');

function parse(raw: string): VapidKeys {
  const d = JSON.parse(raw) as { publicKey?: unknown; privateKeyPem?: unknown };
  if (typeof d.publicKey !== 'string' || typeof d.privateKeyPem !== 'string') throw new Error('vapid.json incompleto');
  const jwk = crypto.createPrivateKey(d.privateKeyPem).export({ format: 'jwk' });
  if (jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('vapid.json: chiave non P-256');
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  if (pub !== d.publicKey.replace(/=+$/, '')) throw new Error('vapid.json: chiave pubblica e privata non corrispondono');
  return { publicKey: pub, privateKey: jwk.d, subject: config.webPush.subject };
}

function generate(file: string): void {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
  const json = JSON.stringify({
    publicKey: pub,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    createdAt: new Date().toISOString(),
  }, null, 4) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  try {
    // link() fails if the file appeared meanwhile (another process won the race): keep theirs.
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Loads DATA_DIR/vapid.json, creating it on first use. Throws NotReady (503) when that is impossible. */
export function vapidKeys(dir = config.dataDir): VapidKeys {
  const file = vapidPath(dir);
  const hit = cache.get(file);
  if (hit) return hit;
  try {
    if (!fs.existsSync(file)) generate(file);
    const keys = parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, keys);
    return keys;
  } catch (err) {
    throw new NotReady(`Web Push non configurato: ${(err as Error).message}`);
  }
}

/** Tests only. */
export function resetVapidCache(): void {
  cache.clear();
}
