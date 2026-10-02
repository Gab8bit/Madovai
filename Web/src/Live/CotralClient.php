<?php
declare(strict_types=1);

namespace Madovai\Live;

use Madovai\BadRequest;
use Madovai\Cache;
use Madovai\Config;
use Madovai\Http;

/**
 * Cotral's internal live endpoint (PIV.do / Automezzi.do), plain HTTP + XML.
 * Port of CotralXMLClient + TransitsRepository + VehicleRepository.
 */
final class CotralClient
{
    public const TRANSITS_TTL = 8;
    public const POSITION_TTL = 5;

    private static function url(string $endpoint, array $params): string
    {
        return Config::COTRAL_BASE_URL . '/' . $endpoint . '?' . http_build_query($params, '', '&', PHP_QUERY_RFC3986);
    }

    public static function transitsUrl(string $poleCode): string
    {
        return self::url('PIV.do', [
            'cmd' => '1',
            'userId' => Config::COTRAL_USER_ID,
            'pCodice' => $poleCode,
            'pFormato' => 'xml',
            'pDelta' => Config::COTRAL_DELTA,
        ]);
    }

    public static function positionUrl(string $vehicleCode): string
    {
        return self::url('Automezzi.do', [
            'cmd' => 'loc',
            'userId' => Config::COTRAL_USER_ID,
            'pAutomezzo' => $vehicleCode,
            'pFormato' => 'xml',
        ]);
    }

    /**
     * Live transits for a pole, or null when Cotral has no data (dangling tag / empty / no `corsa`).
     * Cached 8 s per pole. Throws HttpException when the upstream is unreachable and no cached copy exists.
     *
     * @return array{pole:array<string,mixed>, transits:list<array<string,mixed>>}|null
     */
    public static function transits(string $poleCode): ?array
    {
        Preload::exceptions();
        if (!CotralTime::isValidCode($poleCode)) {
            throw new BadRequest('Codice palina non valido');
        }
        return Cache::remember('cotral:transits:' . $poleCode, self::TRANSITS_TTL, static function () use ($poleCode): ?array {
            return self::parseTransits(Http::get(self::transitsUrl($poleCode), 10));
        }, 30);
    }

    /** @return array{pole:array<string,mixed>, transits:list<array<string,mixed>>}|null */
    public static function parseTransits(string $body): ?array
    {
        $root = CotralXml::parse($body);
        if ($root === null || !isset($root->palina)) {
            return null;
        }
        $corse = [];
        foreach ($root->corsa as $c) {
            $corse[] = $c;
        }
        if ($corse === []) {
            return null;
        }

        $p = $root->palina;
        $rawLat = CotralTime::parseDouble(CotralXml::text($p, 'latitudine')) ?? 0.0;
        $rawLon = CotralTime::parseDouble(CotralXml::text($p, 'longitudine')) ?? 0.0;
        [$lat, $lon] = CotralTime::normalizeLatLon($rawLat, $rawLon);

        return [
            'pole' => [
                'code' => CotralXml::text($p, 'codice'),
                'name' => CotralXml::text($p, 'nomePalina'),
                'stopName' => CotralXml::text($p, 'nomeStop'),
                'locality' => CotralXml::text($p, 'localita'),
                'comune' => CotralXml::text($p, 'comune'),
                'lat' => $lat,
                'lon' => $lon,
            ],
            'transits' => array_map(self::makeTransit(...), $corse),
        ];
    }

    /** @return array<string,mixed> */
    private static function makeTransit(\SimpleXMLElement $n): array
    {
        $vehicleCode = null;
        $alive = false;
        if (isset($n->automezzo)) {
            $a = $n->automezzo;
            $code = CotralXml::trimText((string) $a);
            $vehicleCode = $code === '' ? null : $code;
            $alive = (string) ($a['isAlive'] ?? '') === '1';
        }
        return [
            'idCorsa' => CotralXml::text($n, 'idCorsa'),
            'percorso' => CotralXml::text($n, 'percorso'),
            'partenzaCorsa' => CotralXml::text($n, 'partenzaCorsa'),
            'orarioPartenzaCorsa' => CotralTime::readableTime(CotralXml::text($n, 'orarioPartenzaCorsa')),
            'arrivoCorsa' => CotralXml::text($n, 'arrivoCorsa'),
            'orarioArrivoCorsa' => CotralTime::readableTime(CotralXml::text($n, 'orarioArrivoCorsa')),
            'soppressa' => CotralXml::text($n, 'soppressa'),
            'numeroOrdine' => CotralXml::text($n, 'numeroOrdine'),
            'tempoTransito' => CotralTime::readableTime(CotralXml::text($n, 'tempoTransito')),
            // raw seconds, NOT wrapped (negative = ahead of schedule)
            'ritardoSeconds' => CotralTime::parseInt(CotralXml::text($n, 'ritardo')) ?? 0,
            'passato' => CotralXml::text($n, 'passato'),
            'vehicleCode' => $vehicleCode,
            'vehicleAlive' => $alive,
            'testoFermata' => CotralXml::text($n, 'testoFermata'),
            'instradamento' => CotralXml::text($n, 'instradamento'),
            'banchina' => CotralXml::text($n, 'banchina'),
            'monitorata' => CotralXml::text($n, 'monitorata'),
            'accessibile' => CotralXml::text($n, 'accessibile'),
        ];
    }

    /** Transit.trackingStatus == .realtime: monitored AND the vehicle is transmitting. */
    public static function isDelayReliable(array $transit): bool
    {
        return $transit['monitorata'] === '1' && $transit['vehicleAlive'] === true;
    }

    /** Transit.canTrackVehicle. */
    public static function canTrackVehicle(array $transit): bool
    {
        return $transit['monitorata'] === '1' && ($transit['vehicleCode'] ?? '') !== '';
    }

    /**
     * Latest known position of a vehicle, null if none/invalid. Cached 5 s per code.
     *
     * @return array{lat:float,lon:float}|null
     */
    public static function vehiclePosition(string $vehicleCode): ?array
    {
        Preload::exceptions();
        if (!CotralTime::isValidCode($vehicleCode)) {
            throw new BadRequest('Codice veicolo non valido');
        }
        return Cache::remember('cotral:pos:' . $vehicleCode, self::POSITION_TTL, static function () use ($vehicleCode): ?array {
            return self::parsePosition(Http::get(self::positionUrl($vehicleCode), 10));
        }, 20);
    }

    /**
     * First `posizione`, last element of its pX / pY trail (VehiclePosition.latestCoordinate):
     * null when unparseable or the (0,0) "no fix" placeholder.
     *
     * @return array{lat:float,lon:float}|null
     */
    public static function parsePosition(string $body): ?array
    {
        $root = CotralXml::parse($body);
        if ($root === null || !isset($root->posizione)) {
            return null;
        }
        $node = $root->posizione;
        $xs = array_values(array_filter(explode(' ', (string) ($node['pX'] ?? '')), static fn($s) => $s !== ''));
        $ys = array_values(array_filter(explode(' ', (string) ($node['pY'] ?? '')), static fn($s) => $s !== ''));
        if ($xs === [] || $ys === []) {
            return null;
        }
        $lat = CotralTime::parseDouble($xs[count($xs) - 1]);
        $lon = CotralTime::parseDouble($ys[count($ys) - 1]);
        if ($lat === null || $lon === null || ($lat == 0.0 && $lon == 0.0)) {
            return null;
        }
        return ['lat' => $lat, 'lon' => $lon];
    }
}
