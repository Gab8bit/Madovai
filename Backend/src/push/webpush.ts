import { generateRequestDetails } from 'web-push';
import { errorSnippet, pushResult, type PushResult } from './result.js';
import { PUSH_TTL_SECONDS, SEND_TIMEOUT_MS } from './settings.js';
import { pushHostAllowed, type WebPushSubscription } from './validation.js';
import type { VapidKeys } from './vapid.js';

/**
 * Web Push channel: the `web-push` library encrypts the payload (RFC 8291 aes128gcm) and signs the VAPID JWT
 * (RFC 8292); the request itself goes out through fetch so that redirects are never followed, the timeout is ours,
 * and (tests only, PUSH_ALLOW_INSECURE) a local http:// receiver works too. Only ever posts to the endpoint the
 * client registered, after the same host checks as the PHP sender.
 */
export async function sendWebPush(sub: WebPushSubscription, payloadJson: string, vapid: VapidKeys, timeoutMs = SEND_TIMEOUT_MS): Promise<PushResult> {
  if (!(await pushHostAllowed(sub.endpoint))) return pushResult(0, 'endpoint non consentito');
  let details;
  try {
    details = generateRequestDetails(sub, payloadJson, {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: PUSH_TTL_SECONDS,
      urgency: 'high',
      contentEncoding: 'aes128gcm',
    });
  } catch (err) {
    return pushResult(0, (err as Error).message);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(details.headers)) {
    if (k.toLowerCase() !== 'content-length' && v != null) headers[k] = String(v);
  }
  try {
    const res = await fetch(details.endpoint, {
      method: 'POST',
      headers,
      body: details.body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    return pushResult(res.status, res.status >= 300 ? errorSnippet(text) : '', res.status === 404 || res.status === 410);
  } catch (err) {
    const e = err as Error;
    return pushResult(0, e.name === 'TimeoutError' ? 'timeout' : (e.cause as Error)?.message || e.message);
  }
}
