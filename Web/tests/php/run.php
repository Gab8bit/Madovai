<?php
declare(strict_types=1);

/**
 * Offline tests for the live-data module (no network, no DB):  php tests/php/run.php
 * Exit code 0 = all green.
 */

$tmp = sys_get_temp_dir() . '/madovai-live-tests-' . getmypid();
@mkdir($tmp, 0775, true);
putenv('MADOVAI_DATA_DIR=' . $tmp);   // empty dir: no madovai.sqlite -> NotReady fallback paths

require __DIR__ . '/../../src/bootstrap.php';

use Madovai\Live\AstralRepository;
use Madovai\Live\AtacRealtime;
use Madovai\Live\AtacStatic;
use Madovai\Live\CotralClient;
use Madovai\Live\CotralTime;
use Madovai\Live\CotralXml;
use Madovai\Live\DepartureStatus;
use Madovai\Live\GtfsRealtime;
use Madovai\Live\Protobuf;
use Madovai\Live\ProtobufException;

$failures = 0;
$count = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures, $count;
    $count++;
    if (!$ok) {
        $failures++;
        echo "FAIL  $name" . ($detail !== '' ? "  ($detail)" : '') . "\n";
    }
}
function same(string $name, mixed $actual, mixed $expected): void
{
    check($name, $actual === $expected, 'got ' . json_encode($actual) . ', expected ' . json_encode($expected));
}

// ---- tiny protobuf encoder (test-only) ---------------------------------------------------------------------
function pv(int $v): string
{
    $out = '';
    while (true) {
        $b = $v & 0x7F;
        $v = ($v >> 7) & 0x01FFFFFFFFFFFFFF; // logical shift
        if ($v === 0) {
            return $out . chr($b);
        }
        $out .= chr($b | 0x80);
    }
}
function fVar(int $f, int $v): string { return pv($f << 3 | 0) . pv($v); }
function fLen(int $f, string $payload): string { return pv($f << 3 | 2) . pv(strlen($payload)) . $payload; }
function fF32(int $f, float $v): string { return pv($f << 3 | 5) . pack('g', $v); }
function fF64(int $f, float $v): string { return pv($f << 3 | 1) . pack('e', $v); }

// ---- Protobuf primitives --------------------------------------------------------------------------------------
{
    $p = 0; $b = pv(300); same('varint 300', Protobuf::varint($b, $p, strlen($b)), 300);
    $p = 0; $b = pv(-1); same('negative varint is 10 bytes', strlen($b), 10);
    same('negative varint decodes to -1', Protobuf::varint($b, $p, strlen($b)), -1);
    $p = 0; $b = pv(-86); same('int32 -86', Protobuf::toInt32(Protobuf::varint($b, $p, strlen($b))), -86);
    same('toInt32 of unsigned 5-byte form', Protobuf::toInt32(0xFFFFFFAA), -86);
    $p = 0; $b = pv(1790930780); same('large timestamp', Protobuf::varint($b, $p, strlen($b)), 1790930780);
    $p = 0; $b = pack('g', 41.8686752); $f = Protobuf::float32($b, $p, 4);
    check('float32', abs($f - 41.8686752) < 1e-5);
    $p = 0; $b = pack('e', 12.5); same('double64', Protobuf::double64($b, $p, 8), 12.5);
    $threw = false;
    try { $p = 0; $b = "\x80\x80"; Protobuf::varint($b, $p, 2); } catch (ProtobufException) { $threw = true; }
    check('truncated varint throws', $threw);
    $threw = false;
    try { $p = 0; $b = pv(50) . 'ab'; Protobuf::lengthDelimited($b, $p, strlen($b)); } catch (ProtobufException) { $threw = true; }
    check('truncated length-delimited throws', $threw);
}

