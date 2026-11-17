<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Input;
use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    [$minLat, $minLon, $maxLat, $maxLon] = Input::bbox();
    $cotralLimit = Input::int('cotralLimit', 150, 1, 500);
    $atacLimit = Input::int('atacLimit', 400, 1, 1000);
    return Store::open()->stopsInBox($minLat, $minLon, $maxLat, $maxLon, $cotralLimit, $atacLimit);
}, 30);
