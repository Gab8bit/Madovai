<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\AtacRealtime;
use Madovai\Live\CotralTime;

Json::requireMethod('GET');

Json::run(static function (): array {
    $stops = array_values(array_unique(array_filter(
        array_map('trim', explode(',', (string) ($_GET['stops'] ?? ''))),
        static fn(string $s): bool => $s !== ''
    )));
    if ($stops === []) {
        throw new BadRequest('Parametro stops mancante');
    }
    if (count($stops) > 150) {
        throw new BadRequest('Troppe fermate (max 150)');
    }
    foreach ($stops as $s) {
        if (!CotralTime::isValidCode($s)) {
            throw new BadRequest('ID fermata non valido');
        }
    }
    return AtacRealtime::stopArrivals($stops);
}, 5);
