<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Input;
use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    return Store::open()->atacScheduled(Input::string('stop', 64));
}, 30);
