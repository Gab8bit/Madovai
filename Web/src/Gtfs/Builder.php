<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

/**
 * Builds data/madovai.sqlite from the three static GTFS feeds (Cotral bus, Cotral rail,
 * Rome/Atac). Port of the iOS parsers (GTFSParsing, AtacGtfsParsing, ...) into one SQLite file.
 *
 * Memory: the two huge stop_times.txt files are streamed line by line; only compact
 * trip->route maps and the distinct (stop,route) pairs live in PHP arrays.
 */
final class Builder
{
    private \PDO $db;
    private float $t0;
    /** @var array<string,int|string> */
    private array $stats = [];
    /** @var callable(string):void */
    private $logger;

    /** @param callable(string):void|null $logger */
    public function __construct(private string $dataDir, ?callable $logger = null)
    {
        $this->logger = $logger ?? static function (string $m): void {
            fwrite(STDERR, $m . "\n");
        };
        $this->t0 = microtime(true);
    }

    private function log(string $msg): void
    {
        $mem = memory_get_usage(true) / 1048576;
        ($this->logger)(sprintf('[%6.1fs %4dMB] %s', microtime(true) - $this->t0, $mem, $msg));
    }

    /**
     * @param array{bus:FeedSource,rail:FeedSource,atac:FeedSource} $feeds
     * @param array<string,string> $sourceInfo recorded in the meta table
     * @return array<string,int|string> build statistics
     */
    public function build(array $feeds, string $finalPath, array $sourceInfo = []): array
    {
        $tmpPath = $finalPath . '.tmp-' . getmypid();
        @unlink($tmpPath);
        try {
            $this->db = new \PDO('sqlite:' . $tmpPath, null, null, [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            ]);
            $this->db->exec('PRAGMA journal_mode = OFF');
            $this->db->exec('PRAGMA synchronous = OFF');
            $this->db->exec('PRAGMA cache_size = -40000');
            $this->db->exec('PRAGMA temp_store = FILE');
            $this->db->exec('PRAGMA page_size = 4096');

            $this->db->beginTransaction();
            $this->createSchema();
            $this->loadCotralBus($feeds['bus']);
            $this->loadCotralRail($feeds['rail']);
            $this->writeCotralStopRoutes();
            $this->loadAtac($feeds['atac']);
            $this->createIndexes();
            $this->writeMeta($sourceInfo);
            $this->db->commit();

            $this->log('ANALYZE');
            $this->db->exec('ANALYZE');
            $this->log('VACUUM');
            $this->db->exec('VACUUM');
            $this->db = new \PDO('sqlite::memory:'); // close the file handle
            if (!rename($tmpPath, $finalPath)) {
                throw new \RuntimeException("rename($tmpPath) fallito");
            }
        } catch (\Throwable $e) {
            $this->db = new \PDO('sqlite::memory:');
            @unlink($tmpPath);
            throw $e;
        }
        $this->stats['db_bytes'] = (int) filesize($finalPath);
        $this->stats['seconds'] = (int) round(microtime(true) - $this->t0);
        $this->stats['peak_php_mb'] = (int) round(memory_get_peak_usage(true) / 1048576);
        return $this->stats;
    }

    // ------------------------------------------------------------------ schema

