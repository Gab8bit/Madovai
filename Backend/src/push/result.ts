/**
 * Outcome of one delivery attempt on any channel. `status` is the push service's HTTP status, 0 = transport failure
 * (DNS, timeout, TLS, refused endpoint…). `gone` = the service says the device/subscription no longer exists and must
 * be dropped (Web Push 404/410, FCM UNREGISTERED/404, APNs 410/BadDeviceToken/Unregistered).
 */
export interface PushResult {
  status: number;
  ok: boolean;
  gone: boolean;
  error: string;
}

export function pushResult(status: number, error = '', gone = false): PushResult {
  const ok = status >= 200 && status < 300;
  return { status, ok, gone: !ok && gone, error: ok ? '' : error };
}

/** First 200 chars of an error body, trimmed (as PHP's mb_substr(trim($body), 0, 200)). */
export const errorSnippet = (body: string) => [...body.trim()].slice(0, 200).join('');
