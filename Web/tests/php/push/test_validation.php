<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

use Madovai\Push\B64;
use Madovai\Push\Ec;
use Madovai\Push\Validator;

$k = Ec::generate();
$goodSub = ['endpoint' => 'https://fcm.googleapis.com/fcm/send/abc', 'keys' => ['p256dh' => B64::enc($k['public']), 'auth' => B64::enc(random_bytes(16))]];
$goodRem = ['id' => '3F2504E0-4F89-41D3-9A0C-0305E82C3301', 'stopName' => 'Acilia', 'weekdays' => [2, 3, 4], 'hour' => 7, 'minute' => 30, 'source' => ['type' => 'cotralBus', 'poleCode' => '1021']];

echo "subscription\n";
same($goodSub, Validator::subscription($goodSub), 'valid subscription accepted');
foreach ([
    'http endpoint' => ['endpoint' => 'http://fcm.googleapis.com/x'] + $goodSub,
    'ip endpoint' => ['endpoint' => 'https://10.0.0.1/x'] + $goodSub,
    'ipv6 endpoint' => ['endpoint' => 'https://[::1]/x'] + $goodSub,
    'localhost endpoint' => ['endpoint' => 'https://localhost/x'] + $goodSub,
    'single label host' => ['endpoint' => 'https://intranet/x'] + $goodSub,
    '.internal host' => ['endpoint' => 'https://svc.internal/x'] + $goodSub,
    'custom port' => ['endpoint' => 'https://fcm.googleapis.com:8443/x'] + $goodSub,
    'userinfo' => ['endpoint' => 'https://u:p@fcm.googleapis.com/x'] + $goodSub,
    'too long endpoint' => ['endpoint' => 'https://fcm.googleapis.com/' . str_repeat('a', 600)] + $goodSub,
    'whitespace endpoint' => ['endpoint' => "https://fcm.googleapis.com/x y"] + $goodSub,
    'ftp endpoint' => ['endpoint' => 'ftp://fcm.googleapis.com/x'] + $goodSub,
    'missing keys' => ['endpoint' => $goodSub['endpoint']],
    'p256dh wrong length' => ['keys' => ['p256dh' => B64::enc(substr($k['public'], 0, 64)), 'auth' => $goodSub['keys']['auth']]] + $goodSub,
    'p256dh off curve' => ['keys' => ['p256dh' => B64::enc(substr($k['public'], 0, 64) . chr(ord($k['public'][64]) ^ 1)), 'auth' => $goodSub['keys']['auth']]] + $goodSub,
    'p256dh std base64' => ['keys' => ['p256dh' => base64_encode($k['public']), 'auth' => $goodSub['keys']['auth']]] + $goodSub,
    'auth wrong length' => ['keys' => ['p256dh' => $goodSub['keys']['p256dh'], 'auth' => B64::enc(random_bytes(15))]] + $goodSub,
    'auth not a string' => ['keys' => ['p256dh' => $goodSub['keys']['p256dh'], 'auth' => 5]] + $goodSub,
    'endpoint not a string' => ['endpoint' => 5] + $goodSub,
] as $name => $sub) {
    throwsBadRequest(fn() => Validator::subscription($sub), "reject: $name");
}
throwsBadRequest(fn() => Validator::subscription(null), 'reject: null subscription');
same('https://fcm.googleapis.com/fcm/send/abc', Validator::subscription(['endpoint' => $goodSub['endpoint']], false)['endpoint'], 'unsubscribe form needs only endpoint');
foreach (['https://web.push.apple.com/QGx', 'https://updates.push.services.mozilla.com/wpush/v2/gAAA', 'https://wns2-par02p.notify.windows.com/w/?token=abc', 'https://fcm.googleapis.com/fcm/send/eABC:APA91b-_x'] as $ep) {
    check(Validator::endpointError($ep) === null, "accept real-world endpoint $ep");
}

