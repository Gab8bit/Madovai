<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

use Madovai\BadRequest;
use Madovai\Db;
use Madovai\Rome;

/**
 * Read access to data/madovai.sqlite (ports of GTFSStore / AtacGtfsStore / PolesRepository queries).
 * Every user-supplied value goes through bound parameters.
 */
final class Store
{
    public function __construct(private \PDO $db)
    {
    }

    public static function open(): self
    {
        return new self(Db::gtfs());
    }

    // ------------------------------------------------------------------ mapping helpers

    /** @param array<string,mixed> $r cotral_routes row */
    public static function cotralRoute(array $r): array
    {
        $rail = (int) $r['is_rail'] === 1;
        return [
            'source' => 'cotral',
            'id' => (string) $r['route_id'],
            'shortName' => (string) $r['short_name'],
            'longName' => (string) $r['long_name'],
            'displayName' => (string) $r['short_name'],
            'kind' => $rail ? 'treno' : 'bus',
            'operator' => 'Cotral',
            'color' => null,
            'rail' => $rail,
        ];
    }

    /** @param array<string,mixed> $r atac_routes row */
    public static function atacRoute(array $r): array
    {
        $short = (string) $r['short_name'];
        $long = (string) $r['long_name'];
        return [
            'source' => 'atac',
            'id' => (string) $r['route_id'],
            'shortName' => $short,
            'longName' => $long,
            'displayName' => Text::metroName($short) ?? ($long === '' ? $short : $long),
            'kind' => Text::kindName((int) $r['kind']),
            'operator' => (string) $r['operator'],
            'color' => ($r['color'] ?? '') === '' ? null : (string) $r['color'],
            'rail' => false,
        ];
    }

    /** @param array<string,mixed> $r */
    private static function cotralStop(array $r): array
    {
        return [
            'source' => 'cotral',
            'id' => (string) $r['stop_id'],
            'name' => (string) $r['name'],
            'lat' => (float) $r['lat'],
            'lon' => (float) $r['lon'],
            'rail' => (int) $r['is_rail'] === 1,
        ];
    }

    /** @param array<string,mixed> $r */
    private static function atacStopRow(array $r): array
    {
        return [
            'source' => 'atac',
            'id' => (string) $r['stop_id'],
            'name' => (string) $r['name'],
            'lat' => (float) $r['lat'],
            'lon' => (float) $r['lon'],
            'rail' => false,
        ];
    }

    // ------------------------------------------------------------------ stops.php

    /**
     * Stops inside the bbox, nearest to its centre first (iOS returned the first N in file order).
     *
     * @return array{cotral:list<array<string,mixed>>,atac:list<array<string,mixed>>}
     */
    public function stopsInBox(float $minLat, float $minLon, float $maxLat, float $maxLon, int $cotralLimit, int $atacLimit): array
    {
        $cLat = ($minLat + $maxLat) / 2;
        $cLon = ($minLon + $maxLon) / 2;
        // Equirectangular distance (a degree of longitude is shorter than one of latitude).
        $k = cos(deg2rad($cLat)) ** 2;
        $dist = '((lat - :cLat) * (lat - :cLat) + (lon - :cLon) * (lon - :cLon) * :k)';

        $q = $this->db->prepare(
            "SELECT stop_id, name, lat, lon, is_rail FROM cotral_stops
             WHERE lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon
             ORDER BY $dist, stop_id LIMIT :lim"
        );
        $this->bindBox($q, $minLat, $minLon, $maxLat, $maxLon, $cLat, $cLon, $k);
        $q->bindValue(':lim', $cotralLimit, \PDO::PARAM_INT);
        $q->execute();
        $cotral = [];
        foreach ($q->fetchAll() as $r) {
            $name = (string) $r['name'];
            $cotral[] = [
                'id' => (string) $r['stop_id'],
                'name' => $name,
                'locality' => Text::extractLocality($name),
                'lat' => (float) $r['lat'],
                'lon' => (float) $r['lon'],
                'rail' => (int) $r['is_rail'] === 1,
            ];
        }

        $q = $this->db->prepare(
            "SELECT stop_id, name, lat, lon FROM atac_stops
             WHERE lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon
             ORDER BY $dist, stop_id LIMIT :lim"
        );
        $this->bindBox($q, $minLat, $minLon, $maxLat, $maxLon, $cLat, $cLon, $k);
        $q->bindValue(':lim', $atacLimit, \PDO::PARAM_INT);
        $q->execute();
        $atac = [];
        foreach ($q->fetchAll() as $r) {
            $atac[] = ['id' => (string) $r['stop_id'], 'name' => (string) $r['name'], 'lat' => (float) $r['lat'], 'lon' => (float) $r['lon']];
        }
        return ['cotral' => $cotral, 'atac' => $atac];
    }

