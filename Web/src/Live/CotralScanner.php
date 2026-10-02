<?php
declare(strict_types=1);

namespace Madovai\Live;

/**
 * Server-side port of CotralViewportVehicleService.scan(): poles -> live transits
 * -> trackable vehicles -> positions. Two concurrent fan-outs (curl_multi); a failed
 * sub-request is skipped, never fatal. Each upstream answer goes through the same
 * per-pole (8 s) / per-vehicle (5 s) cache as the single-item endpoints.
 */
final class CotralScanner
{
    public const MAX_POLES = 15;
    private const BUDGET = 10.0;

    /**
     * @param list<string> $poleCodes already validated
     * @return list<array<string,mixed>>
     */
    public static function scan(array $poleCodes): array
    {
        $start = microtime(true);
        $poleCodes = array_values(array_unique($poleCodes));

        // 1) transits per pole (cached; misses fetched concurrently).
        $transitsByPole = [];
        $missing = [];
        foreach ($poleCodes as $code) {
            $hit = Memo::peek('cotral:transits:' . $code, CotralClient::TRANSITS_TTL);
            if ($hit !== null) {
                $transitsByPole[$code] = $hit[0];
            } else {
                $missing[$code] = ['url' => CotralClient::transitsUrl($code)];
            }
        }
        foreach (Multi::fetch($missing, self::BUDGET * 0.6) as $code => $body) {
            if ($body === null) {
                continue; // failed sub-request: skipped
            }
            $parsed = CotralClient::parseTransits($body);
            Memo::put('cotral:transits:' . $code, $parsed);
            $transitsByPole[$code] = $parsed;
        }

        // Keep the originating transit per vehicle (later poles win, as in the Swift merge).
        $transitByVehicle = [];
        foreach ($poleCodes as $code) {
            foreach (($transitsByPole[$code]['transits'] ?? []) as $transit) {
                if (CotralClient::canTrackVehicle($transit)) {
                    $transitByVehicle[(string) $transit['vehicleCode']] = $transit;
                }
            }
        }

        // 2) position per vehicle (cached; misses fetched concurrently).
        $positions = [];
        $missing = [];
        foreach (array_keys($transitByVehicle) as $vcode) {
            $vcode = (string) $vcode;
            $hit = Memo::peek('cotral:pos:' . $vcode, CotralClient::POSITION_TTL);
            if ($hit !== null) {
                $positions[$vcode] = $hit[0];
            } else {
                $missing[$vcode] = ['url' => CotralClient::positionUrl($vcode)];
            }
        }
        $remaining = max(1.0, self::BUDGET - (microtime(true) - $start));
        foreach (Multi::fetch($missing, $remaining) as $vcode => $body) {
            if ($body === null) {
                continue;
            }
            $pos = CotralClient::parsePosition($body);
            Memo::put('cotral:pos:' . $vcode, $pos);
            $positions[(string) $vcode] = $pos;
        }

        $trainCodes = array_flip(CotralTrainRoute::all());
        $vehicles = [];
        foreach ($transitByVehicle as $vcode => $transit) {
            $vcode = (string) $vcode;
            $pos = $positions[$vcode] ?? null;
            if ($pos === null) {
                continue;
            }
            $routeId = $transit['percorso'] === '' ? null : $transit['percorso'];
            $vehicles[] = [
                'id' => 'cotral-' . $vcode,
                'code' => $vcode,
                'lat' => $pos['lat'],
                'lon' => $pos['lon'],
                'routeId' => $routeId,
                'routeLabel' => $routeId,
                'kind' => ($routeId !== null && isset($trainCodes[$routeId])) ? 'treno' : 'bus',
                'delaySeconds' => CotralClient::isDelayReliable($transit) ? $transit['ritardoSeconds'] : null,
                'tripId' => $transit['idCorsa'] === '' ? null : $transit['idCorsa'],
            ];
        }
        return $vehicles;
    }
}
