<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\AtacRealtime;

Json::requireMethod('GET');

Json::run(static function (): array {
    $trip = (string) ($_GET['trip'] ?? '');
    // Trip ids look like "0#1640-11": allow '#', otherwise the usual conservative set.
    if (preg_match('/^[A-Za-z0-9_.:#-]{1,64}$/', $trip) !== 1) {
        throw new BadRequest('Parametro trip non valido');
    }
    return AtacRealtime::trip($trip) ?? AtacRealtime::emptyTrip($trip);
}, 5);
