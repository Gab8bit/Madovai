<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Input;
use Madovai\Gtfs\RailService;
use Madovai\Gtfs\Store;
use Madovai\Json;
use Madovai\Live\AstralRepository;

Json::run(function () {
    return RailService::departures(
        Store::open(),
        Input::string('stop', 64),
        static fn (string $route, string $station): ?array => AstralRepository::departures($route, $station)
    );
});