// ---- GTFS-RT: synthetic feed (cancellations, fallbacks, unknown fields) -------------------------------------------
{
    $now = 1_800_000_000;
    $event = static fn(?int $delay, ?int $time) => ($delay !== null ? fVar(1, $delay) : '') . ($time !== null ? fVar(2, $time) : '') . fVar(3, 9);
    $stu = static fn(int $seq, string $stop, ?string $arr, ?string $dep, ?int $rel = null) =>
        fLen(2, fVar(1, $seq) . ($arr !== null ? fLen(2, $arr) : '') . ($dep !== null ? fLen(3, $dep) : '') . fLen(4, $stop)
            . ($rel !== null ? fVar(5, $rel) : '') . fVar(99, 7) /* unknown field */);
    $trip = static fn(string $tripId, string $route, ?int $rel) => fLen(1, fLen(1, $tripId) . fLen(5, $route) . ($rel !== null ? fVar(4, $rel) : '') . fLen(3, '20261002'));

    $entities = '';
    // 1: normal trip; stop A arrival with negative delay; stop B only departure; stop C skipped; stop D arrival without time
    $entities .= fLen(2, fLen(1, 'e1') . fLen(3,
        $trip('T1', 'R1', null)
        . $stu(1, 'A', $event(-86, $now + 300), null)
        . $stu(2, 'B', null, $event(30, $now + 600))
        . $stu(3, 'C', $event(0, $now + 900), null, 1)
        . $stu(4, 'D', $event(5, null), $event(5, $now + 1200)) // arrival wins even without time -> skipped
        . $stu(5, 'E', $event(null, $now - 500), null)           // too old for byStop, kept in byTrip
    ));
    // 2: cancelled trip
    $entities .= fLen(2, fLen(1, 'e2') . fLen(3, $trip('T2', 'R2', 3) . $stu(1, 'A', $event(0, $now + 200), null)));
    // 3: deleted trip, no trip_id -> falls back to entity id
    $entities .= fLen(2, fLen(1, 'e3') . fLen(3, fLen(1, fLen(5, 'R3') . fVar(4, 7)) . $stu(1, 'A', $event(0, $now + 400), null)));
    // 4: unknown entity field + alert only: ignored
    $entities .= fLen(2, fLen(1, 'e4') . fLen(5, 'whatever') . fVar(50, 1));
    $feed = fLen(1, fLen(1, '2.0') . fVar(3, $now)) . $entities . fVar(77, 1) /* unknown top-level field */;

    $r = GtfsRealtime::decodeTripUpdates($feed, $now);
    same('header timestamp', $r['timestamp'], $now);
    same('byStop A: three arrivals sorted later', count($r['byStop']['A']), 3);
    $a = $r['byStop']['A'];
    same('A[0] negative delay + not cancelled', [$a[0][0], $a[0][3], $a[0][4]], ['T1', -86, 0]);
    same('A[1] canceled trip flagged', [$a[1][0], $a[1][4]], ['T2', 1]);
    same('A[2] deleted trip, entity id fallback', [$a[2][0], $a[2][1], $a[2][4]], ['e3', 'R3', 1]);
    same('B uses departure when no arrival', [$r['byStop']['B'][0][2], $r['byStop']['B'][0][3]], [$now + 600, 30]);
    same('C stop SKIPPED flag', $r['byStop']['C'][0][4], 1);
    check('D (arrival without time) skipped', !isset($r['byStop']['D']));
    check('E (older than now-120) not in byStop', !isset($r['byStop']['E']));
    same('E kept in byTrip', count($r['byTrip']['T1']['stops']), 4); // A,B,C,E
    same('byTrip stop tuple', $r['byTrip']['T1']['stops'][0], ['A', 1, $now + 300, -86]);
    same('byTrip route', $r['byTrip']['T2']['route'], 'R2');

    // vehicles
    $pos = static fn(float $lat, float $lon, ?float $bearing) => fLen(2, fF32(1, $lat) . fF32(2, $lon) . ($bearing !== null ? fF32(3, $bearing) : '') . fF64(4, 1.0));
    $veh = fLen(2, fLen(1, 'v1') . fLen(4, fLen(1, fLen(1, 'T1') . fLen(5, '409')) . $pos(41.9, 12.5, 90.0) . fLen(8, fLen(1, '52') . fLen(2, '0101'))))
        . fLen(2, fLen(1, 'v2') . fLen(4, $pos(41.8, 12.4, null)))                // no trip, no vehicle descriptor -> entity id
        . fLen(2, fLen(1, 'v3') . fLen(4, fLen(1, fLen(1, 'T9'))))               // no position -> dropped
        . fLen(2, fLen(1, 'v4') . fLen(3, 'x'));                                   // trip update entity -> not a vehicle
    $v = GtfsRealtime::decodeVehicles(fLen(1, fVar(3, 123)) . $veh);
    same('vehicle count', count($v['vehicles']), 2);
    same('vehicle ts', $v['timestamp'], 123);
    $v0 = $v['vehicles'][0];
    same('vehicle id from descriptor', $v0['id'], '52');
    check('vehicle lat/lon/bearing', abs($v0['lat'] - 41.9) < 1e-5 && abs($v0['lon'] - 12.5) < 1e-5 && abs($v0['bearing'] - 90.0) < 1e-5);
    same('vehicle route/trip', [$v0['routeId'], $v0['tripId']], ['409', 'T1']);
    same('vehicle fallback id/no trip', [$v['vehicles'][1]['id'], $v['vehicles'][1]['routeId'], $v['vehicles'][1]['tripId'], $v['vehicles'][1]['bearing']], ['v2', '', null, null]);
}

