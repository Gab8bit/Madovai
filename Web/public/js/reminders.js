import { createStore, storage } from './store.js';
import { syncReminders, pushCapability, usableSubscription } from './push.js';
import { weekdaysLabel } from './models.js';

// Reminders live in localStorage (the client is the source of truth) and are mirrored to the server, which wakes up
// every minute, checks the next departure and sends the Web Push — see docs/API.md. Same Reminder shape as iOS:
//   {id, stopName, weekdays:[1..7 (1=Sunday)], hour, minute, source:{type:'cotralBus'|'cotralTrain'|'atacStop', …}}
const KEY = 'madovai.reminders';

function load() {
  const list = storage.read(KEY, []);
  return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string' && r.source) : [];
}

export const remindersStore = createStore({ reminders: load(), sync: { status: 'idle', message: '' } });

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, 400);
}

export async function runSync() {
  const { reminders } = remindersStore.get();
  try {
    const sub = await usableSubscription();
    if (!sub) { remindersStore.set((s) => ({ ...s, sync: { status: pushCapability().needsInstall ? 'needs-install' : 'no-subscription', message: '' } })); return; }
    await syncReminders(reminders);
    remindersStore.set((s) => ({ ...s, sync: { status: 'ok', message: '' } }));
  } catch (e) {
    remindersStore.set((s) => ({ ...s, sync: { status: 'error', message: e.message } }));
  }
}

function commit(next) {
  storage.write(KEY, next);
  remindersStore.set((s) => ({ ...s, reminders: next }));
  scheduleSync();
}

export const reminders = {
  add: (r) => commit([...remindersStore.get().reminders, r]),
  update: (r) => commit(remindersStore.get().reminders.map((x) => (x.id === r.id ? r : x))),
  remove: (id) => commit(remindersStore.get().reminders.filter((x) => x.id !== id)),
};

export const reminderTimeLabel = (r) => `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`;
export const reminderDaysLabel = (r) => weekdaysLabel(r.weekdays);
export const reminderIsTrain = (r) => r.source.type === 'cotralTrain';
