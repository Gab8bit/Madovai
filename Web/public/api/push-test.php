<?php
declare(strict_types=1);
require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Json;
use Madovai\Push\HttpPushSender;
use Madovai\Push\ReminderNotifier;
use Madovai\Push\ReminderStore;
use Madovai\Push\Validator;
use Madovai\Rome;

Json::run(function () {
    Json::requireMethod('POST');
    $sub = Validator::subscription(Json::body()['subscription'] ?? null);
    $store = new ReminderStore();
    $now = Rome::now()->getTimestamp();

    $subId = ReminderStore::subId($sub['endpoint']);
    $store->pdo()->exec('BEGIN IMMEDIATE');
    try {
        $store->upsertSubscription($sub, $now); // keeps the keys fresh; also enforces the subscription cap
        $store->pdo()->exec('COMMIT');
    } catch (\Throwable $e) {
        $store->pdo()->exec('ROLLBACK');
        throw $e;
    }

    $wait = $store->claimTest($subId, $now, 30);
    if ($wait > 0) {
        header('Retry-After: ' . $wait);
        Json::out(['error' => "Attendi $wait secondi prima di un nuovo test", 'retryAfter' => $wait], 429);
    }

    $result = (new HttpPushSender())->send($sub, ReminderNotifier::json(ReminderNotifier::testPayload()));
    if ($result->ok()) {
        $store->touchOk($subId, $now);
        return ['ok' => true, 'status' => $result->status];
    }
    if ($result->gone()) {
        $store->deleteSubscription($subId);
        return ['ok' => false, 'gone' => true, 'status' => $result->status, 'error' => 'Sottoscrizione non più valida: riattiva le notifiche'];
    }
    return ['ok' => false, 'status' => $result->status, 'error' => $result->error !== '' ? $result->error : 'Il servizio push ha rifiutato il messaggio'];
});