echo "reminder\n";
same($goodRem, Validator::reminder($goodRem), 'valid reminder accepted');
$r = $goodRem;
$r['weekdays'] = [4, 2, 2, 3, 1, 7];
$r['extra'] = 'ignored';
same([1, 2, 3, 4, 7], Validator::reminder($r)['weekdays'], 'weekdays deduped + sorted');
check(!array_key_exists('extra', Validator::reminder($r)), 'unknown keys dropped');
$tr = ['source' => ['type' => 'cotralTrain', 'stationName' => 'Acilia', 'route' => 'RL_PSP-CC']] + $goodRem;
same($tr['source'], Validator::reminder($tr)['source'], 'cotralTrain accepted');
$at = ['source' => ['type' => 'atacStop', 'stopId' => '05000']] + $goodRem;
same($at['source'], Validator::reminder($at)['source'], 'atacStop accepted');
foreach (['RL_CC-PSP', 'RL_PSP-CC', 'RN_RMMON', 'RN_MONRM', 'RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR'] as $route) {
    check(Validator::source(['type' => 'cotralTrain', 'stationName' => 'X', 'route' => $route])['route'] === $route, "route $route");
}
$mut = static fn(array $over) => array_replace($goodRem, $over);
foreach ([
    'id empty' => $mut(['id' => '']),
    'id too long' => $mut(['id' => str_repeat('a', 65)]),
    'id bad chars' => $mut(['id' => 'a b']),
    'id not string' => $mut(['id' => 12]),
    'stopName empty' => $mut(['stopName' => '  ']),
    'stopName too long' => $mut(['stopName' => str_repeat('a', 121)]),
    'stopName control char' => $mut(['stopName' => "a\x00b"]),
    'stopName missing' => array_diff_key($goodRem, ['stopName' => 1]),
    'hour 24' => $mut(['hour' => 24]),
    'hour -1' => $mut(['hour' => -1]),
    'hour string' => $mut(['hour' => '7']),
    'hour float' => $mut(['hour' => 7.5]),
    'minute 60' => $mut(['minute' => 60]),
    'weekdays empty' => $mut(['weekdays' => []]),
    'weekdays 0' => $mut(['weekdays' => [0, 1]]),
    'weekdays 8' => $mut(['weekdays' => [8]]),
    'weekdays string' => $mut(['weekdays' => ['2']]),
    'weekdays not array' => $mut(['weekdays' => 2]),
    'source missing' => array_diff_key($goodRem, ['source' => 1]),
    'source unknown type' => $mut(['source' => ['type' => 'metro', 'stopId' => '1']]),
    'cotralBus no pole' => $mut(['source' => ['type' => 'cotralBus']]),
    'cotralBus long pole' => $mut(['source' => ['type' => 'cotralBus', 'poleCode' => str_repeat('1', 65)]]),
    'train bad route' => $mut(['source' => ['type' => 'cotralTrain', 'stationName' => 'A', 'route' => 'RL_XX']]),
    'train no station' => $mut(['source' => ['type' => 'cotralTrain', 'route' => 'RL_CC-PSP']]),
    'atac no stopId' => $mut(['source' => ['type' => 'atacStop']]),
    'atac stopId int' => $mut(['source' => ['type' => 'atacStop', 'stopId' => 5]]),
] as $name => $rem) {
    throwsBadRequest(fn() => Validator::reminder($rem), "reject: $name");
}

echo "reminder list\n";
$list = [];
for ($i = 0; $i < 30; $i++) {
    $list[] = ['id' => "r$i"] + $goodRem;
}
same(30, count(Validator::reminders($list)), '30 reminders accepted');
$list[] = ['id' => 'r30'] + $goodRem;
throwsBadRequest(fn() => Validator::reminders($list), 'reject: 31 reminders');
throwsBadRequest(fn() => Validator::reminders([$goodRem, $goodRem]), 'reject: duplicate ids');
throwsBadRequest(fn() => Validator::reminders('x'), 'reject: reminders not array');
throwsBadRequest(fn() => Validator::reminders(['a' => $goodRem]), 'reject: reminders object');
same([], Validator::reminders([]), 'empty list accepted');

done('test_validation');