    private function createSchema(): void
    {
        $this->db->exec(<<<'SQL'
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;

CREATE TABLE cotral_stops(
  stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL, locality TEXT NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, is_rail INTEGER NOT NULL);
CREATE TABLE cotral_routes(
  route_id TEXT PRIMARY KEY, short_name TEXT NOT NULL, long_name TEXT NOT NULL, is_rail INTEGER NOT NULL,
  short_lc TEXT NOT NULL, long_lc TEXT NOT NULL);
CREATE TABLE cotral_stop_routes(
  stop_id TEXT NOT NULL, route_id TEXT NOT NULL, PRIMARY KEY(stop_id, route_id)) WITHOUT ROWID;
CREATE TABLE cotral_rail_shapes(
  route_id TEXT NOT NULL, shape_id TEXT NOT NULL, polyline TEXT NOT NULL,
  min_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lat REAL NOT NULL, max_lon REAL NOT NULL);
CREATE TABLE rail_trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL);
CREATE TABLE rail_stop_times(
  trip_id TEXT NOT NULL, seq INTEGER NOT NULL, stop_id TEXT NOT NULL, dep_secs INTEGER NOT NULL,
  PRIMARY KEY(trip_id, seq)) WITHOUT ROWID;
CREATE TABLE rail_calendar(
  service_id TEXT PRIMARY KEY, mon INTEGER NOT NULL, tue INTEGER NOT NULL, wed INTEGER NOT NULL, thu INTEGER NOT NULL,
  fri INTEGER NOT NULL, sat INTEGER NOT NULL, sun INTEGER NOT NULL, start_date INTEGER NOT NULL, end_date INTEGER NOT NULL);
CREATE TABLE rail_calendar_dates(
  service_id TEXT NOT NULL, date INTEGER NOT NULL, added INTEGER NOT NULL, PRIMARY KEY(service_id, date)) WITHOUT ROWID;

CREATE TABLE atac_stops(
  stop_id TEXT PRIMARY KEY, name TEXT NOT NULL, name_lc TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE atac_routes(
  route_id TEXT PRIMARY KEY, short_name TEXT NOT NULL, long_name TEXT NOT NULL, kind INTEGER NOT NULL,
  operator TEXT NOT NULL, color TEXT, short_lc TEXT NOT NULL, long_lc TEXT NOT NULL);
CREATE TABLE atac_shapes(
  route_id TEXT NOT NULL, shape_id TEXT NOT NULL, polyline TEXT NOT NULL,
  min_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lat REAL NOT NULL, max_lon REAL NOT NULL);
CREATE TABLE atac_trips(trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT, headsign TEXT);
CREATE TABLE atac_stop_routes(
  stop_id TEXT NOT NULL, route_id TEXT NOT NULL, PRIMARY KEY(stop_id, route_id)) WITHOUT ROWID;
CREATE TABLE atac_stop_headsign(
  route_id TEXT NOT NULL, stop_id TEXT NOT NULL, headsign TEXT NOT NULL, PRIMARY KEY(route_id, stop_id)) WITHOUT ROWID;
CREATE TABLE atac_service_dates(
  date INTEGER NOT NULL, service_id TEXT NOT NULL, PRIMARY KEY(date, service_id)) WITHOUT ROWID;
CREATE TABLE atac_stop_times_raw(stop_id TEXT NOT NULL, dep_secs INTEGER NOT NULL, trip_rid INTEGER NOT NULL);
SQL);
    }

    private function createIndexes(): void
    {
        $this->log('indexes + compact atac_stop_times');
        $this->db->exec(<<<'SQL'
CREATE INDEX cotral_stops_latlon ON cotral_stops(lat, lon);
CREATE INDEX cotral_stop_routes_route ON cotral_stop_routes(route_id, stop_id);
CREATE INDEX cotral_rail_shapes_route ON cotral_rail_shapes(route_id);
CREATE INDEX rail_trips_route ON rail_trips(route_id);
CREATE INDEX rail_stop_times_stop ON rail_stop_times(stop_id);
CREATE INDEX atac_stops_latlon ON atac_stops(lat, lon);
CREATE INDEX atac_stops_name ON atac_stops(name);
CREATE INDEX atac_shapes_route ON atac_shapes(route_id);
CREATE INDEX atac_stop_routes_route ON atac_stop_routes(route_id, stop_id);
CREATE INDEX atac_stop_headsign_stop ON atac_stop_headsign(stop_id);
CREATE TABLE atac_stop_times(
  stop_id TEXT NOT NULL, dep_secs INTEGER NOT NULL, trip_rid INTEGER NOT NULL,
  PRIMARY KEY(stop_id, dep_secs, trip_rid)) WITHOUT ROWID;
INSERT OR IGNORE INTO atac_stop_times SELECT stop_id, dep_secs, trip_rid FROM atac_stop_times_raw ORDER BY stop_id, dep_secs, trip_rid;
DROP TABLE atac_stop_times_raw;
SQL);
        $this->stats['atac_stop_times'] = (int) $this->db->query('SELECT COUNT(*) FROM atac_stop_times')->fetchColumn();
    }

