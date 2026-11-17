<?php
declare(strict_types=1);

/**
 * Runs due reminders. Install in cron, EVERY MINUTE:
 *   * * * * * php /path/to/Madovai-Web/bin/remind.php >> /path/to/Madovai-Web/data/remind.log 2>&1
 *
 * Options:
 *   --now="YYYY-MM-DD HH:MM"  fake clock (Rome time)
 *   --dry-run                 print what would be sent, send nothing, do not touch the state
 *   --verbose                 log every decision to stdout
 *   --stub-status             skip the live feeds and pretend the next departure is on time (testing only)
 */
require __DIR__ . '/../src/bootstrap.php';

use Madovai\Cache;
use Madovai\Config;
use Madovai\Push\FakePushSender;
use Madovai\Push\HttpPushSender;
use Madovai\Push\ReminderRunner;
use Madovai\Push\ReminderStore;
use Madovai\Rome;

$opts = getopt('', ['now:', 'dry-run', 'verbose', 'stub-status']);
$dry = isset($opts['dry-run']);
$verbose = isset($opts['verbose']) || $dry;

// One run at a time: overlapping cron invocations must never double-send.
$lock = fopen(Config::dataDir() . '/remind.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    if ($verbose) {
        echo "another run is in progress, exiting\n";
    }
    exit(0);
}

try {
    if (isset($opts['now'])) {
        $now = \DateTimeImmutable::createFromFormat('!Y-m-d H:i', (string) $opts['now'], Rome::tz());
        if ($now === false) {
            fwrite(STDERR, "--now deve essere \"YYYY-MM-DD HH:MM\"\n");
            exit(2);
        }
    } else {
        $now = Rome::now();
    }

    $log = static function (string $m) use ($now, $verbose): void {
        if ($verbose) {
            echo '[' . $now->format('Y-m-d H:i') . "] $m\n";
        } elseif (str_contains($m, 'error') || str_contains($m, 'failed') || str_contains($m, 'giving up')) {
            fwrite(STDERR, '[' . $now->format('Y-m-d H:i') . "] $m\n");
        }
    };

    if (isset($opts['stub-status'])) {
        $fetch = static fn(array $r): array => ['time' => $now->format('H:i'), 'delayMinutes' => 0, 'isCancelled' => false, 'nextUsefulTime' => null];
    } elseif (class_exists(\Madovai\Live\DepartureStatus::class)) {
        $fetch = static fn(array $r): ?array => \Madovai\Live\DepartureStatus::forReminder($r);
    } else {
        $fetch = static function (array $r) use ($log): ?array {
            $log('error: Madovai\\Live\\DepartureStatus not available');
            return null;
        };
    }

    $sender = $dry
        ? new FakePushSender(static function (array $sub, string $payload): void {
            echo "  DRY-RUN push -> " . substr($sub['endpoint'], 0, 60) . "...: $payload\n";
        })
        : new HttpPushSender();

    $store = new ReminderStore();
    $runner = new ReminderRunner($store, $fetch, $sender, $log, !$dry);
    $stats = $runner->run($now);
    if ($verbose || $stats['due'] > 0) {
        $log('done: ' . json_encode($stats));
    }

    // Housekeeping every 10 minutes: stale subscriptions (>90 days without any sign of life) and old cache files.
    if (!$dry && (int) $now->format('i') % 10 === 0) {
        $n = $store->pruneStale($now->getTimestamp());
        if ($n > 0) {
            $log("pruned $n stale subscriptions");
        }
        Cache::prune();
    }
} catch (\Throwable $e) {
    fwrite(STDERR, '[remind] ' . $e::class . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine() . "\n");
    exit(1);
} finally {
    flock($lock, LOCK_UN);
}
