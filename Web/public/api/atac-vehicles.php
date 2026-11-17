<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Json;
use Madovai\Live\AtacRealtime;

Json::requireMethod('GET');

Json::run(static fn(): array => AtacRealtime::vehicles(), 5);