// ---- GTFS-RT: captured real samples (checked against `protoc --decode` when the fixtures were taken) ------------
{
    $u = GtfsRealtime::decodeTripUpdates((string) file_get_contents(__DIR__ . '/fixtures/trip_updates_sample.pb'), 0);
    same('sample ts', $u['timestamp'], 1790930776);
    same('sample trips', array_keys($u['byTrip']), ['0#1640-11', '0#1621-10', '0#4575-10']);
    same('sample first stop', $u['byTrip']['0#1640-11']['stops'][0], ['74024', 2, 1790930780, 72]);
    same('sample negative delay', $u['byTrip']['0#1621-10']['stops'][0], ['74008', 15, 1790930852, -82]);
    same('sample route', $u['byTrip']['0#4575-10']['route'], '451');
    same('sample stop count', count($u['byTrip']['0#1640-11']['stops']), 18);
    $v = GtfsRealtime::decodeVehicles((string) file_get_contents(__DIR__ . '/fixtures/vehicle_positions_sample.pb'));
    same('sample vehicles', count($v['vehicles']), 5);
    same('sample vehicle', [$v['vehicles'][0]['id'], $v['vehicles'][0]['routeId'], $v['vehicles'][0]['tripId']], ['52', '409', '0#1640-11']);
    check('sample coords in Lazio', abs($v['vehicles'][0]['lat'] - 41.8686752) < 1e-5 && abs($v['vehicles'][0]['lon'] - 12.5375986) < 1e-5);
}

// ---- Time utils ------------------------------------------------------------------------------------------------
{
    same('readableTime 37800', CotralTime::readableTime('37800'), '10:30');
    same('readableTime wraps 24h', CotralTime::readableTime('89280'), '00:48');
    same('readableTime no wrap (ritardo)', CotralTime::readableTime('89280', false), '24:48');
    same('readableTime negative tiny keeps sign', CotralTime::readableTime('-15'), '-00:00');
    same('readableTime negative', CotralTime::readableTime('-3600', false), '-01:00');
    same('readableTime garbage', CotralTime::readableTime('abc'), '00:00');
    same('readableTime trims', CotralTime::readableTime(' 60 '), '00:01');
    same('normalize swapped', CotralTime::normalizeLatLon(12.9, 41.7), [41.7, 12.9]);
    same('normalize ok', CotralTime::normalizeLatLon(41.7, 12.9), [41.7, 12.9]);
    same('normalize zero', CotralTime::normalizeLatLon(0.0, 0.0), [0.0, 0.0]);
    same('code ok', CotralTime::isValidCode('ff90009'), true);
    same('code bad', CotralTime::isValidCode('a b'), false);
    same('code too long', CotralTime::isValidCode(str_repeat('a', 65)), false);
    same('code empty', CotralTime::isValidCode(''), false);
}

