/**
 * Push-module settings that are NOT deployment configuration (those live in src/config.ts: webPush / fcm / apns).
 * Everything here exists only so tests and local development can point the channels at local stubs; production
 * never sets these variables. Read on every call (not cached) so tests can flip them.
 */
const bool = (v: string | undefined) => v != null && /^(1|true|yes|on)$/i.test(v);

export const pushSettings = {
  /** PUSH_ALLOW_INSECURE=1: accept http:// and any host (localhost, IPs, ports) as Web Push endpoints. Tests/dev only. */
  get allowInsecure(): boolean { return bool(process.env.PUSH_ALLOW_INSECURE); },
  /** FCM_BASE_URL: origin of the FCM HTTP v1 API (default https://fcm.googleapis.com). Tests only. */
  get fcmBaseUrl(): string { return (process.env.FCM_BASE_URL || 'https://fcm.googleapis.com').replace(/\/+$/, ''); },
  /** FCM_TOKEN_URL: OAuth2 token endpoint; otherwise the service account's token_uri, otherwise Google's. Tests only. */
  get fcmTokenUrl(): string { return process.env.FCM_TOKEN_URL || ''; },
  /** APNS_HOST: origin (e.g. http://127.0.0.1:8443 for h2c) used for BOTH APNs environments. Tests only. */
  get apnsHost(): string { return process.env.APNS_HOST || ''; },
};

/** Per-request timeout towards push services (same as the PHP sender). */
export const SEND_TIMEOUT_MS = 10_000;
/** Seconds a push service may hold an undelivered message ("next bus" news is stale after that). */
export const PUSH_TTL_SECONDS = 600;
