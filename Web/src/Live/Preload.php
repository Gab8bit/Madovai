<?php
declare(strict_types=1);

namespace Madovai\Live;

/**
 * The shared infra declares several classes in files named after a different class
 * (HttpException lives in Http.php; BadRequest and NotReady live in Json.php), so the
 * PSR-4 style autoloader can't find them by themselves. Touching Http / Json first makes
 * them available in every context (HTTP endpoint or CLI/cron script).
 */
final class Preload
{
    public static function exceptions(): void
    {
        static $done = false;
        if (!$done) {
            class_exists(\Madovai\Http::class);
            class_exists(\Madovai\Json::class);
            $done = true;
        }
    }
}