    private function bindBox(\PDOStatement $q, float $minLat, float $minLon, float $maxLat, float $maxLon, float $cLat, float $cLon, float $k): void
    {
        foreach ([':minLat' => $minLat, ':minLon' => $minLon, ':maxLat' => $maxLat, ':maxLon' => $maxLon, ':cLat' => $cLat, ':cLon' => $cLon, ':k' => $k] as $name => $v) {
            $q->bindValue($name, $v, \PDO::PARAM_STR); // text -> SQLite coerces to REAL by column affinity/arithmetic
        }
    }

    // ------------------------------------------------------------------ search.php

    /** @return array{stops:list<array<string,mixed>>,routes:list<array<string,mixed>>} */
    public function search(string $query): array
    {
        $q = Text::lower(Text::trimWs(mb_substr($query, 0, 100)));
        if ($q === '') {
            return ['stops' => [], 'routes' => []];
        }
        $like = '%' . Text::likeEscape($q) . '%';

        $stops = [];
        $st = $this->db->prepare("SELECT stop_id, name, lat, lon, is_rail FROM cotral_stops WHERE name_lc LIKE :q ESCAPE '\\' ORDER BY rowid LIMIT 15");
        $st->execute([':q' => $like]);
        foreach ($st->fetchAll() as $r) {
            $stops[] = self::cotralStop($r);
        }
        $st = $this->db->prepare("SELECT stop_id, name, lat, lon FROM atac_stops WHERE name_lc LIKE :q ESCAPE '\\' ORDER BY rowid LIMIT 15");
        $st->execute([':q' => $like]);
        $atacRows = $st->fetchAll();
        $metro = $this->metroStopIds(array_map(static fn (array $r): string => (string) $r['stop_id'], $atacRows));
        foreach ($atacRows as $r) {
            $row = self::atacStopRow($r);
            $row['metro'] = isset($metro[$row['id']]);
            $stops[] = $row;
        }

        $routes = [];
        $st = $this->db->prepare(
            "SELECT * FROM cotral_routes WHERE short_lc LIKE :q ESCAPE '\\' OR long_lc LIKE :q ESCAPE '\\'
             ORDER BY short_name, route_id LIMIT 10"
        );
        $st->execute([':q' => $like]);
        foreach ($st->fetchAll() as $r) {
            $routes[] = self::cotralRoute($r);
        }
        $st = $this->db->prepare(
            "SELECT * FROM atac_routes WHERE short_lc LIKE :q ESCAPE '\\' OR long_lc LIKE :q ESCAPE '\\'
             ORDER BY short_name, route_id LIMIT 10"
        );
        $st->execute([':q' => $like]);
        foreach ($st->fetchAll() as $r) {
            $routes[] = self::atacRoute($r);
        }
        return ['stops' => $stops, 'routes' => $routes];
    }

    /** Route ids of Rome's metro lines (ReminderFormView.metroStopIds). */
    public const METRO_ROUTE_IDS = ['MEA', 'MEB', 'MEB1', 'MEC'];

    /**
     * Which of `$stopIds` are served by at least one metro route — one query for the whole batch.
     *
     * @param list<string> $stopIds
     * @return array<string,true>
     */
    public function metroStopIds(array $stopIds): array
    {
        if ($stopIds === []) {
            return [];
        }
        $inStops = implode(',', array_fill(0, count($stopIds), '?'));
        $inRoutes = implode(',', array_fill(0, count(self::METRO_ROUTE_IDS), '?'));
        $st = $this->db->prepare("SELECT DISTINCT stop_id FROM atac_stop_routes WHERE route_id IN ($inRoutes) AND stop_id IN ($inStops)");
        $st->execute(array_merge(self::METRO_ROUTE_IDS, $stopIds));
        $out = [];
        foreach ($st->fetchAll(\PDO::FETCH_COLUMN) as $id) {
            $out[(string) $id] = true;
        }
        return $out;
    }

