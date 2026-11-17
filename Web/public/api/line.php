<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Input;
use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    $source = Input::string('source', 16);
    $id = Input::string('id', 64);
    return Store::open()->line($source, $id);
}, 3600);
