<?php
declare(strict_types=1);

namespace Madovai\Push;

// BadRequest/NotReady live in Json.php (not autoloadable by class name): make sure they exist before we throw them.
require_once __DIR__ . "/../Json.php";

use Madovai\Db;
use Madovai\NotReady;

/**
 * Subscriptions + reminders in data/state.sqlite (schema created/migrated lazily, idempotent).
 *
 * subscriptions(id = sha256(endpoint), endpoint, p256dh, auth, created_at, updated_at, last_ok_at, last_test_at)
 * reminders(sub_id, id, json, last_done_date yyyymmdd Rome, retry_count, retry_at, retry_date, PK(sub_id,id))
 *
 * `retry_date` (not in the original sketch) pins a retry chain to the Rome day it started on,
 * so a chain interrupted by midnight can never wedge a reminder.
 */
final class ReminderStore
{
    public const MAX_SUBSCRIPTIONS = 5000;
    public const SCHEMA_VERSION = 1;

    private \PDO $db;

    public function __construct(?\PDO $db = null)
    {
        $this->db = $db ?? Db::state();
        self::migrate($this->db);
    }

    public static function migrate(\PDO $db): void
    {
        $v = (int) $db->query('PRAGMA user_version')->fetchColumn();
        if ($v >= self::SCHEMA_VERSION) {
            return;
        }
        $db->exec('BEGIN IMMEDIATE');
        try {
            $v = (int) $db->query('PRAGMA user_version')->fetchColumn();
            if ($v < 1) {
                $db->exec('CREATE TABLE IF NOT EXISTS subscriptions (
                    id TEXT PRIMARY KEY,
                    endpoint TEXT NOT NULL,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    last_ok_at INTEGER,
                    last_test_at INTEGER
                )');
                $db->exec('CREATE TABLE IF NOT EXISTS reminders (
                    id TEXT NOT NULL,
                    sub_id TEXT NOT NULL,
                    json TEXT NOT NULL,
                    last_done_date INTEGER NOT NULL DEFAULT 0,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    retry_at INTEGER NOT NULL DEFAULT 0,
                    retry_date INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (sub_id, id)
                )');
                $db->exec('CREATE INDEX IF NOT EXISTS reminders_done ON reminders(last_done_date)');
            }
            $db->exec('PRAGMA user_version = ' . self::SCHEMA_VERSION);
            $db->exec('COMMIT');
        } catch (\Throwable $e) {
            $db->exec('ROLLBACK');
            throw $e;
        }
    }

    public function pdo(): \PDO
    {
        return $this->db;
    }

    public static function subId(string $endpoint): string
    {
        return hash('sha256', $endpoint);
    }

    /**
     * Canonical signature of what makes a reminder fire: weekdays/hour/minute/source.
     * Equal signatures => state (done today / retries) is preserved on re-sync.
     *
     * @param array<string,mixed> $r
     */
    public static function scheduleSignature(array $r): string
    {
        $days = array_values(array_unique(array_map('intval', (array) ($r['weekdays'] ?? []))));
        sort($days);
        $src = (array) ($r['source'] ?? []);
        ksort($src);
        return sha1(json_encode([$days, (int) ($r['hour'] ?? -1), (int) ($r['minute'] ?? -1), $src], JSON_UNESCAPED_UNICODE));
    }

    /**
     * Inserts/updates a subscription (keeps created_at / last_ok_at). Must run inside a transaction
     * when combined with other writes. Throws NotReady (HTTP 503) when the table is full.
     *
     * @param array{endpoint:string,keys:array{p256dh:string,auth:string}} $sub
     */
    public function upsertSubscription(array $sub, int $now): string
    {
        $id = self::subId($sub['endpoint']);
        $exists = $this->db->prepare('SELECT 1 FROM subscriptions WHERE id = ?');
        $exists->execute([$id]);
        if ($exists->fetchColumn() === false) {
            $count = (int) $this->db->query('SELECT COUNT(*) FROM subscriptions')->fetchColumn();
            if ($count >= self::MAX_SUBSCRIPTIONS) {
                throw new NotReady('Servizio promemoria al completo, riprova più tardi');
            }
            $this->db->prepare('INSERT INTO subscriptions (id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?,?,?,?,?,?)')
                ->execute([$id, $sub['endpoint'], $sub['keys']['p256dh'], $sub['keys']['auth'], $now, $now]);
        } else {
            $this->db->prepare('UPDATE subscriptions SET p256dh = ?, auth = ?, updated_at = ? WHERE id = ?')
                ->execute([$sub['keys']['p256dh'], $sub['keys']['auth'], $now, $id]);
        }
        return $id;
    }

