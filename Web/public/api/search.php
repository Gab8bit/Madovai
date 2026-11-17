<?php
declare(strict_types=1);

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Gtfs\Store;
use Madovai\Json;

Json::run(function () {
    $q = $_GET['q'] ?? '';
    return Store::open()->search(is_string($q) ? $q : '');
}, 60);
