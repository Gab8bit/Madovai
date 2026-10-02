<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

/** Text helpers ported from GTFSTextUtils.swift and the Atac headsign cleaning. */
final class Text
{
    /** Swift `trimmingCharacters(in: .whitespaces)` (spaces, tabs, Unicode Zs). */
    public static function trimWs(string $s): string
    {
        $r = preg_replace('/^\h+|\h+$/u', '', $s);
        return $r ?? trim($s, " \t");
    }

    /** ` #\s*\w+$` suffix removal (Cotral appends " # CODE" to stop and route names). */
    public static function stripTrailingHashCode(string $value): string
    {
        $r = preg_replace('/ #\s*\w+$/u', '', $value, 1);
        return self::trimWs($r ?? $value);
    }

    /** `stopName.split(/[|!(]/)[0].trim()` */
    public static function extractLocality(string $stopName): string
    {
        $parts = preg_split('/[|!(]/', $stopName, 2);
        return self::trimWs($parts[0] ?? $stopName);
    }

    /**
     * Swift `.capitalized`: everything lowercased, then every letter that does not follow another letter
     * is title-cased. Digits and punctuation ("P.LE" -> "P.Le", "A1B" -> "A1B") break words; an apostrophe
     * between letters does not ("D'AOSTA" -> "D'aosta"). Verified against Foundation on the real headsigns.
     */
    public static function capitalized(string $s): string
    {
        $lower = mb_strtolower($s, 'UTF-8');
        $r = preg_replace_callback(
            '/(?<![\p{L}\p{M}])(?<![\p{L}\p{M}][\'\x{2019}])\p{L}/u',
            static fn (array $m): string => mb_convert_case($m[0], MB_CASE_TITLE, 'UTF-8'),
            $lower
        );
        return $r ?? mb_convert_case($s, MB_CASE_TITLE, 'UTF-8');
    }

    /** Atac trip_headsign "ANAGNINA (MA)" -> "Anagnina"; null when empty. */
    public static function cleanHeadsign(string $raw): ?string
    {
        $cleaned = self::capitalized(self::extractLocality($raw));
        return $cleaned === '' ? null : $cleaned;
    }

    public static function lower(string $s): string
    {
        return mb_strtolower($s, 'UTF-8');
    }

    /** Escapes a user string for `LIKE ? ESCAPE '\'`. */
    public static function likeEscape(string $s): string
    {
        return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s);
    }

    /** GTFS route_type -> app kind (default bus, like TransitVehicleKind(gtfsRouteType:)). */
    public static function kindName(int $routeType): string
    {
        return match ($routeType) {
            0 => 'tram',
            1 => 'metro',
            2 => 'treno',
            default => 'bus',
        };
    }

    /** Friendly names of Rome's metro lines (their route_long_name is blank in the feed). */
    public static function metroName(string $shortName): ?string
    {
        return match (strtoupper($shortName)) {
            'MEA' => 'Metro A',
            'MEB' => 'Metro B',
            'MEB1' => 'Metro B1',
            'MEC' => 'Metro C',
            default => null,
        };
    }
}
