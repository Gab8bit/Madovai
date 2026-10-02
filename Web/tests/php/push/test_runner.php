<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

use Madovai\Db;
use Madovai\Push\B64;
use Madovai\Push\Ec;
use Madovai\Push\FakePushSender;
use Madovai\Push\ReminderRunner;
use Madovai\Push\ReminderStore;

$store = new ReminderStore();
$pdo = Db::state();

function mkSub(string $name = 'a'): array
{
    $k = Ec::generate();
    return ['endpoint' => "https://push.example.com/$name/" . bin2hex(random_bytes(4)), 'keys' => ['p256dh' => B64::enc($k['public']), 'auth' => B64::enc(random_bytes(16))]];
}
function mkRem(string $id, array $days, int $h, int $m, array $source = ['type' => 'cotralBus', 'poleCode' => '1021'], string $name = 'Acilia'): array
{
    return ['id' => $id, 'stopName' => $name, 'weekdays' => $days, 'hour' => $h, 'minute' => $m, 'source' => $source];
}
function dueRow(array $rem, int $done = 0, int $rc = 0, int $rat = 0, int $rd = 0): array
{
    return ['reminder' => $rem, 'last_done_date' => $done, 'retry_count' => $rc, 'retry_at' => $rat, 'retry_date' => $rd];
}
$ok = static fn(array $r): array => ['time' => '07:45', 'delayMinutes' => 2, 'isCancelled' => false, 'nextUsefulTime' => null];

// 2026-10-04 is a Sunday, 2026-10-05 a Monday.
echo "isDue (table)\n";
$mon = mkRem('m', [2], 7, 30);
$table = [
    // [name, row, now, expected]
    ['Monday 07:29 -> not yet', dueRow($mon), '2026-10-05 07:29', false],
    ['Monday 07:30 -> due', dueRow($mon), '2026-10-05 07:30', true],
    ['Monday 07:34 (grace) -> due', dueRow($mon), '2026-10-05 07:34', true],
    ['Monday 07:35 (grace over) -> not due', dueRow($mon), '2026-10-05 07:35', false],
    ['Monday done today -> not due', dueRow($mon, 20261005), '2026-10-05 07:30', false],
    ['Monday done last week -> due', dueRow($mon, 20260928), '2026-10-05 07:30', true],
    ['Tuesday -> not due', dueRow($mon), '2026-10-06 07:30', false],
    ['Sunday=1: weekdays [1] fires on Sunday', dueRow(mkRem('s', [1], 7, 30)), '2026-10-04 07:30', true],
    ['Sunday=1: weekdays [1] not on Monday', dueRow(mkRem('s', [1], 7, 30)), '2026-10-05 07:30', false],
    ['Sunday=1: weekdays [2..7] not on Sunday', dueRow(mkRem('s', [2, 3, 4, 5, 6, 7], 7, 30)), '2026-10-04 07:30', false],
    ['Saturday=7: weekdays [7] fires on Saturday', dueRow(mkRem('s', [7], 7, 30)), '2026-10-03 07:30', true],
    ['Saturday=7: weekdays [7] not on Friday', dueRow(mkRem('s', [7], 7, 30)), '2026-10-02 07:30', false],
    ['Friday=6', dueRow(mkRem('s', [6], 7, 30)), '2026-10-02 07:30', true],
    ['multi-day set', dueRow(mkRem('s', [2, 4, 6], 7, 30)), '2026-10-07 07:31', true],
    ['midnight reminder 00:00', dueRow(mkRem('s', [2], 0, 0)), '2026-10-05 00:02', true],
    ['23:59 reminder', dueRow(mkRem('s', [2], 23, 59)), '2026-10-05 23:59', true],
    // retry branch
    ['retry 3: before retry_at -> no', dueRow($mon, 0, 3, rome('2026-10-05 07:40')->getTimestamp(), 20261005), '2026-10-05 07:39', false],
    ['retry 3: at retry_at -> due', dueRow($mon, 0, 3, rome('2026-10-05 07:40')->getTimestamp(), 20261005), '2026-10-05 07:40', true],
    ['retry 3: long after retry_at but inside window -> due', dueRow($mon, 0, 3, rome('2026-10-05 07:40')->getTimestamp(), 20261005), '2026-10-05 08:10', true],
    ['retry 3: past retry window -> no', dueRow($mon, 0, 3, rome('2026-10-05 07:40')->getTimestamp(), 20261005), '2026-10-05 08:31', false],
    ['retry 14 -> due', dueRow($mon, 0, 14, rome('2026-10-05 07:58')->getTimestamp(), 20261005), '2026-10-05 07:58', true],
    ['retry 15 -> never due', dueRow($mon, 0, 15, rome('2026-10-05 07:58')->getTimestamp(), 20261005), '2026-10-05 08:00', false],
    ['retry>0 past grace but retry_at reached -> due', dueRow($mon, 0, 1, rome('2026-10-05 07:42')->getTimestamp(), 20261005), '2026-10-05 07:42', true],
    ['retry>0 inside grace but retry_at not reached -> no (no fresh attempt)', dueRow($mon, 0, 1, rome('2026-10-05 07:32')->getTimestamp(), 20261005), '2026-10-05 07:31', false],
    ['stale retry state from yesterday is ignored: fresh window works', dueRow($mon, 0, 7, rome('2026-09-28 07:50')->getTimestamp(), 20260928), '2026-10-05 07:30', true],
    ['stale retry state from yesterday is ignored: no phantom retry', dueRow($mon, 0, 7, rome('2026-09-28 07:50')->getTimestamp(), 20260928), '2026-10-05 07:50', false],
    ['retry state but done today -> no', dueRow($mon, 20261005, 3, 0, 20261005), '2026-10-05 07:50', false],
];
foreach ($table as [$name, $row, $now, $expected]) {
    same($expected, ReminderRunner::isDue($row, rome($now)), $name);
}

