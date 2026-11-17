<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Input;
use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    $id = Input::string('id', 64);
    $route = Input::optionalString('route', 64);
    return Store::open()->atacStopGroup($id, $route);
}, 3600);