// ---- Cotral XML ---------------------------------------------------------------------------------------------------
{
    same('dangling closing tag = no data', CotralXml::parse("\n\n </transiti>\n\n"), null);
    same('empty body = no data', CotralXml::parse("  \n"), null);
    same('garbage = no data', CotralXml::parse('<a><b></a>'), null);
    same('no-data transits', CotralClient::parseTransits("\n </transiti>\n"), null);
    same('palina but no corsa', CotralClient::parseTransits('<transiti><palina><codice>1</codice></palina></transiti>'), null);

    $r = CotralClient::parseTransits((string) file_get_contents(__DIR__ . '/fixtures/cotral_pole_1021.xml'));
    check('parsed fixture', $r !== null);
    same('pole', $r['pole'], ['code' => '1021', 'name' => 'ARTENA, Campo Sportivo', 'stopName' => 'via G.Marconi',
        'locality' => 'Artena (Comune)', 'comune' => 'Artena', 'lat' => 41.7465425153811, 'lon' => 12.9150993838911]);
    same('transit count', count($r['transits']), 2);
    $t = $r['transits'][0];
    same('orarioPartenza', $t['orarioPartenzaCorsa'], '10:30');
    same('tempoTransito', $t['tempoTransito'], '10:56');
    same("ritardo raw seconds", $t["ritardoSeconds"], 358);
    same('vehicle', [$t['vehicleCode'], $t['vehicleAlive'], $t['monitorata']], ['6106', true, '1']);
    same('reliable', CotralClient::isDelayReliable($t), true);
    same('canTrack', CotralClient::canTrackVehicle($t), true);

    $x = CotralClient::parseTransits('<transiti><palina><codice>9</codice><latitudine>12.5</latitudine><longitudine>41.9</longitudine></palina>'
        . '<corsa><idCorsa>1</idCorsa><orarioPartenzaCorsa>89280</orarioPartenzaCorsa><tempoTransito>x</tempoTransito><ritardo>-15</ritardo>'
        . '<automezzo>n.d.</automezzo><monitorata>0</monitorata><soppressa>Y</soppressa></corsa>'
        . '<corsa><idCorsa>2</idCorsa><automezzo isAlive="0">77</automezzo><monitorata>1</monitorata></corsa>'
        . '<corsa><idCorsa>3</idCorsa><monitorata>1</monitorata></corsa></transiti>');
    same('swapped pole coords normalized', [$x['pole']['lat'], $x['pole']['lon']], [41.9, 12.5]);
    $t = $x['transits'];
    same('wrapped 24:48', $t[0]['orarioPartenzaCorsa'], '00:48');
    same('bad tempoTransito', $t[0]['tempoTransito'], '00:00');
    same('negative ritardo not wrapped', $t[0]['ritardoSeconds'], -15);
    same('automezzo n.d. is a code but not trackable', [$t[0]['vehicleCode'], CotralClient::canTrackVehicle($t[0])], ['n.d.', false]);
    same('alive=0 => monitoredOffline: trackable but delay unreliable', [CotralClient::canTrackVehicle($t[1]), CotralClient::isDelayReliable($t[1])], [true, false]);
    same('no automezzo node', [$t[2]['vehicleCode'], $t[2]['vehicleAlive'], CotralClient::canTrackVehicle($t[2])], [null, false, false]);
    same('missing ritardo => 0', $t[2]['ritardoSeconds'], 0);

    same('position last of trail', CotralClient::parsePosition('<listaPosizioni><posizione pX="41.1 41.2" pY="12.1 12.2">10:45:36</posizione></listaPosizioni>'), ['lat' => 41.2, 'lon' => 12.2]);
    same('position (0,0) = none', CotralClient::parsePosition('<l><posizione pX="0" pY="0">x</posizione></l>'), null);
    same('position missing', CotralClient::parsePosition('<l></l>'), null);
    same('position garbage', CotralClient::parsePosition('<l><posizione pX="a" pY="b"/></l>'), null);
    same('position dangling', CotralClient::parsePosition('</listaPosizioni>'), null);
}

