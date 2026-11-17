<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(fn () => Store::open()->lines(), 3600);
