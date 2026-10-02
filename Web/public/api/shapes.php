<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Input;
use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    [$minLat, $minLon, $maxLat, $maxLon] = Input::bbox();
    $limit = Input::int('limit', 150, 1, 500);
    return ['shapes' => Store::open()->shapesInBox($minLat, $minLon, $maxLat, $maxLon, $limit)];
}, 300);