// ---- ASTRAL -------------------------------------------------------------------------------------------------------
{
    $stations = AstralRepository::parseStations(json_encode([
        ['nomeFermata' => 'Cristoforo Colombo', 'codice' => 'ff90004', 'ordine' => 14],
        ['nomeFermata' => 'Porta San Paolo', 'codice' => 'ff90009', 'ordine' => 1],
        ['nomeFermata' => 'Acilia Sud ', 'codice' => 'ff90001', 'ordine' => 10],
        ['codice' => 'broken'],
    ]));
    same('stations sorted by ordine', array_column($stations, 'order'), [1, 10, 14]);
    same('exact match (trim, lowercase)', AstralRepository::resolveFermata($stations, '  porta SAN paolo'), 'ff90009');
    same('substring: station name contains target', AstralRepository::resolveFermata($stations, 'Acilia'), 'ff90001');
    same('substring: target contains station name', AstralRepository::resolveFermata($stations, 'Stazione Cristoforo Colombo FS'), 'ff90004');
    same('no match', AstralRepository::resolveFermata($stations, 'Roma Termini'), null);
    same('empty name', AstralRepository::resolveFermata($stations, '   '), null);

    $e = AstralRepository::parseTransits(json_encode([
        ['orario' => '05:15', 'corsa' => 'RL53', 'ritardo' => '0', 'soppressa' => 'N', 'busSostitutivo' => 'N'],
        ['orario' => '25:10', 'corsa' => '5175', 'ritardo' => '', 'soppressa' => ' y ', 'busSostitutivo' => 'Y'],
        ['orario' => '07:00', 'corsa' => 'RL2', 'ritardo' => '-2', 'soppressa' => 'N', 'busSostitutivo' => ''],
        ['orario' => 'bad', 'corsa' => 'X', 'ritardo' => '1', 'soppressa' => 'N', 'busSostitutivo' => 'N'],
    ]));
    same('entries count (bad time dropped)', count($e), 3);
    same('entry 0', $e[0], ['id' => 'RL53', 'time' => '05:15', 'sortSeconds' => 18900, 'delayMinutes' => 0, 'isCancelled' => false, 'isReplacementBus' => false]);
    same('empty ritardo = null, soppressa Y, bus Y', [$e[1]['delayMinutes'], $e[1]['isCancelled'], $e[1]['isReplacementBus'], $e[1]['sortSeconds']], [null, true, true, 90600]);
    same('negative delay', $e[2]['delayMinutes'], -2);

    $up = AstralRepository::upcoming($e, 6 * 3600);
    same('upcoming drops past, sorts', array_column($up, 'id'), ['RL2', '5175']);
}

