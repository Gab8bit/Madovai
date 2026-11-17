<?php
declare(strict_types=1);

namespace Madovai\Push;

interface PushSender
{
    /**
     * @param array{endpoint:string,keys:array{p256dh:string,auth:string}} $subscription
     * @param string $payloadJson plaintext JSON ({"title","body","tag","url"})
     */
    public function send(array $subscription, string $payloadJson): PushResult;
}
