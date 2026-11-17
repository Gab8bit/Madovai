<?php
declare(strict_types=1);

namespace Madovai\Live;

/**
 * GTFS-Realtime (proto2, `transit_realtime`) decoding, specialised for what
 * the app needs from Roma Mobilità's two feeds. Field numbers are taken from
 * gtfs-realtime.proto (https://github.com/google/transit/blob/master/gtfs-realtime/proto/gtfs-realtime.proto):
 *
 *  FeedMessage       header=1 entity=2          FeedHeader      timestamp=3
 *  FeedEntity        id=1 trip_update=3 vehicle=4
 *  TripUpdate        trip=1 stop_time_update=2  StopTimeUpdate stop_sequence=1 arrival=2 departure=3 stop_id=4 schedule_relationship=5
 *  StopTimeEvent     delay=1 (int32) time=2 (int64)
 *  VehiclePosition   trip=1 position=2 vehicle=8
 *  Position          latitude=1 longitude=2 bearing=3 (float32)
 *  TripDescriptor    trip_id=1 route_id=5 schedule_relationship=4
 *  VehicleDescriptor id=1
 *
 * TripDescriptor.ScheduleRelationship: CANCELED=3, DELETED=7.
 * StopTimeUpdate.ScheduleRelationship: SKIPPED=1.
 */
final class GtfsRealtime
{
    public const TRIP_CANCELED = 3;
    public const TRIP_DELETED = 7;
    public const STOP_SKIPPED = 1;

    /** @return int header timestamp (0 if absent) */
    private static function headerTimestamp(string $b, int $s, int $e): int
    {
        $ts = 0;
        $p = $s;
        while ($p < $e) {
            $tag = Protobuf::varint($b, $p, $e);
            if ($tag === (3 << 3 | 0)) {
                $ts = Protobuf::varint($b, $p, $e);
            } else {
                Protobuf::skip($b, $p, $e, $tag & 7);
            }
        }
        return $ts;
    }

    /**
     * Walks the top-level FeedMessage, calling $onEntity(start, end) for each entity.
     *
     * @return int header timestamp
     */
    private static function eachEntity(string $b, callable $onEntity): int
    {
        $end = strlen($b);
        $p = 0;
        $ts = 0;
        while ($p < $end) {
            $tag = Protobuf::varint($b, $p, $end);
            $field = $tag >> 3;
            $wt = $tag & 7;
            if ($wt === Protobuf::LEN && $field === 1) {
                [$s, $e] = Protobuf::lengthDelimited($b, $p, $end);
                $ts = self::headerTimestamp($b, $s, $e);
            } elseif ($wt === Protobuf::LEN && $field === 2) {
                [$s, $e] = Protobuf::lengthDelimited($b, $p, $end);
                $onEntity($s, $e);
            } else {
                Protobuf::skip($b, $p, $end, $wt);
            }
        }
        return $ts;
    }

