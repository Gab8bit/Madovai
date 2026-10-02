<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\CotralClient;
use Madovai\Live\CotralTime;

Json::requireMethod('GET');

Json::run(static function (): array {
    $code = (string) ($_GET['code'] ?? '');
    if (!CotralTime::isValidCode($code)) {
        throw new BadRequest('Parametro code non valido');
    }
    return CotralClient::vehiclePosition($code) ?? ['lat' => null, 'lon' => null];
}, 3);
