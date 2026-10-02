<?php
declare(strict_types=1);

namespace Madovai\Push;

use Madovai\Http;
use Madovai\HttpException;

/**
 * Real sender: VAPID + aes128gcm over Http::postRaw (curl, no redirects followed,
 * 10 s timeout). Only ever posts to the endpoint the client registered.
 */
final class HttpPushSender implements PushSender
{
    public function __construct(
        private readonly ?Vapid $vapid = null,
        private readonly int $ttl = 600,
        private readonly int $timeout = 10,
    ) {}

    public function send(array $subscription, string $payloadJson): PushResult
    {
        $endpoint = $subscription['endpoint'];
        if (!Validator::pushHostAllowed($endpoint)) {
            return new PushResult(0, 'endpoint non consentito');
        }
        try {
            $req = WebPush::buildRequest($subscription, $payloadJson, $this->vapid ?? Vapid::load(), $this->ttl);
            [$status, $body] = Http::postRaw($req['url'], $req['body'], $req['headers'], $this->timeout);
        } catch (HttpException $e) {
            return new PushResult(0, $e->getMessage());
        } catch (\InvalidArgumentException | \RuntimeException $e) {
            if ($e instanceof \Madovai\NotReady) {
                throw $e;
            }
            return new PushResult(0, $e->getMessage());
        }
        return new PushResult($status, $status >= 300 ? mb_substr(trim($body), 0, 200) : '');
    }
}