echo "runner: success path\n";
$sender = new FakePushSender();
$fetches = 0;
$fetch = function (array $r) use (&$fetches, $ok) {
    $fetches++;
    return $ok($r);
};
$subA = mkSub('a');
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$runner = new ReminderRunner($store, $fetch, $sender);
$s = $runner->run(rome('2026-10-05 07:29'));
same(0, $s['due'], '07:29 nothing due');
$s = $runner->run(rome('2026-10-05 07:30'));
same(1, $s['sent'], '07:30 sent');
same('Prossimo bus alle 07:45', $sender->sent[0]['payload']['title'] ?? null, 'title in push payload');
same('r1', $sender->sent[0]['payload']['tag'] ?? null, 'tag in push payload');
same($subA['endpoint'], $sender->sent[0]['subscription']['endpoint'], 'sent to the registered endpoint');
$runner->run(rome('2026-10-05 07:31'));
$runner->run(rome('2026-10-05 07:32'));
same(1, count($sender->sent), 'no second push the same day');
same(1, $fetches, 'one fetch');
$rows = $store->reminderRows(ReminderStore::subId($subA['endpoint']));
same(20261005, (int) $rows[0]['last_done_date'], 'last_done_date = today');
same(0, (int) $rows[0]['retry_count'], 'retry_count reset');
$runner->run(rome('2026-10-12 07:31'));
same(2, count($sender->sent), 'fires again next Monday');
$st = $pdo->query('SELECT last_ok_at FROM subscriptions')->fetchColumn();
check($st !== null && (int) $st > 0, 'last_ok_at recorded');

echo "runner: retry policy\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$sender = new FakePushSender();
$mode = 'fail';
$fetches = 0;
$fetch = function (array $r) use (&$fetches, &$mode, $ok) {
    $fetches++;
    return $mode === 'fail' ? null : ($mode === 'throw' ? throw new \RuntimeException('boom') : $ok($r));
};
$subA = mkSub('a');
$subId = ReminderStore::subId($subA['endpoint']);
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$runner = new ReminderRunner($store, $fetch, $sender);
$runner->run(rome('2026-10-05 07:30'));
$row = $store->reminderRows($subId)[0];
same(0, count($sender->sent), 'failure: NO notification');
same(1, (int) $row['retry_count'], 'failure: retry_count 1');
same(rome('2026-10-05 07:32')->getTimestamp(), (int) $row['retry_at'], 'failure: retry in 120 s');
same(0, (int) $row['last_done_date'], 'failure: not done');
$runner->run(rome('2026-10-05 07:31'));
same(1, $fetches, '07:31 no new attempt (waiting for retry_at)');
$mode = 'ok';
$runner->run(rome('2026-10-05 07:32'));
same(1, count($sender->sent), 'retry at 07:32 succeeds -> push');
$row = $store->reminderRows($subId)[0];
same([20261005, 0], [(int) $row['last_done_date'], (int) $row['retry_count']], 'success after retry: done, counter reset');