    /**
     * `vehicle_positions` -> vehicles that have a position.
     * Mirrors AtacRealtimeService.decodeVehicles: vehicle id = vehicle.vehicle.id else entity.id;
     * routeId '' when the trip is absent; bearing null when absent.
     *
     * @return array{timestamp:int, vehicles:list<array{id:string,lat:float,lon:float,bearing:?float,routeId:string,tripId:?string}>}
     */
    public static function decodeVehicles(string $b): array
    {
        $vehicles = [];
        $ts = self::eachEntity($b, function (int $s, int $e) use ($b, &$vehicles): void {
            $entityId = '';
            $vs = $ve = -1;
            $p = $s;
            while ($p < $e) {
                $tag = Protobuf::varint($b, $p, $e);
                $wt = $tag & 7;
                $f = $tag >> 3;
                if ($wt === Protobuf::LEN && $f === 1) {
                    $entityId = Protobuf::string($b, $p, $e);
                } elseif ($wt === Protobuf::LEN && $f === 4) {
                    [$vs, $ve] = Protobuf::lengthDelimited($b, $p, $e);
                } else {
                    Protobuf::skip($b, $p, $e, $wt);
                }
            }
            if ($vs < 0) {
                return;
            }

            $hasPos = false;
            $lat = 0.0;
            $lon = 0.0;
            $bearing = null;
            $routeId = '';
            $tripId = null;
            $vehicleId = null;
            $p = $vs;
            while ($p < $ve) {
                $tag = Protobuf::varint($b, $p, $ve);
                $wt = $tag & 7;
                $f = $tag >> 3;
                if ($wt !== Protobuf::LEN || ($f !== 1 && $f !== 2 && $f !== 8)) {
                    Protobuf::skip($b, $p, $ve, $wt);
                    continue;
                }
                [$ms, $me] = Protobuf::lengthDelimited($b, $p, $ve);
                if ($f === 2) { // Position
                    $hasPos = true;
                    $q = $ms;
                    while ($q < $me) {
                        $t = Protobuf::varint($b, $q, $me);
                        $w = $t & 7;
                        $pf = $t >> 3;
                        if ($w === Protobuf::FIXED32 && $pf === 1) {
                            $lat = Protobuf::float32($b, $q, $me);
                        } elseif ($w === Protobuf::FIXED32 && $pf === 2) {
                            $lon = Protobuf::float32($b, $q, $me);
                        } elseif ($w === Protobuf::FIXED32 && $pf === 3) {
                            $bearing = Protobuf::float32($b, $q, $me);
                        } else {
                            Protobuf::skip($b, $q, $me, $w);
                        }
                    }
                } elseif ($f === 1) { // TripDescriptor
                    [$routeId, $tripId] = self::tripDescriptor($b, $ms, $me)['ids'];
                } else { // VehicleDescriptor
                    $q = $ms;
                    while ($q < $me) {
                        $t = Protobuf::varint($b, $q, $me);
                        if (($t & 7) === Protobuf::LEN && ($t >> 3) === 1) {
                            $vehicleId = Protobuf::string($b, $q, $me);
                        } else {
                            Protobuf::skip($b, $q, $me, $t & 7);
                        }
                    }
                }
            }
            if (!$hasPos) {
                return;
            }
            $vehicles[] = [
                'id' => $vehicleId ?? $entityId,
                'lat' => $lat,
                'lon' => $lon,
                'bearing' => $bearing,
                'routeId' => $routeId,
                'tripId' => $tripId,
            ];
        });
        return ['timestamp' => $ts, 'vehicles' => $vehicles];
    }

    /**
     * @return array{ids:array{0:string,1:?string}, relationship:?int}  [routeId ('' if absent), tripId|null]
     */
    private static function tripDescriptor(string $b, int $s, int $e): array
    {
        $routeId = '';
        $tripId = null;
        $rel = null;
        $p = $s;
        while ($p < $e) {
            $tag = Protobuf::varint($b, $p, $e);
            $wt = $tag & 7;
            $f = $tag >> 3;
            if ($wt === Protobuf::LEN && $f === 1) {
                $tripId = Protobuf::string($b, $p, $e);
            } elseif ($wt === Protobuf::LEN && $f === 5) {
                $routeId = Protobuf::string($b, $p, $e);
            } elseif ($wt === Protobuf::VARINT && $f === 4) {
                $rel = Protobuf::varint($b, $p, $e);
            } else {
                Protobuf::skip($b, $p, $e, $wt);
            }
        }
        return ['ids' => [$routeId, $tripId], 'relationship' => $rel];
    }