    // ------------------------------------------------------------------ lines.php / line.php

    /** @return array{atac:list<array<string,mixed>>,cotralRail:list<array<string,mixed>>} */
    public function lines(): array
    {
        $atac = [];
        foreach ($this->db->query('SELECT * FROM atac_routes ORDER BY short_name, route_id') as $r) {
            $atac[] = self::atacRoute($r);
        }
        $rail = [];
        foreach ($this->db->query('SELECT * FROM cotral_routes WHERE is_rail = 1 ORDER BY short_name, route_id') as $r) {
            $rail[] = self::cotralRoute($r);
        }
        return ['atac' => $atac, 'cotralRail' => $rail];
    }

    /** @return array{route:array<string,mixed>,stops:list<array<string,mixed>>,shapes:list<array<string,mixed>>} */
    public function line(string $source, string $id): array
    {
        if ($source === 'atac') {
            $st = $this->db->prepare('SELECT * FROM atac_routes WHERE route_id = ?');
            $st->execute([$id]);
            $row = $st->fetch();
            if (!$row) {
                throw new BadRequest('Linea inesistente');
            }
            $st = $this->db->prepare(
                'SELECT s.stop_id, s.name, s.lat, s.lon, h.headsign
                 FROM atac_stop_routes sr
                 JOIN atac_stops s ON s.stop_id = sr.stop_id
                 LEFT JOIN atac_stop_headsign h ON h.route_id = sr.route_id AND h.stop_id = sr.stop_id
                 WHERE sr.route_id = ? ORDER BY s.name, s.stop_id'
            );
            $st->execute([$id]);
            $stops = [];
            foreach ($st->fetchAll() as $r) {
                $stops[] = $this->stopWithHeadsign($r);
            }
            $st = $this->db->prepare('SELECT shape_id, polyline, min_lat, min_lon, max_lat, max_lon FROM atac_shapes WHERE route_id = ? ORDER BY rowid');
            $st->execute([$id]);
            return ['route' => self::atacRoute($row), 'stops' => $stops, 'shapes' => $this->shapeRows($st->fetchAll())];
        }

        if ($source !== 'cotral') {
            throw new BadRequest("Parametro 'source' non valido");
        }
        $st = $this->db->prepare('SELECT * FROM cotral_routes WHERE route_id = ?');
        $st->execute([$id]);
        $row = $st->fetch();
        if (!$row) {
            throw new BadRequest('Linea inesistente');
        }
        $route = self::cotralRoute($row);
        $stops = [];
        $shapes = [];
        if ($route['rail']) {
            foreach ($this->railStopsInOrder($id) as $r) {
                $stops[] = $this->stopWithHeadsign($r);
            }
            $st = $this->db->prepare('SELECT shape_id, polyline, min_lat, min_lon, max_lat, max_lon FROM cotral_rail_shapes WHERE route_id = ? ORDER BY rowid');
            $st->execute([$id]);
            $shapes = $this->shapeRows($st->fetchAll());
        } else {
            $st = $this->db->prepare(
                'SELECT s.stop_id, s.name, s.lat, s.lon FROM cotral_stop_routes sr
                 JOIN cotral_stops s ON s.stop_id = sr.stop_id WHERE sr.route_id = ? ORDER BY s.stop_id'
            );
            $st->execute([$id]);
            foreach ($st->fetchAll() as $r) {
                $stops[] = $this->stopWithHeadsign($r);
            }
        }
        return ['route' => $route, 'stops' => $stops, 'shapes' => $shapes];
    }

    /** @param array<string,mixed> $r */
    private function stopWithHeadsign(array $r): array
    {
        $h = $r['headsign'] ?? null;
        return [
            'id' => (string) $r['stop_id'],
            'name' => (string) $r['name'],
            'lat' => (float) $r['lat'],
            'lon' => (float) $r['lon'],
            'headsign' => ($h === null || $h === '') ? null : (string) $h,
        ];
    }

