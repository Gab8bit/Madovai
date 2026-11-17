import fs from 'node:fs';
import { config } from '../config.js';
import { NotReady } from '../lib/errors.js';
import type { Device, PushPayload } from '../types.js';
import { ApnsChannel } from './apns.js';
import { FcmChannel, readServiceAccount } from './fcm.js';
import { payloadJson } from './notifier.js';
import { pushResult, type PushResult } from './result.js';
import { pushSettings } from './settings.js';
import { vapidKeys } from './vapid.js';
import { sendWebPush } from './webpush.js';

/**
 * The one entry point for delivering a notification to any device type, plus which channels this server has
 * credentials for. FCM is on when FCM_SERVICE_ACCOUNT_FILE points to a readable service account; APNs when the
 * .p8 key file, key id, team id and topic are all set. Web Push is always on (VAPID keys are self-generated).
 */

let fcm: { sig: string; channel: FcmChannel | null } | null = null;
let apns: { sig: string; channel: ApnsChannel | null } | null = null;

export function fcmChannel(): FcmChannel | null {
  const file = config.fcm.serviceAccountFile;
  const sig = [file, file !== '' && fs.existsSync(file), pushSettings.fcmBaseUrl, pushSettings.fcmTokenUrl].join('|');
  if (fcm && fcm.sig === sig) return fcm.channel;
  let channel: FcmChannel | null = null;
  if (file && fs.existsSync(file)) {
    try {
      channel = new FcmChannel({
        serviceAccount: readServiceAccount(file),
        baseUrl: pushSettings.fcmBaseUrl,
        tokenUrl: pushSettings.fcmTokenUrl || undefined,
      });
    } catch {
      channel = null;
    }
  }
  fcm = { sig, channel };
  return channel;
}

export function apnsChannel(): ApnsChannel | null {
  const a = config.apns;
  const sig = [a.keyFile, a.keyFile !== '' && fs.existsSync(a.keyFile), a.keyId, a.teamId, a.topic, pushSettings.apnsHost].join('|');
  if (apns && apns.sig === sig) return apns.channel;
  let channel: ApnsChannel | null = null;
  if (a.keyFile && a.keyId && a.teamId && a.topic && fs.existsSync(a.keyFile)) {
    try {
      channel = ApnsChannel.fromFile(a.keyFile, { keyId: a.keyId, teamId: a.teamId, topic: a.topic, host: pushSettings.apnsHost || undefined });
    } catch {
      channel = null;
    }
  }
  apns?.channel?.close();
  apns = { sig, channel };
  return channel;
}

export interface PushConfig {
  webPush: { publicKey: string } | null;
  fcm: { enabled: boolean };
  apns: { enabled: boolean; topic: string | null };
}

/** What GET /api/v1/push/config reports to clients. */
export function pushConfig(): PushConfig {
  let webPush: PushConfig['webPush'] = null;
  try { webPush = { publicKey: vapidKeys().publicKey }; } catch { webPush = null; }
  const a = apnsChannel();
  return { webPush, fcm: { enabled: fcmChannel() !== null }, apns: { enabled: a !== null, topic: a ? a.topic : null } };
}

/** 503 when the server cannot deliver to this kind of device (no credentials). */
export function assertDeviceSupported(device: Device): void {
  if (device.type === 'webpush') vapidKeys();
  else if (device.type === 'fcm' && !fcmChannel()) throw new NotReady('Notifiche Android (FCM) non configurate sul server');
  else if (device.type === 'apns' && !apnsChannel()) throw new NotReady('Notifiche iOS (APNs) non configurate sul server');
}

export type Sender = (device: Device, payload: PushPayload) => Promise<PushResult>;

/** Delivers one notification. Never throws: every failure is a PushResult (status 0 = not even attempted/transport). */
export const send: Sender = async (device, payload) => {
  try {
    switch (device.type) {
      case 'webpush':
        return await sendWebPush(device.subscription, payloadJson(payload), vapidKeys());
      case 'fcm': {
        const ch = fcmChannel();
        return ch ? await ch.send(device.token, payload) : pushResult(0, 'FCM non configurato');
      }
      case 'apns': {
        const ch = apnsChannel();
        return ch ? await ch.send(device.token, device.environment, payload) : pushResult(0, 'APNs non configurato');
      }
      default:
        return pushResult(0, 'tipo di dispositivo sconosciuto');
    }
  } catch (err) {
    return pushResult(0, (err as Error).message);
  }
};

/** Closes long-lived connections (APNs HTTP/2 sessions). */
export function closeChannels(): void {
  apns?.channel?.close();
}