// 15 attempts then silent give-up; cron runs every minute
$pdo->exec('DELETE FROM reminders');
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$sender = new FakePushSender();
$mode = 'fail';
$fetches = 0;
$runner = new ReminderRunner($store, $fetch, $sender);
for ($min = 0; $min <= 150; $min++) {
    $runner->run(rome('2026-10-05 07:30')->modify("+$min minutes"));
}
same(15, $fetches, 'exactly 15 attempts in total');
same(0, count($sender->sent), 'give-up is silent (no notification)');
$row = $store->reminderRows($subId)[0];
same([20261005, 0], [(int) $row['last_done_date'], (int) $row['retry_count']], 'after 15th failure: done for today, counter reset');
$fetches = 0;
$runner->run(rome('2026-10-12 07:30'));
same(1, $fetches, 'next scheduled day tries again');
$fetches = 0;
$mode = 'throw';
$pdo->exec('UPDATE reminders SET last_done_date = 0, retry_count = 0');
$runner->run(rome('2026-10-12 07:31'));
$row = $store->reminderRows($subId)[0];
same(1, (int) $row['retry_count'], 'exception in fetcher counts as a failed attempt');

echo "runner: midnight-crossing retry chain\n";
$pdo->exec('DELETE FROM reminders');
$store->replaceReminders($subA, [mkRem('r1', [1, 2, 3, 4, 5, 6, 7], 23, 59)], rome('2026-10-05 20:00'));
$mode = 'fail';
$sender = new FakePushSender();
$runner = new ReminderRunner($store, $fetch, $sender);
$runner->run(rome('2026-10-05 23:59'));
$fetches = 0;
$runner->run(rome('2026-10-06 00:01'));
same(0, $fetches, 'retry chain does not continue after midnight');
$mode = 'ok';
$runner->run(rome('2026-10-06 23:59'));
same(1, count($sender->sent), 'next day fires normally (state not wedged)');

