<?php
declare(strict_types=1);

namespace Madovai\Push;

/**
 * Server-side equivalent of iOS `ReminderScheduler.run`: invoked every minute by cron,
 * finds due reminders, fetches the next departure, sends the push.
 *
 * Retry policy (identical to iOS): fetch failure or no data => NO notification, retry in 120 s;
 * the 15th failed attempt gives up silently until the next scheduled day.
 */
final class ReminderRunner
{
    public const GRACE_SECONDS = 300;
    public const RETRY_INTERVAL = 120;
    public const MAX_ATTEMPTS = 15;
    /** A retry chain never outlives this window after the scheduled time (a "next bus" push must stay timely). */
    public const RETRY_WINDOW = 3600;

    /** @var callable(array<string,mixed>):?array<string,mixed> */
    private $fetch;
    /** @var callable(string):void */
    private $log;

    /**
     * @param callable(array<string,mixed>):?array<string,mixed> $fetch  DepartureStatus::forReminder-compatible
     * @param callable(string):void|null $log
     */
    public function __construct(
        private readonly ReminderStore $store,
        callable $fetch,
        private readonly PushSender $sender,
        ?callable $log = null,
        private readonly bool $persist = true,
    ) {
        $this->fetch = $fetch;
        $this->log = $log ?? static function (string $m): void {};
    }

    /**
     * Pure due test (see class doc). `$row` is a ReminderStore::candidates() row.
     *
     * @param array<string,mixed> $row
     */
    public static function isDue(array $row, \DateTimeImmutable $now): bool
    {
        $r = $row['reminder'];
        $today = (int) $now->format('Ymd');
        // 1 = Sunday … 7 = Saturday, as Apple's Calendar.
        $weekday = (int) $now->format('w') + 1;
        if (!in_array($weekday, array_map('intval', $r['weekdays']), true)) {
            return false;
        }
        if ((int) $row['last_done_date'] === $today) {
            return false;
        }
        $ts = $now->getTimestamp();
        $sched = $now->setTime((int) $r['hour'], (int) $r['minute'], 0)->getTimestamp();

        // A retry chain only counts on the day it started.
        $retries = (int) $row['retry_date'] === $today ? (int) $row['retry_count'] : 0;
        if ($retries > 0) {
            return $retries < self::MAX_ATTEMPTS && $ts >= (int) $row['retry_at'] && $ts < $sched + self::RETRY_WINDOW;
        }
        return $ts >= $sched && $ts < $sched + self::GRACE_SECONDS;
    }

    /**
     * @return array{due:int,sent:int,failed:int,gone:int,gaveUp:int}
     */
    public function run(\DateTimeImmutable $now): array
    {
        $today = (int) $now->format('Ymd');
        $ts = $now->getTimestamp();
        $stats = ['due' => 0, 'sent' => 0, 'failed' => 0, 'gone' => 0, 'gaveUp' => 0];
        $statusMemo = []; // same source asked twice in a run -> one upstream fetch
        $deadSubs = [];

        foreach ($this->store->candidates($today) as $row) {
            if (isset($deadSubs[$row['sub_id']]) || !self::isDue($row, $now)) {
                continue;
            }
            $stats['due']++;
            $rem = $row['reminder'];
            $label = "{$rem['id']} ({$rem['stopName']} {$rem['hour']}:" . sprintf('%02d', $rem['minute']) . ')';

            $memoKey = json_encode($rem['source']);
            if (!array_key_exists($memoKey, $statusMemo)) {
                try {
                    $statusMemo[$memoKey] = ($this->fetch)($rem);
                } catch (\Throwable $e) {
                    ($this->log)("fetch error for $label: " . $e->getMessage());
                    $statusMemo[$memoKey] = null;
                }
            }
            $status = $statusMemo[$memoKey];

            $failure = null;
            if ($status === null) {
                $failure = 'no data';
            } else {
                $payload = ReminderNotifier::json(ReminderNotifier::payload($rem, $status));
                $result = $this->sender->send($row['subscription'], $payload);
                if ($result->ok()) {
                    $stats['sent']++;
                    ($this->log)("sent $label: $payload");
                    if ($this->persist) {
                        $this->store->touchOk($row['sub_id'], $ts);
                        $this->store->markDone($row['sub_id'], $row['id'], $row['json'], $today);
                    }
                    continue;
                }
                if ($result->gone()) {
                    $stats['gone']++;
                    $deadSubs[$row['sub_id']] = true;
                    ($this->log)("subscription gone ({$result->status}) — removing {$row['sub_id']}");
                    if ($this->persist) {
                        $this->store->deleteSubscription($row['sub_id']);
                    }
                    continue;
                }
                $failure = "push failed: HTTP {$result->status} {$result->error}";
            }

            // Failure: same policy as iOS (attempt counter, 2 min retry, give up at 15).
            $attempt = ((int) $row['retry_date'] === $today ? (int) $row['retry_count'] : 0) + 1;
            $stats['failed']++;
            if ($attempt < self::MAX_ATTEMPTS) {
                ($this->log)("$failure for $label — attempt $attempt, retry in " . self::RETRY_INTERVAL . ' s');
                if ($this->persist) {
                    $this->store->markRetry($row['sub_id'], $row['id'], $row['json'], $attempt, $ts + self::RETRY_INTERVAL, $today);
                }
            } else {
                $stats['gaveUp']++;
                ($this->log)("$failure for $label — attempt $attempt, giving up until the next scheduled day");
                if ($this->persist) {
                    $this->store->markDone($row['sub_id'], $row['id'], $row['json'], $today);
                }
            }
        }
        return $stats;
    }
}
