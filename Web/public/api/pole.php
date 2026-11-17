<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\BadRequest;
use Madovai\Gtfs\Input;
use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    $pole = Store::open()->pole(Input::string('id', 64));
    if ($pole === null) {
        throw new BadRequest('Palina inesistente');
    }
    return $pole;
}, 3600);
