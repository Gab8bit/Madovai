<?php
declare(strict_types=1);

namespace Madovai\Live;

/** Port of CotralTimeUtils.swift plus small parsing helpers shared by the live clients. */
final class CotralTime
{
    /**
     * Cotral gives integer seconds; the iOS app turns them into "HH:MM" (optionally "-HH:MM").
     * $wrapClockAt24 = true for times of day (24:48 -> 00:48), false for durations.
     * Unparseable input -> "00:00".
     */
    public static function readableTime(string $raw, bool $wrapClockAt24 = true): string
    {
        $seconds = self::parseInt($raw);
        if ($seconds === null) {
            return '00:00';
        }
        $sign = $seconds < 0 ? '-' : '';
        $totalMinutes = intdiv(abs($seconds), 60);
        $hours = intdiv($totalMinutes, 60);
        $minutes = $totalMinutes % 60;
        if ($wrapClockAt24) {
            $hours %= 24;
        }
        return sprintf('%s%02d:%02d', $sign, $hours, $minutes);
    }

    /** Cotral's cmd=1 has lat/lon swapped for many poles (Lazio: lat ~41-43, lon ~11-14). @return array{0:float,1:float} */
    public static function normalizeLatLon(float $lat, float $lon): array
    {
        if ($lat > 0 && $lat < 20 && $lon > 20) {
            return [$lon, $lat];
        }
        return [$lat, $lon];
    }

    /** Swift `Int(s.trimmingCharacters(in: .whitespaces))`: strict base-10 integer or null. */
    public static function parseInt(string $s): ?int
    {
        $s = trim($s, " \t");
        if (preg_match('/^[+-]?\d{1,18}$/', $s) !== 1) {
            return null;
        }
        return (int) $s;
    }

    /** Swift `Double(s)`: strict decimal number or null. */
    public static function parseDouble(string $s): ?float
    {
        if (preg_match('/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/', $s) !== 1) {
            return null;
        }
        return (float) $s;
    }

    /** "HH:MM" -> seconds since midnight (hours may exceed 23), null if malformed. */
    public static function secondsFromHHMM(string $time): ?int
    {
        if (preg_match('/^(\d+):(\d+)$/', $time, $m) !== 1) {
            return null;
        }
        return (int) $m[1] * 3600 + (int) $m[2] * 60;
    }

    /** Pole/vehicle/stop codes accepted from the outside world: never forwarded as free-form text. */
    public static function isValidCode(string $s): bool
    {
        return preg_match('/^[A-Za-z0-9_.:-]{1,64}$/', $s) === 1;
    }
}
