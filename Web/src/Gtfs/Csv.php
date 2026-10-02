<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

/** GTFS CSV helpers (port of GTFSParsing.parseCSVLine / parseGtfsTimeToSeconds). */
final class Csv
{
    /**
     * Quote-aware field split: `""` inside a quoted field is an escaped quote
     * (same hand-rolled semantics as the iOS app / reference server).
     *
     * @return list<string>
     */
    public static function parseLine(string $line): array
    {
        if (strpos($line, '"') === false) {
            return explode(',', $line);
        }
        $fields = [];
        $cur = '';
        $inQuotes = false;
        $n = strlen($line);
        for ($i = 0; $i < $n; $i++) {
            $c = $line[$i];
            if ($c === '"') {
                if ($inQuotes && $i + 1 < $n && $line[$i + 1] === '"') {
                    $cur .= '"';
                    $i++;
                } else {
                    $inQuotes = !$inQuotes;
                }
            } elseif ($c === ',' && !$inQuotes) {
                $fields[] = $cur;
                $cur = '';
            } else {
                $cur .= $c;
            }
        }
        $fields[] = $cur;
        return $fields;
    }

    /**
     * Streams a GTFS file: skips the header, trims spaces/tabs and blank lines, yields parsed rows.
     *
     * @param resource $handle
     * @return \Generator<int,list<string>>
     */
    public static function rows($handle): \Generator
    {
        $first = true;
        while (($line = fgets($handle)) !== false) {
            if ($first) {
                $first = false;
                continue;
            }
            $line = trim($line, " \t\r\n");
            if ($line === '') {
                continue;
            }
            yield self::parseLine($line);
        }
    }

    /** "HH:MM:SS" (hours may exceed 23) -> seconds, null if malformed. */
    public static function timeToSeconds(string $time): ?int
    {
        if (strlen($time) === 8 && $time[2] === ':' && $time[5] === ':'
            && ctype_digit($time[0] . $time[1] . $time[3] . $time[4] . $time[6] . $time[7])) {
            return (int) $time[0] * 36000 + (int) $time[1] * 3600
                + (int) $time[3] * 600 + (int) $time[4] * 60
                + (int) $time[6] * 10 + (int) $time[7];
        }
        $parts = array_values(array_filter(explode(':', trim($time)), static fn ($p) => $p !== ''));
        if (count($parts) !== 3) {
            return null;
        }
        foreach ($parts as $p) {
            if (!ctype_digit(ltrim($p, '+-')) || $p === '') {
                return null;
            }
        }
        return (int) $parts[0] * 3600 + (int) $parts[1] * 60 + (int) $parts[2];
    }
}
