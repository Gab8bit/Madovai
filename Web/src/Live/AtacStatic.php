<?php
declare(strict_types=1);

namespace Madovai\Live;

use Madovai\Db;
use Madovai\NotReady;

/**
 * Batched lookups against the static SQLite DB (atac_routes / atac_trips / atac_stops).
 * Every method degrades to an empty result when the DB (or a table) isn't there yet,
 * so the live endpoints keep working with raw GTFS ids.
 */
final class AtacStatic
{
    private const CHUNK = 500;

    public const KINDS = [3 => 'bus', 0 => 'tram', 1 => 'metro', 2 => 'treno'];

    /**
     * @param list<string> $ids
     * @return array<string, array{label:string, kind:string, operator:string}>  by route_id
     */
    public static function routes(array $ids): array
    {
        $out = [];
        foreach (self::query('SELECT route_id, short_name, kind, operator FROM atac_routes WHERE route_id IN (%s)', $ids) as $r) {
            $op = (string) ($r['operator'] ?? '');
            $out[(string) $r['route_id']] = [
                'label' => (string) ($r['short_name'] ?? ''),
                'kind' => self::KINDS[(int) $r['kind']] ?? 'bus',
                'operator' => match ($op) {
                    'Atac', 'Roma TPL', 'Cotral' => $op,
                    'OP1' => 'Atac',
                    default => $op === '' ? 'Atac' : 'Roma TPL',
                },
            ];
        }
        return $out;
    }

    /**
     * @param list<string> $ids
     * @return array<string, array{route:?string, headsign:?string}>  by trip_id
     */
    public static function trips(array $ids): array
    {
        $out = [];
        foreach (self::query('SELECT trip_id, route_id, headsign FROM atac_trips WHERE trip_id IN (%s)', $ids) as $r) {
            $h = (string) ($r['headsign'] ?? '');
            $out[(string) $r['trip_id']] = [
                'route' => ($r['route_id'] ?? '') === '' ? null : (string) $r['route_id'],
                'headsign' => $h === '' ? null : $h,
            ];
        }
        return $out;
    }

    /**
     * @param list<string> $ids
     * @return array<string,string>  stop_id => name
     */
    public static function stopNames(array $ids): array
    {
        $out = [];
        foreach (self::query('SELECT stop_id, name FROM atac_stops WHERE stop_id IN (%s)', $ids) as $r) {
            $out[(string) $r['stop_id']] = (string) $r['name'];
        }
        return $out;
    }

    /**
     * @param list<string> $ids
     * @return list<array<string,mixed>>
     */
    private static function query(string $sqlTemplate, array $ids): array
    {
        $ids = array_values(array_unique(array_map('strval', array_filter($ids, static fn($i) => $i !== '' && $i !== null))));
        if ($ids === []) {
            return [];
        }
        Preload::exceptions();
        try {
            $pdo = Db::gtfs();
            $rows = [];
            foreach (array_chunk($ids, self::CHUNK) as $chunk) {
                $stmt = $pdo->prepare(sprintf($sqlTemplate, implode(',', array_fill(0, count($chunk), '?'))));
                $stmt->execute($chunk);
                foreach ($stmt->fetchAll() as $row) {
                    $rows[] = $row;
                }
            }
            return $rows;
        } catch (NotReady | \PDOException) {
            return [];
        }
    }
}
