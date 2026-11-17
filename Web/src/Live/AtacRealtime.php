<?php
declare(strict_types=1);

namespace Madovai\Live;

use Madovai\Cache;
use Madovai\Config;
use Madovai\Http;

/**
 * Roma Mobilità GTFS-Realtime (protobuf): vehicle_positions + trip_updates.
 * The decoded & indexed structures are cached (12 s), not the raw bytes, so N visitors
 * cost one download + one decode per feed. Port of AtacRealtimeService (+ AtacStopArrivalClient
 * for the cancellation flags).
 */
final class AtacRealtime
{
    public const TTL = 12;
    private const STOP_LIMIT = 150;

    // ---- feeds ---------------------------------------------------------------------------------------------

    /**
     * Decoded trip_updates indexes (see GtfsRealtime::decodeTripUpdates).
     *
     * @return array{timestamp:int, byStop:array<string,list<array>>, byTrip:array<string,array{route:string,stops:list<array>}>}
     */
    public static function tripUpdates(): array
    {
        return Cache::remember('atac:tripupdates:v1', self::TTL, static function (): array {
            return GtfsRealtime::decodeTripUpdates(Http::get(Config::ATAC_TRIP_UPDATES_URL, 12), time());
        }, 120);
    }

    // ---- vehicles ------------------------------------------------------------------------------------------

    /**
     * @return array{updated:int, vehicles:list<array<string,mixed>>}
     */
    public static function vehicles(): array
    {
        return Cache::remember('atac:vehicles:v1', self::TTL, static function (): array {
            $feed = GtfsRealtime::decodeVehicles(Http::get(Config::ATAC_VEHICLE_POSITIONS_URL, 12));
            return self::enrichVehicles($feed);
        }, 120);
    }

    /**
     * @param array{timestamp:int, vehicles:list<array>} $feed
     * @return array{updated:int, vehicles:list<array<string,mixed>>}
     */
    public static function enrichVehicles(array $feed): array
    {
        $routeIds = [];
        $tripIds = [];
        foreach ($feed['vehicles'] as $v) {
            if ($v['routeId'] !== '') {
                $routeIds[$v['routeId']] = true;
            }
            if ($v['tripId'] !== null && $v['tripId'] !== '') {
                $tripIds[$v['tripId']] = true;
            }
        }
        $routes = AtacStatic::routes(array_map('strval', array_keys($routeIds)));
        $trips = AtacStatic::trips(array_map('strval', array_keys($tripIds))); // one batched lookup (chunked IN lists)

        $out = [];
        foreach ($feed['vehicles'] as $v) {
            $rid = $v['routeId'];
            $route = $rid === '' ? null : ($routes[$rid] ?? null);
            $label = $route['label'] ?? '';
            $out[] = [
                'id' => 'atac-' . $v['id'],
                'lat' => round($v['lat'], 6),
                'lon' => round($v['lon'], 6),
                'bearing' => $v['bearing'] === null ? null : round($v['bearing'], 1),
                'routeId' => $rid === '' ? null : $rid,
                'routeLabel' => $rid === '' ? null : ($label !== '' ? $label : $rid),
                'kind' => $route['kind'] ?? 'bus',
                'operator' => $route['operator'] ?? 'Atac',
                'tripId' => $v['tripId'],
                'headsign' => $v['tripId'] === null ? null : ($trips[$v['tripId']]['headsign'] ?? null),
            ];
        }
        return ['updated' => $feed['timestamp'] > 0 ? $feed['timestamp'] : time(), 'vehicles' => $out];
    }

    // ---- stops ---------------------------------------------------------------------------------------------

