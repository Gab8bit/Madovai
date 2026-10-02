<?php
declare(strict_types=1);

namespace Madovai\Live;

final class ProtobufException extends \RuntimeException {}

/**
 * Minimal protobuf wire-format reader (no .proto compiler, no extension).
 * Just the primitives needed to walk GTFS-Realtime messages; unknown fields
 * are skipped by wire type, so newer feed versions never break decoding.
 *
 * Usage pattern (see GtfsRealtime):
 *
 *     while ($p < $end) {
 *         $tag = Protobuf::varint($buf, $p, $end);
 *         switch ($tag >> 3) { case 1: ...; default: Protobuf::skip($buf, $p, $end, $tag & 7); }
 *     }
 */
final class Protobuf
{
    public const VARINT = 0;
    public const FIXED64 = 1;
    public const LEN = 2;
    public const SGROUP = 3;
    public const EGROUP = 4;
    public const FIXED32 = 5;

    /**
     * Reads a base-128 varint. A negative int32/int64 is encoded as a 10-byte
     * varint; PHP ints are 64-bit so the result is already the correct signed
     * value (the 10th byte's high bits fall off the end of the word).
     */
    public static function varint(string $b, int &$p, int $end): int
    {
        if ($p >= $end) {
            throw new ProtobufException('Truncated varint');
        }
        $byte = ord($b[$p++]);
        if ($byte < 0x80) {
            return $byte;
        }
        $result = $byte & 0x7F;
        $shift = 7;
        while (true) {
            if ($p >= $end) {
                throw new ProtobufException('Truncated varint');
            }
            $byte = ord($b[$p++]);
            if ($shift < 64) {
                $result |= ($byte & 0x7F) << $shift;
            }
            if ($byte < 0x80) {
                return $result;
            }
            $shift += 7;
            if ($shift > 70) {
                throw new ProtobufException('Varint too long');
            }
        }
    }

    /** Reinterprets a decoded varint as a signed 32-bit integer (proto `int32`). */
    public static function toInt32(int $v): int
    {
        $v &= 0xFFFFFFFF;
        return $v >= 0x80000000 ? $v - 0x100000000 : $v;
    }

    /** Reads a length prefix and returns the [start, end) range of the payload, advancing $p past it. */
    public static function lengthDelimited(string $b, int &$p, int $end): array
    {
        $len = self::varint($b, $p, $end);
        if ($len < 0 || $p + $len > $end) {
            throw new ProtobufException('Truncated length-delimited field');
        }
        $start = $p;
        $p += $len;
        return [$start, $p];
    }

    public static function string(string $b, int &$p, int $end): string
    {
        [$s, $e] = self::lengthDelimited($b, $p, $end);
        return substr($b, $s, $e - $s);
    }

    public static function float32(string $b, int &$p, int $end): float
    {
        if ($p + 4 > $end) {
            throw new ProtobufException('Truncated fixed32');
        }
        $v = unpack('g', $b, $p)[1]; // little-endian IEEE-754 single
        $p += 4;
        return $v;
    }

    public static function double64(string $b, int &$p, int $end): float
    {
        if ($p + 8 > $end) {
            throw new ProtobufException('Truncated fixed64');
        }
        $v = unpack('e', $b, $p)[1];
        $p += 8;
        return $v;
    }

    /** Skips the value of an unknown field. */
    public static function skip(string $b, int &$p, int $end, int $wireType): void
    {
        switch ($wireType) {
            case self::VARINT:
                self::varint($b, $p, $end);
                return;
            case self::FIXED64:
                $p += 8;
                break;
            case self::LEN:
                self::lengthDelimited($b, $p, $end);
                return;
            case self::FIXED32:
                $p += 4;
                break;
            case self::SGROUP:
                // Deprecated group encoding: skip fields until the matching end-group tag.
                while (true) {
                    $tag = self::varint($b, $p, $end);
                    $wt = $tag & 7;
                    if ($wt === self::EGROUP) {
                        return;
                    }
                    self::skip($b, $p, $end, $wt);
                }
                // no break
            default:
                throw new ProtobufException("Unsupported wire type $wireType");
        }
        if ($p > $end) {
            throw new ProtobufException('Truncated fixed field');
        }
    }
}
