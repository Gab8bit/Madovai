<?php
declare(strict_types=1);

namespace Madovai;

/** Everything time-of-day in this app is Rome wall-clock time, regardless of where the server/visitor is. */
final class Rome
{
    public static function tz(): \DateTimeZone
    {
        static $tz = null;
        return $tz ??= new \DateTimeZone(Config::TIMEZONE);
    }

    public static function now(): \DateTimeImmutable
    {
        return new \DateTimeImmutable('now', self::tz());
    }

    public static function secondsSinceMidnight(?\DateTimeImmutable $at = null): int
    {
        $at ??= self::now();
        return (int) $at->format('G') * 3600 + (int) $at->format('i') * 60 + (int) $at->format('s');
    }

    /** "yyyymmdd" as an int, e.g. 20261002 — the GTFS calendar date format. */
    public static function dateInt(?\DateTimeImmutable $at = null): int
    {
        return (int) ($at ?? self::now())->format('Ymd');
    }

    /** "HH:mm" in Rome time for a unix timestamp. */
    public static function hhmm(int $timestamp): string
    {
        return (new \DateTimeImmutable('@' . $timestamp))->setTimezone(self::tz())->format('H:i');
    }
}