echo "runner: push failures\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$subA = mkSub('a');
$subB = mkSub('b');
$idA = ReminderStore::subId($subA['endpoint']);
$idB = ReminderStore::subId($subB['endpoint']);
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30), mkRem('r2', [2], 7, 30, ['type' => 'atacStop', 'stopId' => '5'])], rome('2026-10-05 06:00'));
$store->replaceReminders($subB, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$sender = new FakePushSender();
$sender->statuses = [410]; // first send (sub A, r1) -> gone
$fetch = $ok;
$runner = new ReminderRunner($store, $fetch, $sender);
$s = $runner->run(rome('2026-10-05 07:30'));
same(1, $s['gone'], '410 -> subscription gone');
same(null, $store->subscription($idA), 'gone subscription deleted');
same([], $store->reminderRows($idA), 'gone subscription reminders deleted');
same(1, count($store->reminderRows($idB)), 'other subscription untouched');
same(1, $s['sent'], 'other subscription still served in the same run');
same(2, count($sender->sent), 'sub A second reminder skipped after gone (2 sends: A.r1 + B.r1)');

$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$sender = new FakePushSender();
$sender->statuses = [500, 0, 404];
$runner = new ReminderRunner($store, $ok, $sender);
$runner->run(rome('2026-10-05 07:30'));
$row = $store->reminderRows($idA)[0];
same([0, 1], [(int) $row['last_done_date'], (int) $row['retry_count']], '5xx send failure -> retry policy (attempt 1)');
$runner->run(rome('2026-10-05 07:32'));
$row = $store->reminderRows($idA)[0];
same(2, (int) $row['retry_count'], 'transport error (status 0) -> attempt 2');
$runner->run(rome('2026-10-05 07:34'));
same(null, $store->subscription($idA), '404 -> subscription removed');

echo "runner: same-source fetch is shared\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30), mkRem('r2', [2], 7, 30, name: 'Acilia bis')], rome('2026-10-05 06:00'));
$store->replaceReminders($subB, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$sender = new FakePushSender();
$fetches = 0;
$mode = 'ok';
$runner = new ReminderRunner($store, $fetch = function (array $r) use (&$fetches, $ok) {
    $fetches++;
    return $ok($r);
}, $sender);
$s = $runner->run(rome('2026-10-05 07:30'));
same([3, 1], [$s['sent'], $fetches], '3 reminders, 1 upstream fetch for the identical source');

echo "runner: dry-run does not touch state\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$store->replaceReminders($subA, [mkRem('r1', [2], 7, 30)], rome('2026-10-05 06:00'));
$sender = new FakePushSender();
$runner = new ReminderRunner($store, $ok, $sender, null, false);
$runner->run(rome('2026-10-05 07:30'));
$runner->run(rome('2026-10-05 07:31'));
same(2, count($sender->sent), 'persist=false: still due on the next run');
same(0, (int) $store->reminderRows($idA)[0]['last_done_date'], 'persist=false: state untouched');

echo "store: replace preserves / resets state\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$subA = mkSub('a');
$idA = ReminderStore::subId($subA['endpoint']);
$list = [mkRem('r1', [2], 7, 30), mkRem('r2', [2], 7, 45), mkRem('r3', [2], 12, 0)];
$store->replaceReminders($subA, $list, rome('2026-10-05 06:00'));
$sender = new FakePushSender();
$runner = new ReminderRunner($store, $ok, $sender);
$runner->run(rome('2026-10-05 07:30'));
same(['r1'], array_map(fn($p) => $p['payload']['tag'], $sender->sent), 'r1 fired at 07:30');
// user edits an unrelated reminder (r3 renamed) at 07:32 and re-syncs the whole list
$list[2]['stopName'] = 'Altro nome';
$store->replaceReminders($subA, $list, rome('2026-10-05 07:32'));
$runner->run(rome('2026-10-05 07:33'));
same(1, count($sender->sent), 'editing an unrelated reminder does NOT re-fire r1');
$rows = array_column($store->reminderRows($idA), null, 'id');
same(20261005, (int) $rows['r1']['last_done_date'], 'r1 state preserved');
same('Altro nome', json_decode($rows['r3']['json'], true)['stopName'], 'r3 json updated (name change)');
// cosmetic change of r1 (name) keeps state too
$list[0]['stopName'] = 'Acilia (nuovo nome)';
$store->replaceReminders($subA, $list, rome('2026-10-05 07:34'));
same(20261005, (int) array_column($store->reminderRows($idA), null, 'id')['r1']['last_done_date'], 'name change keeps done state');
// r1 retry state preserved
$pdo->exec("UPDATE reminders SET last_done_date = 0, retry_count = 4, retry_at = 123, retry_date = 20261005 WHERE id = 'r2'");
$store->replaceReminders($subA, $list, rome('2026-10-05 07:35'));
$r2 = array_column($store->reminderRows($idA), null, 'id')['r2'];
same([0, 4, 123, 20261005], [(int) $r2['last_done_date'], (int) $r2['retry_count'], (int) $r2['retry_at'], (int) $r2['retry_date']], 'retry state preserved when schedule unchanged');
// schedule edit resets: r1 moved to 07:40 (future today) -> not done, fires at 07:40
$list[0]['minute'] = 40;
$store->replaceReminders($subA, $list, rome('2026-10-05 07:36'));
$r1 = array_column($store->reminderRows($idA), null, 'id')['r1'];
same([0, 0], [(int) $r1['last_done_date'], (int) $r1['retry_count']], 'edited schedule resets state');
$sender = new FakePushSender();
$runner = new ReminderRunner($store, $ok, $sender);
$runner->run(rome('2026-10-05 07:40'));
same(['r1', 'r2'], array_map(fn($p) => $p['payload']['tag'], $sender->sent), 'edited r1 fires at its new time (and r2, whose retry chain was due)');
// source change resets too
$list[0]['source'] = ['type' => 'atacStop', 'stopId' => '9'];
$store->replaceReminders($subA, $list, rome('2026-10-05 07:41'));
same(20261005, (int) array_column($store->reminderRows($idA), null, 'id')['r1']['last_done_date'], 'edited source (time already passed) -> marked done, no retro fire');
// removing a reminder removes its row
$store->replaceReminders($subA, [$list[1]], rome('2026-10-05 07:42'));
same(['r2'], array_column($store->reminderRows($idA), 'id'), 'removed reminder deleted');
same(0, $store->replaceReminders($subA, [], rome('2026-10-05 07:43')), 'empty list clears');
check($store->subscription($idA) !== null, 'subscription kept after empty list');
$store->deleteSubscription($idA);
same(null, $store->subscription($idA), 'unsubscribe removes subscription');

echo "store: no retroactive firing\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$subA = mkSub('a');
$idA = ReminderStore::subId($subA['endpoint']);
$cases = [
    ['created at 09:00 for 07:30 today (Mon) -> done today', mkRem('x', [2], 7, 30), '2026-10-05 09:00:00', 20261005],
    ['created 07:36 for 07:30 (6 min ago) -> done today', mkRem('x', [2], 7, 30), '2026-10-05 07:36:00', 20261005],
    ['created 07:31:10 for 07:30 (earlier minute) -> done today', mkRem('x', [2], 7, 30), '2026-10-05 07:31:10', 20261005],
    ['created 07:30:20 for 07:30 (current minute) -> will fire', mkRem('x', [2], 7, 30), '2026-10-05 07:30:20', 0],
    ['created 07:00 for 07:30 -> will fire', mkRem('x', [2], 7, 30), '2026-10-05 07:00:00', 0],
    ['created Mon 09:00 for Tue 07:30 -> untouched', mkRem('x', [3], 7, 30), '2026-10-05 09:00:00', 0],
    ['created Mon 09:00 for Mon 07:30 + Tue -> done today only', mkRem('x', [2, 3], 7, 30), '2026-10-05 09:00:00', 20261005],
];
foreach ($cases as [$name, $rem, $at, $expected]) {
    $pdo->exec('DELETE FROM reminders');
    $store->replaceReminders($subA, [$rem], rome($at));
    same($expected, (int) $store->reminderRows($idA)[0]['last_done_date'], $name);
}
$store->replaceReminders($subA, [mkRem('x', [2], 7, 30)], rome('2026-10-05 09:00:00'));
$sender = new FakePushSender();
(new ReminderRunner($store, $ok, $sender))->run(rome('2026-10-05 09:01'));
same(0, count($sender->sent), 'late-created reminder does not fire');
(new ReminderRunner($store, $ok, $sender))->run(rome('2026-10-12 07:30'));
same(1, count($sender->sent), '... but fires next Monday');

echo "store: limits, rate limit, prune\n";
$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$pdo->exec('BEGIN');
$ins = $pdo->prepare('INSERT INTO subscriptions (id, endpoint, p256dh, auth, created_at, updated_at) VALUES (?,?,?,?,?,?)');
for ($i = 0; $i < ReminderStore::MAX_SUBSCRIPTIONS; $i++) {
    $ins->execute(["fake$i", "https://x.example.com/$i", 'p', 'a', 1, 1]);
}
$pdo->exec('COMMIT');
try {
    $store->replaceReminders(mkSub('new'), [mkRem('r', [2], 7, 30)], rome('2026-10-05 09:00'));
    check(false, 'subscription cap enforced (503)');
} catch (\Madovai\NotReady $e) {
    check(true, 'subscription cap enforced (NotReady -> 503)');
}
same(0, (int) $pdo->query('SELECT COUNT(*) FROM reminders')->fetchColumn(), 'cap: transaction rolled back, no reminders written');
$pdo->exec('DELETE FROM subscriptions');

$sub = mkSub('t');
$id = ReminderStore::subId($sub['endpoint']);
$store->replaceReminders($sub, [], rome('2026-10-05 09:00'));
$t = rome('2026-10-05 09:00')->getTimestamp();
same(0, $store->claimTest($id, $t), 'test push allowed first time');
same(25, $store->claimTest($id, $t + 5), 'test push rate-limited (25 s left)');
same(1, $store->claimTest($id, $t + 29), 'test push still limited at +29 s');
same(0, $store->claimTest($id, $t + 30), 'test push allowed again at +30 s');

$pdo->exec('DELETE FROM reminders; DELETE FROM subscriptions');
$now = rome('2026-10-05 09:00');
foreach (['old' => [1, 1, null], 'oldbutok' => [1, 1, $now->getTimestamp() - 86400], 'oldsynced' => [1, $now->getTimestamp() - 86400, null], 'fresh' => [$now->getTimestamp(), $now->getTimestamp(), null]] as $n => [$c, $u, $o]) {
    $pdo->prepare('INSERT INTO subscriptions (id, endpoint, p256dh, auth, created_at, updated_at, last_ok_at) VALUES (?,?,?,?,?,?,?)')->execute([$n, "https://x.example.com/$n", 'p', 'a', $c, $u, $o]);
    $pdo->prepare('INSERT INTO reminders (id, sub_id, json) VALUES (?,?,?)')->execute(['r', $n, '{}']);
}
same(1, $store->pruneStale($now->getTimestamp()), 'prune removes only the stale subscription');
same(['fresh', 'oldbutok', 'oldsynced'], array_column($pdo->query('SELECT id FROM subscriptions ORDER BY id')->fetchAll(), 'id'), 'prune keeps alive ones');
same(3, (int) $pdo->query('SELECT COUNT(*) FROM reminders')->fetchColumn(), 'prune removes its reminders');

echo "schema\n";
same(1, (int) $pdo->query('PRAGMA user_version')->fetchColumn(), 'user_version = 1');
ReminderStore::migrate($pdo);
check(true, 'migrate is idempotent');
same(['id', 'sub_id', 'json', 'last_done_date', 'retry_count', 'retry_at', 'retry_date'], array_column($pdo->query('PRAGMA table_info(reminders)')->fetchAll(), 'name'), 'reminders columns');

done('test_runner');