    /**
     * Upcoming arrivals (arrival, else departure, with time > 0 and ts > now-120) for up to 150 stops.
     * O(feed index + requested stops): the feed is indexed by stop once, then picked.
     *
     * @param list<string> $stopIds
     * @return array{updated:int, stops:\stdClass}
     */
    public static function stopArrivals(array $stopIds, ?int $now = null): array
    {
        $stopIds = array_slice(array_values(array_unique(array_map('strval', $stopIds))), 0, self::STOP_LIMIT);
        $feed = self::tripUpdates();
        $now ??= time();

        $picked = [];
        $routeIds = [];
        $tripIds = [];
        foreach ($stopIds as $sid) {
            $list = self::pick($feed['byStop'][$sid] ?? [], $now);
            $picked[$sid] = $list;
            foreach ($list as $e) {
                if ($e[1] !== '') {
                    $routeIds[$e[1]] = true;
                }
                $tripIds[$e[0]] = true;
            }
        }
        $routes = AtacStatic::routes(array_map('strval', array_keys($routeIds)));
        $trips = AtacStatic::trips(array_map('strval', array_keys($tripIds)));

        $stops = new \stdClass();
        foreach ($stopIds as $sid) {
            $rows = [];
            foreach ($picked[$sid] as [$tripId, $routeId, $ts, $delay, $cancelled]) {
                $route = $routes[$routeId] ?? null;
                $label = $route['label'] ?? '';
                $rows[] = [
                    'tripId' => (string) $tripId,
                    'routeId' => $routeId,
                    'routeLabel' => $label !== '' ? $label : $routeId,
                    'kind' => $route['kind'] ?? 'bus',
                    'ts' => $ts,
                    'delaySeconds' => $delay,
                    'headsign' => $trips[(string) $tripId]['headsign'] ?? null,
                    'cancelled' => $cancelled === 1,
                ];
            }
            $stops->{$sid} = $rows;
        }
        return ['updated' => $feed['timestamp'] > 0 ? $feed['timestamp'] : time(), 'stops' => $stops];
    }

    /**
     * @param list<array> $entries [tripId, routeId, ts, delay, cancelled]
     * @return list<array>
     */
    private static function pick(array $entries, int $now): array
    {
        $entries = array_values(array_filter($entries, static fn($e) => $e[2] - $now > -120));
        usort($entries, static fn($a, $b) => $a[2] <=> $b[2]);
        return $entries;
    }

    /**
     * Next arrivals at one stop for the reminder runner: [['ts','delaySeconds','isCancelled'], …], soonest first.
     *
     * @return list<array{ts:int, delaySeconds:?int, isCancelled:bool}>
     */
    public static function upcomingArrivals(string $stopId, int $limit = 2, ?int $now = null): array
    {
        $feed = self::tripUpdates();
        $list = array_slice(self::pick($feed['byStop'][$stopId] ?? [], $now ?? time()), 0, max(0, $limit));
        return array_map(static fn($e) => ['ts' => $e[2], 'delaySeconds' => $e[3], 'isCancelled' => $e[4] === 1], $list);
    }

    // ---- trips ---------------------------------------------------------------------------------------------

    /**
     * Full itinerary of one trip (past and future stops, by sequence), or null if the trip isn't in the feed.
     *
     * @return array{tripId:string, routeId:?string, routeLabel:?string, headsign:?string, stops:list<array<string,mixed>>}|null
     */
    public static function trip(string $tripId): ?array
    {
        $feed = self::tripUpdates();
        $entry = $feed['byTrip'][$tripId] ?? null;
        if ($entry === null) {
            return null;
        }
        $stops = $entry['stops'];
        // stable sort by sequence
        foreach ($stops as $i => &$s) {
            $s[4] = $i;
        }
        unset($s);
        usort($stops, static fn($a, $b) => [$a[1], $a[4]] <=> [$b[1], $b[4]]);

        $routeId = $entry['route'] === '' ? null : $entry['route'];
        $tripMeta = AtacStatic::trips([$tripId])[$tripId] ?? null;
        $routeId ??= $tripMeta['route'] ?? null;
        $route = $routeId === null ? null : (AtacStatic::routes([$routeId])[$routeId] ?? null);
        $names = AtacStatic::stopNames(array_map(static fn($s) => (string) $s[0], $stops));

        return [
            'tripId' => $tripId,
            'routeId' => $routeId,
            'routeLabel' => $routeId === null ? null : (($route['label'] ?? '') !== '' ? $route['label'] : $routeId),
            'headsign' => $tripMeta['headsign'] ?? null,
            'stops' => array_map(static fn($s) => [
                'stopId' => (string) $s[0],
                'stopName' => $names[(string) $s[0]] ?? (string) $s[0],
                'sequence' => $s[1],
                'ts' => $s[2],
                'delaySeconds' => $s[3],
            ], $stops),
        ];
    }

    /** Skeleton for a trip that is not (or no longer) in the feed, enriched from the static DB when possible. */
    public static function emptyTrip(string $tripId): array
    {
        $meta = AtacStatic::trips([$tripId])[$tripId] ?? null;
        $routeId = $meta['route'] ?? null;
        $route = $routeId === null ? null : (AtacStatic::routes([$routeId])[$routeId] ?? null);
        return [
            'tripId' => $tripId,
            'routeId' => $routeId,
            'routeLabel' => $routeId === null ? null : (($route['label'] ?? '') !== '' ? $route['label'] : $routeId),
            'headsign' => $meta['headsign'] ?? null,
            'stops' => [],
        ];
    }
}
