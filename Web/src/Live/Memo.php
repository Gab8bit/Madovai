<?php
declare(strict_types=1);

namespace Madovai\Live;

use Madovai\Cache;

/**
 * "peek" / "put" on top of Madovai\Cache::remember, for parallel fan-outs where
 * the producer can't be a single blocking callback (we want to check every key,
 * fetch all the misses concurrently with curl_multi, then store them).
 * Built only on Cache's public API (Cache.php is shared infra and stays untouched).
 */
final class Memo
{
    /** @return array{0:mixed}|null  [value] on a fresh hit (value may be null), null on a miss */
    public static function peek(string $key, int $ttl): ?array
    {
        try {
            // maxStale 0: a failed "producer" must not resurrect an expired copy.
            return [Cache::remember($key, $ttl, static function (): never {
                throw new MemoMiss();
            }, 0)];
        } catch (MemoMiss) {
            return null;
        }
    }

    /** @param mixed $value */
    public static function put(string $key, $value): void
    {
        // ttl -1: the freshness check always fails, so the producer runs and the value is written.
        Cache::remember($key, -1, static fn() => $value);
    }
}

final class MemoMiss extends \RuntimeException {}
