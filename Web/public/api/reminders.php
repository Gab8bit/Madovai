<?php
declare(strict_types=1);
require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Json;
use Madovai\Push\ReminderStore;
use Madovai\Push\Validator;
use Madovai\Rome;

Json::run(function () {
    Json::requireMethod('POST');
    $body = Json::body();

    if (($_GET['action'] ?? '') === 'unsubscribe') {
        $sub = Validator::subscription($body['subscription'] ?? null, false);
        (new ReminderStore())->deleteSubscription(ReminderStore::subId($sub['endpoint']));
        return ['ok' => true];
    }

    $sub = Validator::subscription($body['subscription'] ?? null);
    if (!array_key_exists('reminders', $body)) {
        throw new Madovai\BadRequest('reminders mancante');
    }
    $reminders = Validator::reminders($body['reminders']);
    $count = (new ReminderStore())->replaceReminders($sub, $reminders, Rome::now());
    return ['ok' => true, 'count' => $count];
});
