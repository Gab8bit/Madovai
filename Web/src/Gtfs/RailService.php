<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

use Madovai\BadRequest;

/**
 * Port of PoleDetailViewModel.refreshRailDepartures: ASTRAL first (every candidate direction of the
 * stop's line, keeping those that resolve the station), static GTFS timetable only when ASTRAL
 * resolved nothing. The ASTRAL source is injected so the tier logic is testable on its own.
 */
final class RailService
{
    /**
     * @param callable(string,string):?array $astral (routeCode, stationName) => ['destination','route','entries'] | null
     * @return array{source:string,directions:list<array<string,mixed>>}
     */
    public static function departures(Store $store, string $stopId, callable $astral, ?\DateTimeImmutable $now = null): array
    {
        $pole = $store->pole($stopId);
        if ($pole === null) {
            throw new BadRequest('Fermata inesistente');
        }
        $stationName = trim($pole['name']);
        if ($pole['trainRoutes'] === [] || $stationName === '') {
            return ['source' => 'none', 'directions' => []];
        }

        $resolved = [];
        foreach ($pole['trainRoutes'] as $code) {
            try {
                $d = $astral($code, $stationName);
            } catch (\Throwable $e) {
                continue; // `try?` in Swift: any failure just means "this direction didn't resolve"
            }
            if ($d === null) {
                continue;
            }
            $entries = array_values($d['entries'] ?? []);
            usort($entries, static fn ($a, $b) => ($a['sortSeconds'] ?? 0) <=> ($b['sortSeconds'] ?? 0));
            $resolved[] = [
                'destination' => (string) ($d['destination'] ?? ''),
                'route' => isset($d['route']) ? (string) $d['route'] : $code,
                'entries' => $entries,
            ];
        }
        if ($resolved !== []) {
            return ['source' => 'astral', 'directions' => self::sortDirections($resolved)];
        }

        $fallback = $store->railScheduledDirections($stopId, $now);
        if ($fallback !== []) {
            return ['source' => 'gtfs', 'directions' => $fallback];
        }
        return ['source' => 'none', 'directions' => []];
    }

    /**
     * @param list<array<string,mixed>> $directions
     * @return list<array<string,mixed>>
     */
    public static function sortDirections(array $directions): array
    {
        usort($directions, static fn ($a, $b) => strcmp((string) $a['destination'], (string) $b['destination']));
        return $directions;
    }
}