// ---- DepartureStatus --------------------------------------------------------------------------------------------
{
    $now = new DateTimeImmutable('2026-10-02 10:30:20', new DateTimeZone('Europe/Rome'));
    $tr = static fn(string $time, int $rit, string $mon, bool $alive, string $sop = 'N') => [
        'tempoTransito' => $time, 'orarioPartenzaCorsa' => $time, 'ritardoSeconds' => $rit,
        'monitorata' => $mon, 'vehicleAlive' => $alive, 'soppressa' => $sop, 'vehicleCode' => 'X',
    ];
    // already passed (10:20), then a delayed one 10:28 + 5 min = 10:33, then 10:45
    $s = DepartureStatus::fromTransits([$tr('10:20', 0, '1', true), $tr('10:45', 0, '0', false), $tr('10:28', 300, '1', true)], $now);
    same('delay-aware ordering/time', $s, ['time' => '10:33', 'delayMinutes' => 5, 'isCancelled' => false, 'nextUsefulTime' => null]);
    // delay not reliable -> raw schedule time, delay unknown
    $s = DepartureStatus::fromTransits([$tr('10:35', 300, '1', false)], $now);
    same('unreliable delay ignored', $s, ['time' => '10:35', 'delayMinutes' => null, 'isCancelled' => false, 'nextUsefulTime' => null]);
    // sub-minute delay not applied to the displayed time, but still reported as 0 minutes
    $s = DepartureStatus::fromTransits([$tr('10:35', 45, '1', true)], $now);
    same('sub-minute delay', [$s['time'], $s['delayMinutes']], ['10:35', 0]);
    // early run never negative
    $s = DepartureStatus::fromTransits([$tr('10:40', -180, '1', true)], $now);
    same('early => delay 0, time adjusted', [$s['time'], $s['delayMinutes']], ['10:37', 0]);
    // cancelled first, "prossimo utile" = following one
    $s = DepartureStatus::fromTransits([$tr('10:40', 0, '0', false, 'Y'), $tr('10:50', 0, '0', false)], $now);
    same('cancelled -> next useful', $s, ['time' => '10:40', 'delayMinutes' => null, 'isCancelled' => true, 'nextUsefulTime' => '10:50']);
    // cancelled and nothing after it
    $s = DepartureStatus::fromTransits([$tr('10:40', 0, '0', false, 'Y')], $now);
    same('cancelled, nothing after', $s['nextUsefulTime'], null);
    same('nothing upcoming', DepartureStatus::fromTransits([$tr('10:00', 0, '0', false)], $now), null);
    // post-midnight wrap: now 23:50, run at 00:10
    $late = new DateTimeImmutable('2026-10-02 23:50:00', new DateTimeZone('Europe/Rome'));
    $s = DepartureStatus::fromTransits([$tr('00:10', 0, '0', false)], $late);
    same('midnight rollover', $s['time'], '00:10');

    $a = [['time' => '10:40', 'sortSeconds' => 38400, 'delayMinutes' => -3, 'isCancelled' => true, 'isReplacementBus' => false],
          ['time' => '11:10', 'sortSeconds' => 40200, 'delayMinutes' => 4, 'isCancelled' => false, 'isReplacementBus' => false]];
    same('astral cancelled + next', DepartureStatus::fromAstral($a), ['time' => '10:40', 'delayMinutes' => 0, 'isCancelled' => true, 'nextUsefulTime' => '11:10']);
    same('astral empty', DepartureStatus::fromAstral([]), null);
    same('astral unknown delay stays null', DepartureStatus::fromAstral([['time' => '10:40', 'sortSeconds' => 1, 'delayMinutes' => null, 'isCancelled' => false, 'isReplacementBus' => false]])['delayMinutes'], null);

    $ts = (new DateTimeImmutable('2026-10-02 10:45:30', new DateTimeZone('Europe/Rome')))->getTimestamp();
    same('atac', DepartureStatus::fromAtac([['ts' => $ts, 'delaySeconds' => 185, 'isCancelled' => false]]), ['time' => '10:45', 'delayMinutes' => 3, 'isCancelled' => false, 'nextUsefulTime' => null]);
    same('atac cancelled + next', DepartureStatus::fromAtac([['ts' => $ts, 'delaySeconds' => null, 'isCancelled' => true], ['ts' => $ts + 600, 'delaySeconds' => 0, 'isCancelled' => false]]),
        ['time' => '10:45', 'delayMinutes' => null, 'isCancelled' => true, 'nextUsefulTime' => '10:55']);
    same('atac negative delay clamps to 0', DepartureStatus::fromAtac([['ts' => $ts, 'delaySeconds' => -200, 'isCancelled' => false]])['delayMinutes'], 0);
    same('atac none', DepartureStatus::fromAtac([]), null);

    same('forReminder unknown type -> null', DepartureStatus::forReminder(['source' => ['type' => 'nope']]), null);
    same('forReminder no source -> null', DepartureStatus::forReminder([]), null);
    same('forReminder invalid route -> null', DepartureStatus::forReminder(['source' => ['type' => 'cotralTrain', 'route' => 'BOGUS', 'stationName' => 'x']]), null);
    same('forReminder invalid pole -> null', DepartureStatus::forReminder(['source' => ['type' => 'cotralBus', 'poleCode' => 'a b']]), null);
}