    /**
     * Replaces the whole reminder list of a subscription in ONE transaction.
     * Reminders whose id AND schedule are unchanged keep their done/retry state; edited or new ones start
     * clean, except that a reminder whose time already passed earlier today is marked as done for today
     * (no retroactive firing).
     *
     * @param array{endpoint:string,keys:array{p256dh:string,auth:string}} $sub
     * @param list<array<string,mixed>> $reminders validated
     */
    public function replaceReminders(array $sub, array $reminders, \DateTimeImmutable $now): int
    {
        $ts = $now->getTimestamp();
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $subId = $this->upsertSubscription($sub, $ts);

            $old = [];
            $st = $this->db->prepare('SELECT id, json, last_done_date, retry_count, retry_at, retry_date FROM reminders WHERE sub_id = ?');
            $st->execute([$subId]);
            foreach ($st->fetchAll() as $row) {
                $old[$row['id']] = $row;
            }
            $this->db->prepare('DELETE FROM reminders WHERE sub_id = ?')->execute([$subId]);

            $ins = $this->db->prepare('INSERT INTO reminders (id, sub_id, json, last_done_date, retry_count, retry_at, retry_date) VALUES (?,?,?,?,?,?,?)');
            foreach ($reminders as $r) {
                $json = json_encode($r, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                $prev = $old[$r['id']] ?? null;
                $prevR = $prev !== null ? json_decode((string) $prev['json'], true) : null;
                if ($prev !== null && is_array($prevR) && self::scheduleSignature($prevR) === self::scheduleSignature($r)) {
                    $state = [(int) $prev['last_done_date'], (int) $prev['retry_count'], (int) $prev['retry_at'], (int) $prev['retry_date']];
                } else {
                    $state = [self::initialDoneDate($r, $now), 0, 0, 0];
                }
                $ins->execute([$r['id'], $subId, $json, ...$state]);
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $e) {
            $this->db->exec('ROLLBACK');
            throw $e;
        }
        return count($reminders);
    }

    /**
     * last_done_date for a freshly saved/edited reminder: today when it is scheduled for today
     * at a minute that is already over (it must not fire retroactively), otherwise 0.
     * A reminder saved for the current minute still fires.
     *
     * @param array<string,mixed> $r
     */
    public static function initialDoneDate(array $r, \DateTimeImmutable $now): int
    {
        $weekday = (int) $now->format('w') + 1;
        if (!in_array($weekday, array_map('intval', $r['weekdays']), true)) {
            return 0;
        }
        $minuteStart = $now->setTime((int) $now->format('G'), (int) $now->format('i'), 0)->getTimestamp();
        $sched = $now->setTime((int) $r['hour'], (int) $r['minute'], 0)->getTimestamp();
        return $sched < $minuteStart ? (int) $now->format('Ymd') : 0;
    }

    public function deleteSubscription(string $subId): void
    {
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $this->db->prepare('DELETE FROM reminders WHERE sub_id = ?')->execute([$subId]);
            $this->db->prepare('DELETE FROM subscriptions WHERE id = ?')->execute([$subId]);
            $this->db->exec('COMMIT');
        } catch (\Throwable $e) {
            $this->db->exec('ROLLBACK');
            throw $e;
        }
    }

    /** @return array{endpoint:string,keys:array{p256dh:string,auth:string}}|null */
    public function subscription(string $subId): ?array
    {
        $st = $this->db->prepare('SELECT endpoint, p256dh, auth FROM subscriptions WHERE id = ?');
        $st->execute([$subId]);
        $r = $st->fetch();
        return $r ? ['endpoint' => $r['endpoint'], 'keys' => ['p256dh' => $r['p256dh'], 'auth' => $r['auth']]] : null;
    }