    /**
     * Port of GTFSStore.stopsForRouteInOrder: the longest trip of the route (ties: lowest trip_id),
     * its stations in stop_sequence order (stations missing from stops.txt are skipped).
     *
     * @return list<array<string,mixed>>
     */
    public function railStopsInOrder(string $routeId): array
    {
        $st = $this->db->prepare(
            'SELECT t.trip_id FROM rail_trips t JOIN rail_stop_times s ON s.trip_id = t.trip_id
             WHERE t.route_id = ? GROUP BY t.trip_id ORDER BY COUNT(*) DESC, t.trip_id ASC LIMIT 1'
        );
        $st->execute([$routeId]);
        $trip = $st->fetchColumn();
        if ($trip === false) {
            $st = $this->db->prepare(
                'SELECT s.stop_id, s.name, s.lat, s.lon FROM cotral_stop_routes sr
                 JOIN cotral_stops s ON s.stop_id = sr.stop_id WHERE sr.route_id = ? ORDER BY s.stop_id'
            );
            $st->execute([$routeId]);
            return $st->fetchAll();
        }
        $st = $this->db->prepare(
            'SELECT s.stop_id, s.name, s.lat, s.lon FROM rail_stop_times x
             JOIN cotral_stops s ON s.stop_id = x.stop_id WHERE x.trip_id = ? ORDER BY x.seq'
        );
        $st->execute([$trip]);
        return $st->fetchAll();
    }