// ---- Static DB fallback (no data dir content => NotReady => graceful) ------------------------------------------------
{
    same('routes fallback', AtacStatic::routes(['1']), []);
    same('trips fallback', AtacStatic::trips(['1']), []);
    same('stopNames fallback', AtacStatic::stopNames(['1']), []);
    $out = AtacRealtime::enrichVehicles(['timestamp' => 99, 'vehicles' => [
        ['id' => '52', 'lat' => 41.868675231933594, 'lon' => 12.5375986, 'bearing' => null, 'routeId' => '409', 'tripId' => 'T1'],
        ['id' => 'v2', 'lat' => 41.8, 'lon' => 12.4, 'bearing' => 90.04, 'routeId' => '', 'tripId' => null],
    ]]);
    same('enrich fallback updated', $out['updated'], 99);
    same('enrich fallback vehicle 0', $out['vehicles'][0], [
        'id' => 'atac-52', 'lat' => 41.868675, 'lon' => 12.537599, 'bearing' => null, 'routeId' => '409', 'routeLabel' => '409',
        'kind' => 'bus', 'operator' => 'Atac', 'tripId' => 'T1', 'headsign' => null]);
    same('enrich fallback vehicle 1', [$out['vehicles'][1]['routeId'], $out['vehicles'][1]['routeLabel'], $out['vehicles'][1]['bearing'], $out['vehicles'][1]['headsign']], [null, null, 90.0, null]);
}

// ---- Static DB present (tiny fixture DB) ---------------------------------------------------------------------------
{
    $dir2 = $tmp . '/withdb';
    @mkdir($dir2, 0775, true);
    $pdo = new PDO('sqlite:' . $dir2 . '/madovai.sqlite');
    $pdo->exec("CREATE TABLE atac_routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, kind INT, operator TEXT, color TEXT);
        CREATE TABLE atac_trips(trip_id TEXT PRIMARY KEY, route_id TEXT, service_id TEXT, headsign TEXT);
        CREATE TABLE atac_stops(stop_id TEXT PRIMARY KEY, name TEXT, name_lc TEXT, lat REAL, lon REAL);
        INSERT INTO atac_routes VALUES ('8','8','',0,'Atac',NULL),('MEA','MEA','',1,'Atac',NULL),('X1','X1','',3,'Roma TPL',NULL);
        INSERT INTO atac_trips VALUES ('T1','8','s','CASALETTO'),('T2','X1','s',NULL);
        INSERT INTO atac_stops VALUES ('A','Piazza Venezia','piazza venezia',41.9,12.4);");
    unset($pdo);
    // Db keeps a static PDO and Config::dataDir() reads the env on every call: run this block in a child process.
    $script = tempnam($tmp, 'blk') . '.php';
    file_put_contents($script, '<?php require ' . var_export(__DIR__ . '/../../src/bootstrap.php', true) . ';
        use Madovai\Live\AtacStatic;
        echo json_encode([AtacStatic::routes(["8","MEA","X1","nope"]), AtacStatic::trips(["T1","T2","none"]), AtacStatic::stopNames(["A","B"])]);');
    $json = shell_exec('MADOVAI_DATA_DIR=' . escapeshellarg($dir2) . ' ' . escapeshellarg(PHP_BINARY) . ' -d error_reporting=0 ' . escapeshellarg($script));
    $d = json_decode((string) $json, true);
    same('db routes', $d[0], [
        '8' => ['label' => '8', 'kind' => 'tram', 'operator' => 'Atac'],
        'MEA' => ['label' => 'MEA', 'kind' => 'metro', 'operator' => 'Atac'],
        'X1' => ['label' => 'X1', 'kind' => 'bus', 'operator' => 'Roma TPL'],
    ]);
    same('db trips (empty headsign -> null)', $d[1], ['T1' => ['route' => '8', 'headsign' => 'CASALETTO'], 'T2' => ['route' => 'X1', 'headsign' => null]]);
    same('db stop names', $d[2], ['A' => 'Piazza Venezia']);
}

// cleanup
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $f) {
    $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
}
@rmdir($tmp);

echo $failures === 0 ? "OK  $count assertions passed\n" : "$failures of $count assertions FAILED\n";
exit($failures === 0 ? 0 : 1);
