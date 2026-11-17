<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

/** Google Encoded Polyline Algorithm (precision 5). */
final class Polyline
{
    /**
     * @param list<array{0:int,1:int}> $pointsE5 [latE5, lonE5] pairs (degrees * 1e5, rounded)
     */
    public static function encode(array $pointsE5): string
    {
        $out = '';
        $pLat = 0;
        $pLon = 0;
        foreach ($pointsE5 as [$lat, $lon]) {
            $out .= self::value($lat - $pLat) . self::value($lon - $pLon);
            $pLat = $lat;
            $pLon = $lon;
        }
        return $out;
    }

    private static function value(int $v): string
    {
        $v = $v < 0 ? ~($v << 1) : ($v << 1);
        $s = '';
        while ($v >= 0x20) {
            $s .= chr((0x20 | ($v & 0x1f)) + 63);
            $v >>= 5;
        }
        return $s . chr($v + 63);
    }

    /** Inverse, for tests. @return list<array{0:float,1:float}> */
    public static function decode(string $s): array
    {
        $pts = [];
        $i = 0;
        $n = strlen($s);
        $lat = 0;
        $lon = 0;
        while ($i < $n) {
            foreach ([0, 1] as $k) {
                $shift = 0;
                $result = 0;
                do {
                    $b = ord($s[$i++]) - 63;
                    $result |= ($b & 0x1f) << $shift;
                    $shift += 5;
                } while ($b >= 0x20 && $i < $n);
                $d = ($result & 1) ? ~($result >> 1) : ($result >> 1);
                if ($k === 0) {
                    $lat += $d;
                } else {
                    $lon += $d;
                }
            }
            $pts[] = [$lat / 1e5, $lon / 1e5];
        }
        return $pts;
    }
}
