<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

use Madovai\BadRequest;

/** Strict query-string validation for the static endpoints. */
final class Input
{
    public static function float(string $name): float
    {
        $v = $_GET[$name] ?? null;
        if (!is_string($v) || $v === '' || !is_numeric($v)) {
            throw new BadRequest("Parametro '$name' non valido");
        }
        $f = (float) $v;
        if (!is_finite($f)) {
            throw new BadRequest("Parametro '$name' non valido");
        }
        return $f;
    }

    public static function int(string $name, int $default, int $min, int $max): int
    {
        $v = $_GET[$name] ?? null;
        if ($v === null || $v === '') {
            return $default;
        }
        if (!is_string($v) || !preg_match('/^-?\d{1,9}$/', $v)) {
            throw new BadRequest("Parametro '$name' non valido");
        }
        return max($min, min($max, (int) $v));
    }

    /** Required non-empty string (trimmed, max length). */
    public static function string(string $name, int $maxLen = 128): string
    {
        $v = $_GET[$name] ?? null;
        if (!is_string($v)) {
            throw new BadRequest("Parametro '$name' mancante");
        }
        $v = trim($v);
        if ($v === '' || strlen($v) > $maxLen) {
            throw new BadRequest("Parametro '$name' non valido");
        }
        return $v;
    }

    public static function optionalString(string $name, int $maxLen = 128): ?string
    {
        $v = $_GET[$name] ?? null;
        if ($v === null || $v === '') {
            return null;
        }
        return self::string($name, $maxLen);
    }

    /** @return array{0:float,1:float,2:float,3:float} [minLat,minLon,maxLat,maxLon] */
    public static function bbox(): array
    {
        $minLat = self::float('minLat');
        $minLon = self::float('minLon');
        $maxLat = self::float('maxLat');
        $maxLon = self::float('maxLon');
        if ($minLat > $maxLat || $minLon > $maxLon) {
            throw new BadRequest('Riquadro non valido');
        }
        return [$minLat, $minLon, $maxLat, $maxLon];
    }
}
