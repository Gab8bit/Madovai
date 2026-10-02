<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\CotralClient;
use Madovai\Live\CotralTime;

Json::requireMethod('GET');

Json::run(static function (): array {
    $pole = (string) ($_GET['pole'] ?? '');
    if (!CotralTime::isValidCode($pole)) {
        throw new BadRequest('Parametro pole non valido');
    }
    return CotralClient::transits($pole) ?? ['pole' => null, 'transits' => []];
}, 5);
