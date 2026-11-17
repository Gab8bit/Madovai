/** Shared types — JSON shapes are identical to Madovai-Web's PHP API (see docs/API.md). */

export type Kind = 'bus' | 'tram' | 'metro' | 'treno';
export type Operator = 'Cotral' | 'Atac' | 'Roma TPL';

/** One scheduled passage at a rail station (ASTRAL or static-GTFS fallback). */
export interface Entry {
  id: string;
  time: string;          // "HH:MM" Rome
  sortSeconds: number;   // seconds since Rome midnight
  delayMinutes: number | null;
  isCancelled: boolean;
  isReplacementBus: boolean;
}

export type ReminderSource =
  | { type: 'cotralBus'; poleCode: string }
  | { type: 'cotralTrain'; stationName: string; route: string }
  | { type: 'atacStop'; stopId: string };

export interface Reminder {
  id: string;
  stopName: string;
  /** 1 = Sunday … 7 = Saturday (Apple Calendar convention). */
  weekdays: number[];
  hour: number;
  minute: number;
  source: ReminderSource;
}

export interface DepartureStatus {
  time: string;
  delayMinutes: number | null;
  isCancelled: boolean;
  nextUsefulTime: string | null;
}

export type Device =
  | { type: 'webpush'; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
  | { type: 'fcm'; token: string }
  | { type: 'apns'; token: string; environment: 'sandbox' | 'production' };

/** Notification content, the same for every channel. */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}