    /** @param array<string,string> $sourceInfo */
    private function writeMeta(array $sourceInfo): void
    {
        $meta = ['built_at' => gmdate('c'), 'schema_version' => '1'] + $sourceInfo;
        $q = $this->db->prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)');
        foreach ($meta as $k => $v) {
            $q->execute([$k, $v]);
        }
        foreach (['cotral_stops', 'cotral_routes', 'cotral_stop_routes', 'cotral_rail_shapes', 'rail_trips', 'rail_stop_times',
                  'rail_calendar', 'rail_calendar_dates', 'atac_stops', 'atac_routes', 'atac_shapes', 'atac_trips',
                  'atac_stop_routes', 'atac_stop_headsign', 'atac_service_dates'] as $t) {
            $this->stats[$t] = (int) $this->db->query("SELECT COUNT(*) FROM $t")->fetchColumn();
        }
    }

    // ------------------------------------------------------------------ Cotral

    /** @var array<string,array<int,true>> stop_id => set of route indexes (Cotral bus + rail) */
    private array $cotralPairs = [];
    /** @var list<string> route index => route_id (Cotral, "F:" namespaced for rail) */
    private array $cotralRouteIds = [];
    /** @var array<string,int> */
    private array $cotralRouteIdx = [];

    private function cotralRouteIndex(string $routeId): int
    {
        return $this->cotralRouteIdx[$routeId] ??= (function () use ($routeId): int {
            $this->cotralRouteIds[] = $routeId;
            return count($this->cotralRouteIds) - 1;
        })();
    }

    private function loadCotralBus(FeedSource $src): void
    {
        $this->log('Cotral bus: stops/routes/trips');
        $this->loadCotralStops($src, false);
        $this->loadCotralRoutes($src, false);

        // trips.txt: route_id, service_id, trip_id, ... -> trip_id => route index
        $tripRoute = [];
        $h = $this->need($src, 'trips.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) > 2) {
                $tripRoute[$f[2]] = $this->cotralRouteIndex($f[0]);
            }
        }
        $src->close($h);
        $this->log('Cotral bus: stop_times (' . count($tripRoute) . ' trips)');
        $this->streamCotralStopTimes($src, $tripRoute);
    }

    /** @param array<int|string,int> $tripRoute */
    private function streamCotralStopTimes(FeedSource $src, array $tripRoute): void
    {
        $h = $this->need($src, 'stop_times.txt');
        fgets($h); // header
        $rows = 0;
        $pairs = &$this->cotralPairs;
        while (($line = fgets($h)) !== false) {
            if (strpos($line, '"') !== false) {
                $line = str_replace('"', '', $line);
            }
            $p = explode(',', $line, 5);
            if (!isset($p[3])) {
                continue;
            }
            $ri = $tripRoute[$p[0]] ?? null;
            if ($ri === null) {
                continue;
            }
            $stop = trim($p[3]);
            if ($stop === '') {
                continue;
            }
            $pairs[$stop][$ri] = true;
            $rows++;
        }
        $src->close($h);
        $this->log("  $rows stop_times rows scanned");
    }

    private function loadCotralStops(FeedSource $src, bool $isRail): void
    {
        $ins = new BatchInsert($this->db, 'cotral_stops', ['stop_id', 'name', 'name_lc', 'locality', 'lat', 'lon', 'is_rail'], 140, 'INSERT OR REPLACE');
        $h = $this->need($src, 'stops.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 3) {
                continue;
            }
            $name = Text::stripTrailingHashCode($f[1]);
            $ins->add([
                $f[0], $name, Text::lower($name), Text::extractLocality($name),
                is_numeric($f[2]) ? (float) $f[2] : 0.0, is_numeric($f[3]) ? (float) $f[3] : 0.0,
                $isRail ? 1 : 0,
            ]);
        }
        $src->close($h);
        $ins->finish();
    }

    private function loadCotralRoutes(FeedSource $src, bool $isRail): void
    {
        $prefix = $isRail ? 'F:' : '';
        $ins = new BatchInsert($this->db, 'cotral_routes', ['route_id', 'short_name', 'long_name', 'is_rail', 'short_lc', 'long_lc'], 150, 'INSERT OR REPLACE');
        $h = $this->need($src, 'routes.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 3) {
                continue;
            }
            $long = Text::stripTrailingHashCode($f[3]);
            $ins->add([$prefix . $f[0], $f[2], $long, $isRail ? 1 : 0, Text::lower($f[2]), Text::lower($long)]);
        }
        $src->close($h);
        $ins->finish();
    }

    private function loadCotralRail(FeedSource $src): void
    {
        $this->log('Cotral rail');
        $this->loadCotralStops($src, true);
        $this->loadCotralRoutes($src, true);

        // trips.txt: route_id, service_id, trip_id, direction_id, shape_id
        $tripRoute = [];
        $routeShapes = [];
        $trips = new BatchInsert($this->db, 'rail_trips', ['trip_id', 'route_id', 'service_id'], 200, 'INSERT OR REPLACE');
        $h = $this->need($src, 'trips.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 2) {
                continue;
            }
            $route = 'F:' . $f[0];
            $trips->add([$f[2], $route, $f[1]]);
            $tripRoute[$f[2]] = $this->cotralRouteIndex($route);
            if (isset($f[4]) && $f[4] !== '') {
                $routeShapes[$route][$f[4]] = true;
            }
        }
        $src->close($h);
        $trips->finish();

        // stop_times.txt (departure_time = col 2, stop_sequence = col 4), tiny file -> full parser
        $st = new BatchInsert($this->db, 'rail_stop_times', ['trip_id', 'seq', 'stop_id', 'dep_secs'], 200, 'INSERT OR REPLACE');
        $h = $this->need($src, 'stop_times.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 4) {
                continue;
            }
            // stop->route membership counts every row (like GTFSParsing.parseStopTimes)
            $ri = $tripRoute[$f[0]] ?? null;
            $stop = trim($f[3]);
            if ($ri !== null && $stop !== '') {
                $this->cotralPairs[$stop][$ri] = true;
            }
            $dep = Csv::timeToSeconds($f[2]);
            if ($dep === null || !preg_match('/^[+-]?\d+$/', $f[4])) {
                continue;
            }
            $st->add([$f[0], (int) $f[4], $f[3], $dep]);
        }
        $src->close($h);
        $st->finish();

        // calendar.txt: service_id, monday..sunday, start_date, end_date (optional file)
        $cal = new BatchInsert($this->db, 'rail_calendar', ['service_id', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'start_date', 'end_date'], 90, 'INSERT OR REPLACE');
        if (($h = $src->open('calendar.txt')) !== null) {
            foreach (Csv::rows($h) as $f) {
                if (count($f) <= 9 || !ctype_digit($f[8]) || !ctype_digit($f[9])) {
                    continue;
                }
                $row = [$f[0]];
                for ($i = 1; $i <= 7; $i++) {
                    $row[] = $f[$i] === '1' ? 1 : 0;
                }
                $row[] = (int) $f[8];
                $row[] = (int) $f[9];
                $cal->add($row);
            }
            $src->close($h);
        }
        $cal->finish();

        $cd = new BatchInsert($this->db, 'rail_calendar_dates', ['service_id', 'date', 'added'], 200, 'INSERT OR REPLACE');
        if (($h = $src->open('calendar_dates.txt')) !== null) {
            foreach (Csv::rows($h) as $f) {
                if (count($f) > 2 && ctype_digit($f[1])) {
                    $cd->add([$f[0], (int) $f[1], $f[2] === '1' ? 1 : 0]);
                }
            }
            $src->close($h);
        }
        $cd->finish();

        if ($src->has('shapes.txt')) {
            $this->log('Cotral rail: shapes');
            $this->buildShapes($src, $routeShapes, 'cotral_rail_shapes');
        }
    }

    private function writeCotralStopRoutes(): void
    {
        $this->log('cotral_stop_routes (' . count($this->cotralPairs) . ' stops)');
        ksort($this->cotralPairs, SORT_STRING);
        $ins = new BatchInsert($this->db, 'cotral_stop_routes', ['stop_id', 'route_id'], 400, 'INSERT OR IGNORE');
        foreach ($this->cotralPairs as $stop => $routes) {
            $stop = (string) $stop;
            $ids = [];
            foreach ($routes as $ri => $_) {
                $ids[] = $this->cotralRouteIds[$ri];
            }
            sort($ids, SORT_STRING);
            foreach ($ids as $rid) {
                $ins->add([$stop, $rid]);
            }
        }
        $ins->finish();
        $this->cotralPairs = [];
    }

    // ------------------------------------------------------------------ Atac

    private function loadAtac(FeedSource $src): void
    {
        $this->log('Atac: stops/routes');
        $ins = new BatchInsert($this->db, 'atac_stops', ['stop_id', 'name', 'name_lc', 'lat', 'lon'], 190, 'INSERT OR REPLACE');
        $h = $this->need($src, 'stops.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 5 || !is_numeric($f[4]) || !is_numeric($f[5])) {
                continue;
            }
            $ins->add([$f[0], $f[2], Text::lower($f[2]), (float) $f[4], (float) $f[5]]);
        }
        $src->close($h);
        $ins->finish();

        $ins = new BatchInsert($this->db, 'atac_routes', ['route_id', 'short_name', 'long_name', 'kind', 'operator', 'color', 'short_lc', 'long_lc'], 120, 'INSERT OR REPLACE');
        $h = $this->need($src, 'routes.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 6) {
                continue;
            }
            $type = preg_match('/^[+-]?\d+$/', $f[4]) ? (int) $f[4] : 3;
            $color = Text::trimWs($f[6]);
            $ins->add([
                $f[0], $f[2], $f[3], $type, $f[1] === 'OP1' ? 'Atac' : 'Roma TPL',
                $color === '' ? null : $color, Text::lower($f[2]), Text::lower($f[3]),
            ]);
        }
        $src->close($h);
        $ins->finish();

        // trips.txt: route_id, service_id, trip_id, trip_headsign, ..., shape_id (col 7); quote-aware
        $this->log('Atac: trips');
        $tripIdx = [];        // trip_id => internal id (= atac_trips.rowid)
        $tripRoute = [];      // internal id => route index
        $tripHead = [];       // internal id => headsign index or -1
        $routeIds = [];       // route index => route_id
        $routeIdx = [];
        $headIdx = [];        // cleaned headsign => index
        $heads = [];          // index => cleaned headsign
        $headCache = [];      // raw => index|-1
        $routeShapes = [];
        $trips = new BatchInsert($this->db, 'atac_trips', ['rowid', 'trip_id', 'route_id', 'service_id', 'headsign'], 190, 'INSERT OR REPLACE');
        $h = $this->need($src, 'trips.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) <= 7 || $f[0] === '') {
                continue;
            }
            [$route, $service, $trip, $rawHead, $shape] = [$f[0], $f[1], $f[2], $f[3], $f[7]];
            if ($trip !== '') {
                $ri = $routeIdx[$route] ??= (function () use ($route, &$routeIds): int {
                    $routeIds[] = $route;
                    return count($routeIds) - 1;
                })();
                $hi = $headCache[$rawHead] ??= (function () use ($rawHead, &$headIdx, &$heads): int {
                    $clean = Text::cleanHeadsign($rawHead);
                    if ($clean === null) {
                        return -1;
                    }
                    return $headIdx[$clean] ??= (function () use ($clean, &$heads): int {
                        $heads[] = $clean;
                        return count($heads) - 1;
                    })();
                })();
                $id = $tripIdx[$trip] ?? null;
                if ($id === null) {
                    $id = count($tripRoute) + 1;
                    $tripIdx[$trip] = $id;
                }
                $tripRoute[$id - 1] = $ri;
                $tripHead[$id - 1] = $hi;
                $trips->add([$id, $trip, $route, $service === '' ? null : $service, $hi >= 0 ? $heads[$hi] : null]);
            }
            if ($shape !== '') {
                $routeShapes[$route][$shape] = true;
            }
        }
        $src->close($h);
        $trips->finish();
        $this->log('  ' . count($tripIdx) . ' trips');

        $this->log('Atac: shapes');
        $this->buildShapes($src, $routeShapes, 'atac_shapes');
        unset($routeShapes);

        $this->log('Atac: stop_times');
        $pairs = $this->streamAtacStopTimes($src, $tripIdx, $tripRoute, $tripHead);

        $this->log('Atac: stop_routes / stop_headsign (' . count($pairs) . ' stops)');
        ksort($pairs, SORT_STRING);
        $sr = new BatchInsert($this->db, 'atac_stop_routes', ['stop_id', 'route_id'], 400, 'INSERT OR IGNORE');
        $sh = new BatchInsert($this->db, 'atac_stop_headsign', ['route_id', 'stop_id', 'headsign'], 250, 'INSERT OR IGNORE');
        foreach ($pairs as $stop => $routes) {
            $stop = (string) $stop;
            foreach ($routes as $ri => $hi) {
                $sr->add([$stop, $routeIds[$ri]]);
                if ($hi >= 0) {
                    $sh->add([$routeIds[$ri], $stop, $heads[$hi]]);
                }
            }
        }
        $sr->finish();
        $sh->finish();
        unset($pairs);

        // calendar_dates.txt: service_id, date, exception_type (this feed has no calendar.txt: explicit list)
        $cd = new BatchInsert($this->db, 'atac_service_dates', ['date', 'service_id'], 400, 'INSERT OR IGNORE');
        $h = $this->need($src, 'calendar_dates.txt');
        foreach (Csv::rows($h) as $f) {
            if (count($f) >= 3 && $f[2] === '1' && ctype_digit($f[1])) {
                $cd->add([(int) $f[1], $f[0]]);
            }
        }
        $src->close($h);
        $cd->finish();
    }

    /**
     * @param array<int|string,int> $tripIdx
     * @param array<int,int> $tripRoute
     * @param array<int,int> $tripHead
     * @return array<int|string,array<int,int>> stop_id => [route index => headsign index|-1]
     */
    private function streamAtacStopTimes(FeedSource $src, array $tripIdx, array $tripRoute, array $tripHead): array
    {
        $raw = new BatchInsert($this->db, 'atac_stop_times_raw', ['stop_id', 'dep_secs', 'trip_rid'], 330);
        $h = $this->need($src, 'stop_times.txt');
        fgets($h);
        $pairs = [];
        $rows = 0;
        $kept = 0;
        while (($line = fgets($h)) !== false) {
            if (strpos($line, '"') !== false) {
                $line = str_replace('"', '', $line);
            }
            $p = explode(',', $line, 5);
            if (!isset($p[3])) {
                continue;
            }
            $id = $tripIdx[$p[0]] ?? null;
            if ($id === null) {
                continue;
            }
            $rows++;
            $stop = $p[3];
            $ri = $tripRoute[$id - 1];
            $hi = $tripHead[$id - 1];
            $cur = $pairs[$stop][$ri] ?? -2;
            if ($cur === -2 || ($cur === -1 && $hi >= 0)) {
                $pairs[$stop][$ri] = $hi;
            }
            $dep = Csv::timeToSeconds($p[2]);
            if ($dep !== null) {
                $raw->add([$stop, $dep, $id]);
                $kept++;
            }
        }
        $src->close($h);
        $raw->finish();
        $this->log("  $rows rows matched a trip, $kept with a departure time");
        return $pairs;
    }

    // ------------------------------------------------------------------ shapes

    /**
     * Streams shapes.txt, keeping only the shapes some trip uses, and stores one encoded polyline
     * per (route_id, shape_id).
     *
     * @param array<string,array<int|string,true>> $routeShapes route_id => set of shape_id
     */
    private function buildShapes(FeedSource $src, array $routeShapes, string $table): void
    {
        $wanted = [];
        foreach ($routeShapes as $set) {
            foreach ($set as $sid => $_) {
                $wanted[(string) $sid] = true;
            }
        }
        /** @var array<string,string> $buf shape_id => packed (seq, latE5, lonE5)* */
        $buf = [];
        $h = $this->need($src, 'shapes.txt');
        fgets($h);
        while (($line = fgets($h)) !== false) {
            if (strpos($line, '"') !== false) {
                $line = str_replace('"', '', $line);
            }
            $p = explode(',', $line, 5);
            if (!isset($p[3])) {
                continue;
            }
            if (!isset($wanted[$p[0]]) || !is_numeric($p[1]) || !is_numeric($p[2])) {
                continue;
            }
            $seq = trim($p[3]);
            if ($seq === '' || !ctype_digit($seq)) {
                continue;
            }
            $buf[$p[0]] = ($buf[$p[0]] ?? '') . pack('l3', (int) $seq, (int) round((float) $p[1] * 1e5), (int) round((float) $p[2] * 1e5));
        }
        $src->close($h);

        $ins = new BatchInsert($this->db, $table, ['route_id', 'shape_id', 'polyline', 'min_lat', 'min_lon', 'max_lat', 'max_lon'], 100);
        $encoded = [];
        foreach ($routeShapes as $route => $set) {
            foreach ($set as $sid => $_) {
                $sid = (string) $sid;
                if (!isset($buf[$sid])) {
                    continue;
                }
                if (!isset($encoded[$sid])) {
                    $encoded[$sid] = $this->encodeShape($buf[$sid]);
                }
                if ($encoded[$sid] === null) {
                    continue;
                }
                $e = $encoded[$sid];
                $ins->add([(string) $route, $sid, $e[0], $e[1], $e[2], $e[3], $e[4]]);
            }
        }
        $n = $ins->finish();
        $this->log("  $table: $n shapes");
    }

    /** @return array{0:string,1:float,2:float,3:float,4:float}|null polyline + bbox [minLat,minLon,maxLat,maxLon] */
    private function encodeShape(string $packed): ?array
    {
        $v = unpack('l*', $packed);
        $n = intdiv(count($v), 3);
        if ($n < 2) {
            return null;
        }
        $pts = [];
        $sorted = true;
        $prev = null;
        for ($i = 0; $i < $n; $i++) {
            $seq = $v[$i * 3 + 1];
            if ($prev !== null && $seq < $prev) {
                $sorted = false;
            }
            $prev = $seq;
            $pts[] = [$seq, $v[$i * 3 + 2], $v[$i * 3 + 3]];
        }
        if (!$sorted) {
            usort($pts, static fn ($a, $b) => $a[0] <=> $b[0]);
        }
        $minLat = $minLon = PHP_INT_MAX;
        $maxLat = $maxLon = PHP_INT_MIN;
        $line = [];
        foreach ($pts as [, $lat, $lon]) {
            $line[] = [$lat, $lon];
            $minLat = min($minLat, $lat);
            $maxLat = max($maxLat, $lat);
            $minLon = min($minLon, $lon);
            $maxLon = max($maxLon, $lon);
        }
        return [Polyline::encode($line), $minLat / 1e5, $minLon / 1e5, $maxLat / 1e5, $maxLon / 1e5];
    }

    /** @return resource */
    private function need(FeedSource $src, string $file)
    {
        $h = $src->open($file);
        if ($h === null) {
            throw new \RuntimeException("File GTFS mancante: $file");
        }
        return $h;
    }
}
