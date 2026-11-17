<?php
declare(strict_types=1);

namespace Madovai\Push;

/** Test / dry-run sender: records every message instead of delivering it. */
final class FakePushSender implements PushSender
{
    /** @var list<array{subscription:array<string,mixed>,payload:array<string,mixed>|null,raw:string}> */
    public array $sent = [];
    /** @var list<int> statuses returned by successive calls (default 201 once exhausted) */
    public array $statuses = [];
    /** @var callable|null fn(array $subscription, string $payloadJson): void  (e.g. print for --dry-run) */
    private $onSend;

    public function __construct(?callable $onSend = null)
    {
        $this->onSend = $onSend;
    }

    public function send(array $subscription, string $payloadJson): PushResult
    {
        $this->sent[] = ['subscription' => $subscription, 'payload' => json_decode($payloadJson, true), 'raw' => $payloadJson];
        if ($this->onSend !== null) {
            ($this->onSend)($subscription, $payloadJson);
        }
        $status = $this->statuses === [] ? 201 : array_shift($this->statuses);
        return new PushResult($status, $status === 0 ? 'fake transport error' : '');
    }
}