    /**
     * `trip_updates` -> two indexes built in a single pass (like AtacRealtimeService.decodeTripUpdates):
     *
     *  byStop[stopId] = list of [tripId, routeId, ts, delay|null, cancelled(0|1)], only ts > $now-120
     *  byTrip[tripId] = ['route' => routeId, 'stops' => list of [stopId, sequence, ts, delay|null]] (all stops, unsorted)
     *
     * The event is `arrival` if present, else `departure`; skipped when it has no time or time <= 0.
     * `cancelled` = trip CANCELED/DELETED or this stop SKIPPED (AtacStopArrivalClient semantics).
     *
     * @return array{timestamp:int, byStop:array<string,list<array>>, byTrip:array<string,array{route:string,stops:list<array>}>}
     */
    public static function decodeTripUpdates(string $b, int $now): array
    {
        $byStop = [];
        $byTrip = [];
        $ts = self::eachEntity($b, function (int $s, int $e) use ($b, $now, &$byStop, &$byTrip): void {
            $entityId = '';
            $us = $ue = -1;
            $p = $s;
            while ($p < $e) {
                $tag = Protobuf::varint($b, $p, $e);
                $wt = $tag & 7;
                $f = $tag >> 3;
                if ($wt === Protobuf::LEN && $f === 1) {
                    $entityId = Protobuf::string($b, $p, $e);
                } elseif ($wt === Protobuf::LEN && $f === 3) {
                    [$us, $ue] = Protobuf::lengthDelimited($b, $p, $e);
                } else {
                    Protobuf::skip($b, $p, $e, $wt);
                }
            }
            if ($us < 0) {
                return;
            }

            // Pass 1: the trip descriptor (field 1) may come after the stop updates in theory.
            $routeId = '';
            $tripIdRaw = null;
            $tripRel = null;
            $stus = [];
            $p = $us;
            while ($p < $ue) {
                $tag = Protobuf::varint($b, $p, $ue);
                $wt = $tag & 7;
                $f = $tag >> 3;
                if ($wt === Protobuf::LEN && $f === 1) {
                    [$ms, $me] = Protobuf::lengthDelimited($b, $p, $ue);
                    $td = self::tripDescriptor($b, $ms, $me);
                    [$routeId, $tripIdRaw] = $td['ids'];
                    $tripRel = $td['relationship'];
                } elseif ($wt === Protobuf::LEN && $f === 2) {
                    $stus[] = Protobuf::lengthDelimited($b, $p, $ue);
                } else {
                    Protobuf::skip($b, $p, $ue, $wt);
                }
            }
            $tripId = $tripIdRaw ?? $entityId;
            $tripCancelled = $tripRel === self::TRIP_CANCELED || $tripRel === self::TRIP_DELETED;

            foreach ($stus as [$ss, $se]) {
                $stopId = null;
                $seq = null;
                $arr = $dep = null; // [start, end]
                $skipped = false;
                $p = $ss;
                while ($p < $se) {
                    $tag = Protobuf::varint($b, $p, $se);
                    $wt = $tag & 7;
                    $f = $tag >> 3;
                    if ($wt === Protobuf::LEN && $f === 4) {
                        $stopId = Protobuf::string($b, $p, $se);
                    } elseif ($wt === Protobuf::VARINT && $f === 1) {
                        $seq = Protobuf::varint($b, $p, $se) & 0xFFFFFFFF;
                    } elseif ($wt === Protobuf::LEN && $f === 2) {
                        $arr = Protobuf::lengthDelimited($b, $p, $se);
                    } elseif ($wt === Protobuf::LEN && $f === 3) {
                        $dep = Protobuf::lengthDelimited($b, $p, $se);
                    } elseif ($wt === Protobuf::VARINT && $f === 5) {
                        $skipped = Protobuf::varint($b, $p, $se) === self::STOP_SKIPPED;
                    } else {
                        Protobuf::skip($b, $p, $se, $wt);
                    }
                }
                if ($stopId === null) {
                    continue;
                }
                $range = $arr ?? $dep;
                if ($range === null) {
                    continue;
                }
                $time = null;
                $delay = null;
                $q = $range[0];
                $qe = $range[1];
                while ($q < $qe) {
                    $tag = Protobuf::varint($b, $q, $qe);
                    $wt = $tag & 7;
                    $f = $tag >> 3;
                    if ($wt === Protobuf::VARINT && $f === 2) {
                        $time = Protobuf::varint($b, $q, $qe);
                    } elseif ($wt === Protobuf::VARINT && $f === 1) {
                        $delay = Protobuf::toInt32(Protobuf::varint($b, $q, $qe));
                    } else {
                        Protobuf::skip($b, $q, $qe, $wt);
                    }
                }
                if ($time === null || $time <= 0) {
                    continue;
                }

                if ($time - $now > -120) {
                    $byStop[$stopId][] = [$tripId, $routeId, $time, $delay, ($tripCancelled || $skipped) ? 1 : 0];
                }
                if (!isset($byTrip[$tripId])) {
                    $byTrip[$tripId] = ['route' => $routeId, 'stops' => []];
                }
                $byTrip[$tripId]['stops'][] = [$stopId, $seq ?? count($byTrip[$tripId]['stops']), $time, $delay];
            }
        });
        return ['timestamp' => $ts, 'byStop' => $byStop, 'byTrip' => $byTrip];
    }
}
