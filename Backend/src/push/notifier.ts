import type { DepartureStatus, PushPayload, Reminder } from '../types.js';

/** Notification texts — a literal port of Madovai-Web's ReminderNotifier.php (itself a port of iOS `ReminderNotifier`). */

/** `CotralTrainRoute.directionLabel` */
export const DIRECTION_LABELS: Record<string, string> = {
  'RL_CC-PSP': 'Cristoforo Colombo → Porta San Paolo',
  'RL_PSP-CC': 'Porta San Paolo → Cristoforo Colombo',
  RN_RMMON: 'Flaminio → Montebello',
  RN_MONRM: 'Montebello → Flaminio',
  RV_CATVIT: 'Catalano → Viterbo',
  RV_VITCAT: 'Viterbo → Catalano',
  RV_MORCAT: 'Morlupo → Catalano',
  RV_CATMOR: 'Catalano → Morlupo',
};

/** Where the PWA opens on click (native apps ignore it). */
export const URL = './#/promemoria';

export function reminderPayload(reminder: Reminder, status: DepartureStatus): PushPayload {
  const source = reminder.source;
  const isTrain = source.type === 'cotralTrain';
  const vehicle = isTrain ? 'treno' : 'bus';

  let target = `per ${reminder.stopName ?? ''}`;
  if (source.type === 'cotralTrain') target += `, direzione ${DIRECTION_LABELS[source.route] ?? source.route}`;

  let body: string;
  if (status.isCancelled) {
    const next = status.nextUsefulTime;
    const fallback = next != null && next !== '' ? ` Prossimo utile: ${next}.` : " Nessun'altra corsa in programma.";
    body = `Il prossimo ${vehicle} ${target} è stato soppresso.${fallback}`;
  } else {
    const delay = status.delayMinutes;
    if (delay == null || delay < 1) body = `Il prossimo ${vehicle} ${target} non fa ritardo.`;
    else body = `Il prossimo ${vehicle} ${target} è in ritardo di ${delay} minut${delay === 1 ? 'o' : 'i'}.`;
  }

  return { title: `Prossimo ${vehicle} alle ${status.time}`, body, tag: String(reminder.id), url: URL };
}

export function testPayload(): PushPayload {
  return {
    title: 'Notifiche attive',
    body: 'I promemoria di Madovai ti avviseranno su questo dispositivo.',
    tag: 'madovai-test',
    url: URL,
  };
}

/** Web Push body: `{"title","body","tag","url"}`, unicode and slashes unescaped (same bytes as PHP). */
export function payloadJson(p: PushPayload): string {
  return JSON.stringify({ title: p.title, body: p.body, tag: p.tag, url: p.url });
}