    public function touchOk(string $subId, int $ts): void
    {
        $this->db->prepare('UPDATE subscriptions SET last_ok_at = ? WHERE id = ?')->execute([$ts, $subId]);
    }

    /**
     * Rate limit for push-test: returns 0 and records the attempt when allowed,
     * otherwise the number of seconds to wait.
     */
    public function claimTest(string $subId, int $ts, int $minInterval = 30): int
    {
        $st = $this->db->prepare('UPDATE subscriptions SET last_test_at = ? WHERE id = ? AND (last_test_at IS NULL OR last_test_at <= ?)');
        $st->execute([$ts, $subId, $ts - $minInterval]);
        if ($st->rowCount() > 0) {
            return 0;
        }
        $q = $this->db->prepare('SELECT last_test_at FROM subscriptions WHERE id = ?');
        $q->execute([$subId]);
        $last = (int) $q->fetchColumn();
        return max(1, $minInterval - ($ts - $last));
    }

    /**
     * Reminders that haven't completed today, with their subscription (the runner applies the exact due test).
     *
     * @return list<array<string,mixed>> [{sub_id,id,json,reminder,last_done_date,retry_count,retry_at,retry_date,subscription}]
     */
    public function candidates(int $dateInt): array
    {
        $st = $this->db->prepare('SELECT r.sub_id, r.id, r.json, r.last_done_date, r.retry_count, r.retry_at, r.retry_date,
                s.endpoint, s.p256dh, s.auth
            FROM reminders r JOIN subscriptions s ON s.id = r.sub_id
            WHERE r.last_done_date != ?');
        $st->execute([$dateInt]);
        $out = [];
        foreach ($st->fetchAll() as $row) {
            $rem = json_decode((string) $row['json'], true);
            if (!is_array($rem)) {
                continue;
            }
            $out[] = [
                'sub_id' => $row['sub_id'],
                'id' => $row['id'],
                'json' => $row['json'],
                'reminder' => $rem,
                'last_done_date' => (int) $row['last_done_date'],
                'retry_count' => (int) $row['retry_count'],
                'retry_at' => (int) $row['retry_at'],
                'retry_date' => (int) $row['retry_date'],
                'subscription' => ['endpoint' => $row['endpoint'], 'keys' => ['p256dh' => $row['p256dh'], 'auth' => $row['auth']]],
            ];
        }
        return $out;
    }

    /** @return list<array<string,mixed>> raw rows (tests / diagnostics) */
    public function reminderRows(string $subId): array
    {
        $st = $this->db->prepare('SELECT id, json, last_done_date, retry_count, retry_at, retry_date FROM reminders WHERE sub_id = ? ORDER BY id');
        $st->execute([$subId]);
        return $st->fetchAll();
    }

    /** Guarded by the stored json so a concurrent re-sync that edited the reminder is never overwritten. */
    public function markDone(string $subId, string $id, string $json, int $dateInt): void
    {
        $this->db->prepare('UPDATE reminders SET last_done_date = ?, retry_count = 0, retry_at = 0, retry_date = 0 WHERE sub_id = ? AND id = ? AND json = ?')
            ->execute([$dateInt, $subId, $id, $json]);
    }

    public function markRetry(string $subId, string $id, string $json, int $count, int $retryAt, int $dateInt): void
    {
        $this->db->prepare('UPDATE reminders SET retry_count = ?, retry_at = ?, retry_date = ? WHERE sub_id = ? AND id = ? AND json = ?')
            ->execute([$count, $retryAt, $dateInt, $subId, $id, $json]);
    }

    /** Removes subscriptions with no sign of life (client sync or successful push) for $days days. */
    public function pruneStale(int $now, int $days = 90): int
    {
        $cutoff = $now - $days * 86400;
        $st = $this->db->prepare('SELECT id FROM subscriptions WHERE MAX(created_at, updated_at, COALESCE(last_ok_at, 0)) < CAST(? AS INTEGER)');
        $st->execute([$cutoff]);
        $n = 0;
        foreach ($st->fetchAll(\PDO::FETCH_COLUMN) as $id) {
            $this->deleteSubscription((string) $id);
            $n++;
        }
        $this->db->exec('DELETE FROM reminders WHERE sub_id NOT IN (SELECT id FROM subscriptions)');
        return $n;
    }
}
