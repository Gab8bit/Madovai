<?php
declare(strict_types=1);

namespace Madovai;

/**
 * Tiny file cache with a per-key lock, so that when N visitors hit the same
 * endpoint at once only ONE request goes upstream (Cotral/Roma Mobilità are
 * not ours to hammer) and the rest read the fresh copy.
 *
 * If the producer fails and an older copy exists, the stale copy is served
 * (better a few-seconds-old bus time than an error).
 */
final class Cache
{
    /**
     * @template T
     * @param callable():T $producer
     * @return T
     */
    public static function remember(string $key, int $ttlSeconds, callable $producer, int $maxStaleSeconds = 300)
    {
        $dir = Config::dataDir() . '/cache';
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        $file = $dir . '/' . sha1($key) . '.cache';

        $fresh = self::read($file, $ttlSeconds);
        if ($fresh !== null) {
            return $fresh[0];
        }

        $lock = fopen($file . '.lock', 'c');
        if ($lock !== false) {
            flock($lock, LOCK_EX);
            // Someone else may have refreshed it while we waited for the lock.
            $fresh = self::read($file, $ttlSeconds);
            if ($fresh !== null) {
                flock($lock, LOCK_UN);
                fclose($lock);
                return $fresh[0];
            }
        }

        try {
            $value = $producer();
            $tmp = $file . '.' . getmypid() . '.tmp';
            file_put_contents($tmp, serialize([$value]));
            rename($tmp, $file);
            return $value;
        } catch (\Throwable $e) {
            $stale = self::read($file, $maxStaleSeconds);
            if ($stale !== null) {
                return $stale[0];
            }
            throw $e;
        } finally {
            if ($lock !== false) {
                flock($lock, LOCK_UN);
                fclose($lock);
            }
        }
    }

    /** @return array{0:mixed}|null  one-element array so a cached `null` is distinguishable from a miss */
    private static function read(string $file, int $maxAge): ?array
    {
        $mtime = @filemtime($file);
        if ($mtime === false || time() - $mtime > $maxAge) {
            return null;
        }
        $raw = @file_get_contents($file);
        if ($raw === false) {
            return null;
        }
        $data = @unserialize($raw);
        return is_array($data) && array_key_exists(0, $data) ? $data : null;
    }

    /** Removes cache files older than $maxAge seconds (called opportunistically by cron). */
    public static function prune(int $maxAge = 3600): void
    {
        $dir = Config::dataDir() . '/cache';
        foreach (glob($dir . '/*') ?: [] as $f) {
            if (is_file($f) && time() - (int) @filemtime($f) > $maxAge) {
                @unlink($f);
            }
        }
    }
}
