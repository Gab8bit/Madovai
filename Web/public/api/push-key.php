<?php
declare(strict_types=1);
require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Json;
use Madovai\Push\Vapid;

Json::run(function () {
    Json::requireMethod('GET');
    return ['publicKey' => Vapid::load()->publicKey()];
}, 3600);
