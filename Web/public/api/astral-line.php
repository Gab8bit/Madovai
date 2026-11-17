<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\AstralRepository;

Json::requireMethod('GET');

Json::run(static function (): array {
    return AstralRepository::line((string) ($_GET['route'] ?? '')); // BadRequest unless one of the 8 CotralTrainRoute codes
}, 10);
