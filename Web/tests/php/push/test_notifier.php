<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

use Madovai\Push\ReminderNotifier as N;

$bus = ['id' => 'abc', 'stopName' => 'Acilia', 'weekdays' => [2], 'hour' => 7, 'minute' => 30, 'source' => ['type' => 'cotralBus', 'poleCode' => '1021']];
$atac = ['source' => ['type' => 'atacStop', 'stopId' => '05000'], 'stopName' => 'Termini'] + $bus;
$train = ['stopName' => 'Acilia', 'source' => ['type' => 'cotralTrain', 'stationName' => 'Acilia', 'route' => 'RL_PSP-CC']] + $bus;
$st = static fn(string $t, ?int $d, bool $c = false, ?string $n = null) => ['time' => $t, 'delayMinutes' => $d, 'isCancelled' => $c, 'nextUsefulTime' => $n];

echo "texts\n";
$p = N::payload($bus, $st('07:45', 0));
same('Prossimo bus alle 07:45', $p['title'], 'bus title');
same('Il prossimo bus per Acilia non fa ritardo.', $p['body'], 'on time (delay 0)');
same('abc', $p['tag'], 'tag = reminder id');
same('/#/promemoria', $p['url'], 'url');
same('Il prossimo bus per Acilia non fa ritardo.', N::payload($bus, $st('07:45', null))['body'], 'unknown delay = on time text');
same('Il prossimo bus per Acilia non fa ritardo.', N::payload($bus, $st('07:45', -3))['body'], 'negative delay = on time text');
same('Il prossimo bus per Acilia è in ritardo di 1 minuto.', N::payload($bus, $st('07:45', 1))['body'], '1 minute late (singular)');
same('Il prossimo bus per Acilia è in ritardo di 7 minuti.', N::payload($bus, $st('07:45', 7))['body'], 'N minutes late (plural)');
same('Il prossimo bus per Acilia è stato soppresso. Prossimo utile: 08:05.', N::payload($bus, $st('07:45', null, true, '08:05'))['body'], 'cancelled with next useful');
same("Il prossimo bus per Acilia è stato soppresso. Nessun'altra corsa in programma.", N::payload($bus, $st('07:45', null, true, null))['body'], 'cancelled without next');
same('Prossimo bus alle 07:45', N::payload($atac, $st('07:45', 2))['title'], 'atac stop is a bus');
$tp = N::payload($train, $st('07:50', 4));
same('Prossimo treno alle 07:50', $tp['title'], 'train title');
same('Il prossimo treno per Acilia, direzione Porta San Paolo → Cristoforo Colombo è in ritardo di 4 minuti.', $tp['body'], 'train body with direction');
same("Il prossimo treno per Acilia, direzione Porta San Paolo → Cristoforo Colombo è stato soppresso. Nessun'altra corsa in programma.", N::payload($train, $st('07:50', null, true))['body'], 'train cancelled');
check(strlen(N::json($tp)) < 1000, 'payload is small');
same($tp, json_decode(N::json($tp), true), 'json round trip keeps unicode');
check(str_contains(N::json($tp), '→'), 'json not \\u-escaped');
same(8, count(N::DIRECTION_LABELS), '8 direction labels');
same('Notifiche attive', N::testPayload()['title'], 'test payload title');

done('test_notifier');
