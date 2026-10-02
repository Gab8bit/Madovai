<?php
declare(strict_types=1);

namespace Madovai\Push;

/** Outcome of one push delivery attempt. status 0 = transport failure (DNS, timeout, TLS…). */
final class PushResult
{
    public function __construct(
        public readonly int $status,
        public readonly string $error = '',
    ) {}

    /** The push service accepted the message (201 Created per RFC 8030; some use 200/202). */
    public function ok(): bool
    {
        return $this->status >= 200 && $this->status < 300;
    }

    /** 404/410: the subscription no longer exists and must be dropped. */
    public function gone(): bool
    {
        return $this->status === 404 || $this->status === 410;
    }
}
