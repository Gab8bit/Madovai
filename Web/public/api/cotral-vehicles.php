<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\CotralScanner;
use Madovai\Live\CotralTime;

Json::requireMethod('GET');

Json::run(static function (): array {
    $poles = array_values(array_unique(array_filter(
        array_map('trim', explode(',', (string) ($_GET['poles'] ?? ''))),
        static fn(string $s): bool => $s !== ''
    )));
    if (count($poles) > CotralScanner::MAX_POLES) {
        throw new BadRequest('Troppe paline (max ' . CotralScanner::MAX_POLES . ')');
    }
    foreach ($poles as $p) {
        if (!CotralTime::isValidCode($p)) {
            throw new BadRequest('Codice palina non valido');
        }
    }
    return ['vehicles' => $poles === [] ? [] : CotralScanner::scan($poles)];
}, 3);