    /**
     * @param list<array<string,mixed>> $rows
     * @return list<array<string,mixed>>
     */
    private function shapeRows(array $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            $out[] = [
                'id' => (string) $r['shape_id'],
                'coords' => (string) $r['polyline'],
                'bbox' => [(float) $r['min_lat'], (float) $r['min_lon'], (float) $r['max_lat'], (float) $r['max_lon']],
            ];
        }
        return $out;
    }

    // ------------------------------------------------------------------ shapes.php

    /** @return list<array<string,mixed>> Atac shapes whose bbox intersects the box (port of shapesInRegion) */
    public function shapesInBox(float $minLat, float $minLon, float $maxLat, float $maxLon, int $limit): array
    {
        $st = $this->db->prepare(
            'SELECT s.shape_id, s.route_id, s.polyline, s.min_lat, s.min_lon, s.max_lat, s.max_lon, r.kind, r.color
             FROM atac_shapes s LEFT JOIN atac_routes r ON r.route_id = s.route_id
             WHERE s.min_lat <= :maxLat AND s.max_lat >= :minLat AND s.min_lon <= :maxLon AND s.max_lon >= :minLon
             ORDER BY s.rowid LIMIT :lim'
        );
        $st->bindValue(':minLat', $minLat);
        $st->bindValue(':minLon', $minLon);
        $st->bindValue(':maxLat', $maxLat);
        $st->bindValue(':maxLon', $maxLon);
        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $st->execute();
        $out = [];
        foreach ($st->fetchAll() as $r) {
            $color = $r['color'] ?? null;
            $out[] = [
                'id' => (string) $r['shape_id'],
                'routeId' => (string) $r['route_id'],
                'kind' => Text::kindName($r['kind'] === null ? 3 : (int) $r['kind']),
                'color' => ($color === null || $color === '') ? null : (string) $color,
                'coords' => (string) $r['polyline'],
                'bbox' => [(float) $r['min_lat'], (float) $r['min_lon'], (float) $r['max_lat'], (float) $r['max_lon']],
            ];
        }
        return $out;
    }

    // ------------------------------------------------------------------ atac-stop.php / atac-schedule.php

    /**
     * Every platform sharing the (trimmed) name of `$stopId` (AtacGtfsStore.stopsSharingName), by stop_id.
     *
     * @return array{name:string,stops:list<array<string,mixed>>}
     */
    public function atacStopGroup(string $stopId, ?string $routeId): array
    {
        $st = $this->db->prepare('SELECT name FROM atac_stops WHERE stop_id = ?');
        $st->execute([$stopId]);
        $name = $st->fetchColumn();
        if ($name === false) {
            throw new BadRequest('Fermata inesistente');
        }
        $name = Text::trimWs((string) $name);

        $st = $this->db->prepare("SELECT stop_id, name, lat, lon FROM atac_stops WHERE trim(name, ' ' || char(9)) = :n ORDER BY stop_id");
        $st->execute([':n' => $name]);
        $rows = $st->fetchAll();

        $byRoute = $this->db->prepare('SELECT headsign FROM atac_stop_headsign WHERE route_id = ? AND stop_id = ?');
        $any = $this->db->prepare('SELECT headsign FROM atac_stop_headsign WHERE stop_id = ? ORDER BY route_id LIMIT 1');
        $stops = [];
        foreach ($rows as $r) {
            if ($routeId !== null) {
                $byRoute->execute([$routeId, $r['stop_id']]);
                $h = $byRoute->fetchColumn();
            } else {
                $any->execute([$r['stop_id']]);
                $h = $any->fetchColumn();
            }
            $r['headsign'] = $h === false ? null : $h;
            $stops[] = $this->stopWithHeadsign($r);
        }
        return ['name' => $name, 'stops' => $stops];
    }

    /**
     * Static-timetable fallback (AtacGtfsStore.scheduledDepartures): today's active services (Rome) x
     * departures >= now, 6 soonest. Like iOS, a night run still under yesterday's service_id is not covered.
     *
     * @return list<array<string,mixed>>
     */
    public function atacScheduled(string $stopId, ?\DateTimeImmutable $now = null, int $limit = 6): array
    {
        $now ??= Rome::now();
        $midnight = $now->setTime(0, 0, 0);
        $nowSecs = Rome::secondsSinceMidnight($now);
        $st = $this->db->prepare(
            'SELECT t.trip_id, t.route_id, x.dep_secs, r.short_name, r.kind, h.headsign
             FROM atac_stop_times x
             JOIN atac_trips t ON t.rowid = x.trip_rid
             LEFT JOIN atac_routes r ON r.route_id = t.route_id
             LEFT JOIN atac_stop_headsign h ON h.route_id = t.route_id AND h.stop_id = x.stop_id
             WHERE x.stop_id = :stop AND x.dep_secs >= :now
               AND t.service_id IN (SELECT service_id FROM atac_service_dates WHERE date = :date)
             ORDER BY x.dep_secs, x.trip_rid LIMIT :lim'
        );
        $st->bindValue(':stop', $stopId);
        $st->bindValue(':now', $nowSecs, \PDO::PARAM_INT);
        $st->bindValue(':date', Rome::dateInt($now), \PDO::PARAM_INT);
        $st->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $st->execute();
        $out = [];
        $base = $midnight->getTimestamp();
        foreach ($st->fetchAll() as $r) {
            $out[] = [
                'tripId' => (string) $r['trip_id'],
                'routeId' => (string) $r['route_id'],
                'routeLabel' => $r['short_name'] !== null ? (string) $r['short_name'] : (string) $r['route_id'],
                'kind' => Text::kindName($r['kind'] === null ? 3 : (int) $r['kind']),
                'ts' => $base + (int) $r['dep_secs'],
                'headsign' => ($r['headsign'] === null || $r['headsign'] === '') ? null : (string) $r['headsign'],
            ];
        }
        return $out;
    }

    // ------------------------------------------------------------------ pole.php / rail.php

    private const RAIL_LINE_ORDER = ['ROMALIDO', 'RVURB', 'RVEXT'];

    /**
     * `CotralTrainRoute.directions(forGTFSRouteShortName:)`: ASTRAL direction codes per rail line.
     *
     * @return list<string>|null
     */
    public static function trainDirections(string $routeShortName): ?array
    {
        return match (strtoupper($routeShortName)) {
            'ROMALIDO' => ['RL_CC-PSP', 'RL_PSP-CC'],
            'RVURB' => ['RN_RMMON', 'RN_MONRM'],
            'RVEXT' => ['RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR'],
            default => null,
        };
    }

    /**
     * Candidate ASTRAL route codes for a stop: from the `F:` (rail) routes serving it, in a fixed line order
     * (iOS used whichever F: route its Set yielded first; a station shared by two lines now tries both).
     *
     * @return list<string>
     */
    public function trainRoutesForStop(string $stopId): array
    {
        $st = $this->db->prepare(
            'SELECT r.short_name FROM cotral_stop_routes sr JOIN cotral_routes r ON r.route_id = sr.route_id
             WHERE sr.stop_id = ? AND r.is_rail = 1'
        );
        $st->execute([$stopId]);
        $shorts = array_map('strtoupper', $st->fetchAll(\PDO::FETCH_COLUMN));
        $codes = [];
        foreach (self::RAIL_LINE_ORDER as $line) {
            if (in_array($line, $shorts, true)) {
                foreach (self::trainDirections($line) ?? [] as $c) {
                    $codes[] = $c;
                }
            }
        }
        return $codes;
    }

    /** @return array<string,mixed>|null */
    public function pole(string $stopId): ?array
    {
        $st = $this->db->prepare('SELECT stop_id, name, locality, lat, lon, is_rail FROM cotral_stops WHERE stop_id = ?');
        $st->execute([$stopId]);
        $r = $st->fetch();
        if (!$r) {
            return null;
        }
        return [
            'id' => (string) $r['stop_id'],
            'name' => (string) $r['name'],
            'locality' => (string) $r['locality'],
            'lat' => (float) $r['lat'],
            'lon' => (float) $r['lon'],
            'rail' => (int) $r['is_rail'] === 1,
            'trainRoutes' => $this->trainRoutesForStop($stopId),
        ];
    }

    /** @return list<string> service_ids active on the Rome date of `$now` (calendar weekday pattern, calendar_dates override) */
    public function railActiveServices(\DateTimeImmutable $now): array
    {
        $today = Rome::dateInt($now);
        $dayCols = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        $col = $dayCols[(int) $now->format('N') - 1];

        $override = [];
        $st = $this->db->prepare('SELECT service_id, added FROM rail_calendar_dates WHERE date = ?');
        $st->execute([$today]);
        foreach ($st->fetchAll() as $r) {
            $override[(string) $r['service_id']] = (int) $r['added'] === 1;
        }
        $active = [];
        $st = $this->db->prepare("SELECT service_id FROM rail_calendar WHERE start_date <= :d AND end_date >= :d AND $col = 1");
        $st->execute([':d' => $today]);
        foreach ($st->fetchAll(\PDO::FETCH_COLUMN) as $sid) {
            $active[(string) $sid] = true;
        }
        foreach ($override as $sid => $added) {
            if ($added) {
                $active[$sid] = true;
            } else {
                unset($active[$sid]);
            }
        }
        return array_map('strval', array_keys($active));
    }

    /**
     * Port of GTFSStore.scheduledDepartures(forRailStopId:) + PoleDetailViewModel.gtfsScheduledDirections:
     * the whole day's trips calling at the stop, grouped by destination station name, each group sorted by time.
     *
     * @return list<array{destination:string,route:null,entries:list<array<string,mixed>>}>
     */
    public function railScheduledDirections(string $stopId, ?\DateTimeImmutable $now = null): array
    {
        $now ??= Rome::now();
        $services = $this->railActiveServices($now);
        if ($services === []) {
            return [];
        }
        $in = implode(',', array_fill(0, count($services), '?'));
        $st = $this->db->prepare(
            "SELECT x.trip_id, MIN(x.seq) AS seq, x.dep_secs,
                    (SELECT d.name FROM rail_stop_times l JOIN cotral_stops d ON d.stop_id = l.stop_id
                     WHERE l.trip_id = x.trip_id AND l.seq = (SELECT MAX(seq) FROM rail_stop_times WHERE trip_id = x.trip_id)) AS dest
             FROM rail_stop_times x JOIN rail_trips t ON t.trip_id = x.trip_id
             WHERE x.stop_id = ? AND t.service_id IN ($in)
             GROUP BY x.trip_id"
        );
        $st->execute(array_merge([$stopId], $services));
        $deps = [];
        foreach ($st->fetchAll() as $r) {
            if ($r['dest'] === null) {
                continue; // destination station unknown: dropped, like iOS
            }
            $deps[] = ['tripId' => (string) $r['trip_id'], 'dest' => (string) $r['dest'], 'secs' => (int) $r['dep_secs']];
        }
        usort($deps, static fn ($a, $b) => [$a['secs'], $a['tripId']] <=> [$b['secs'], $b['tripId']]);

        $groups = [];
        foreach ($deps as $d) {
            $groups[$d['dest']][] = [
                'id' => $d['tripId'],
                'time' => sprintf('%02d:%02d', intdiv($d['secs'], 3600) % 24, intdiv($d['secs'], 60) % 60),
                'sortSeconds' => $d['secs'],
                'delayMinutes' => null,
                'isCancelled' => false,
                'isReplacementBus' => false,
            ];
        }
        $out = [];
        foreach ($groups as $dest => $entries) {
            $out[] = ['destination' => (string) $dest, 'route' => null, 'entries' => $entries];
        }
        return RailService::sortDirections($out);
    }
}
