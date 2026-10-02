import { api } from './api.js';
import { isIOS, isStandalone } from './util.js';

export class PushError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** What the browser can do about push right now (drives the "Notifiche" card in the Promemoria tab). */
export function pushCapability() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  // iOS (16.4+) only exposes Web Push to a PWA that was added to the Home Screen.
  const needsInstall = isIOS() && !isStandalone();
  return { supported, needsInstall, permission: 'Notification' in window ? Notification.permission : 'unsupported' };
}

function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function currentSubscription() {
  if (!pushCapability().supported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Makes sure this browser has a push subscription (asking for permission if needed).
 * MUST be called straight from a user gesture (a click handler): the permission prompt is the first thing it does.
 */
export async function ensureSubscription() {
  const cap = pushCapability();
  if (!cap.supported) throw new PushError('unsupported', 'Questo browser non supporta le notifiche push.');
  if (cap.needsInstall) {
    throw new PushError('needs-install', 'Su iPhone le notifiche funzionano solo dopo aver aggiunto Madovai alla schermata Home (Condividi → Aggiungi alla schermata Home) e averla riaperta da lì.');
  }
  if (Notification.permission === 'denied') {
    throw new PushError('denied', 'Le notifiche sono bloccate per questo sito: abilitale dalle impostazioni del browser.');
  }
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') throw new PushError('denied', 'Permesso per le notifiche non concesso.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    let key;
    try { key = await api.pushKey(); } catch (e) { throw new PushError('server', e.status === 503 ? 'Le notifiche non sono ancora configurate sul server.' : e.message); }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key.publicKey) });
  }
  return sub;
}

/** Replaces the server-side copy of this browser's reminders (the client is the source of truth; the server is a scheduler). */
export async function syncReminders(reminders) {
  const sub = await currentSubscription();
  if (!sub) return false;
  await api.saveReminders(sub.toJSON(), reminders);
  return true;
}

export async function sendTestPush() {
  const sub = await ensureSubscription();
  return api.pushTest(sub.toJSON());
}
