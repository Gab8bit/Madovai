<?php
declare(strict_types=1);

namespace Madovai\Live;

use Madovai\BadRequest;
use Madovai\Cache;
use Madovai\Config;
use Madovai\HttpException;
use Madovai\Rome;

/**
 * ASTRAL live rail schedules (gestionecorse.astralspa.it, public JSON).
 * Port of AstralTrainClient + AstralTrainRepository. Station lists are tiny and
 * stable (8 routes) and cached for hours; per-station day schedules for 15 s.
 */
final class AstralRepository
{
    public const STATIONS_TTL = 21600; // 6 h
    public const TRANSIT_TTL = 15;
    public const LINE_TTL = 20;

    private static function assertRoute(string $route): void
    {
        Preload::exceptions();
        if (!CotralTrainRoute::isValid($route)) {
            throw new BadRequest('Percorso non valido');
        }
    }

    /**
     * ASTRAL's TLS server sends an incomplete chain (leaf only, no Sectigo intermediate): browsers and
     * iOS/macOS chase the AIA link, OpenSSL (PHP curl) does not. The intermediate ships in src/certs/
     * (fingerprint + verification notes in src/certs/README.md); it can be overridden with `astral_ca_file`
     * (config.php / MADOVAI_ASTRAL_CA_FILE) or data/astral-ca.pem.
     *
     * It must be ADDED to the system CA bundle, not replace it (curl's CAINFO is a full trust store), so a
     * combined bundle is built once into data/cache and used for ASTRAL requests only — TLS verification stays on.
     */
    private static function caFile(): ?string
    {
        $extra = null;
        $configured = Config::get('astral_ca_file');
        foreach ([is_string($configured) ? $configured : '', Config::dataDir() . '/astral-ca.pem', Config::root() . '/src/certs/sectigo-ov-r36.pem'] as $candidate) {
            if ($candidate !== '' && is_file($candidate)) { $extra = $candidate; break; }
        }
        if ($extra === null) {
            return null;
        }
        $system = self::systemBundle();
        if ($system === null) {
            return $extra; // best effort: partial chain from the intermediate alone
        }
        $dir = Config::dataDir() . '/cache';
        if (!is_dir($dir)) { @mkdir($dir, 0775, true); }
        $combined = $dir . '/astral-ca-bundle-' . substr(sha1($extra . @filemtime($extra) . $system . @filemtime($system)), 0, 12) . '.pem';
        if (!is_file($combined)) {
            $tmp = $combined . '.' . getmypid() . '.tmp';
            if (@file_put_contents($tmp, file_get_contents($system) . "\n" . file_get_contents($extra)) === false || !@rename($tmp, $combined)) {
                return $extra;
            }
        }
        return $combined;
    }

    /** The system CA bundle PHP/curl would use by default (needed to build the combined bundle above). */
    private static function systemBundle(): ?string
    {
        $candidates = [ini_get('curl.cainfo') ?: '', ini_get('openssl.cafile') ?: ''];
        $loc = function_exists('openssl_get_cert_locations') ? openssl_get_cert_locations() : [];
        $candidates[] = (string) ($loc['default_cert_file'] ?? '');
        array_push($candidates, '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/ca-bundle.pem', '/etc/ssl/cert.pem', '/opt/homebrew/etc/ca-certificates/cert.pem');
        foreach ($candidates as $c) {
            if ($c !== '' && is_file($c) && is_readable($c)) { return $c; }
        }
        return null;
    }

    /** `astral_base_url` override exists for tests / a corporate proxy; defaults to the real API. */
    private static function baseUrl(): string
    {
        return rtrim((string) Config::get('astral_base_url', Config::ASTRAL_BASE_URL), '/');
    }

    /** @return array{url:string, method:string, body:string, headers:list<string>, opts:array<int,mixed>} */
    public static function stationsRequest(string $route): array
    {
        return self::post('fermate/' . $route, []);
    }

    /** @return array{url:string, method:string, body:string, headers:list<string>, opts:array<int,mixed>} */
    public static function transitRequest(string $route, string $fermata): array
    {
        return self::post('transit', ['percorso' => $route, 'fermata' => $fermata]);
    }

    /** @param array<string,string> $body */
    private static function post(string $path, array $body): array
    {
        $ca = self::caFile();
        return [
            'url' => self::baseUrl() . '/' . $path,
            'method' => 'POST',
            'body' => $body === [] ? '{}' : json_encode($body, JSON_UNESCAPED_UNICODE),
            'headers' => ['Content-Type: application/json'],
            'opts' => $ca === null ? [] : [CURLOPT_CAINFO => $ca],
        ];
    }

    private static function call(array $req): string
    {
        return Multi::single($req, 10);
    }

    /**
     * All stations of one route, in physical order.
     *
     * @return list<array{name:string, code:string, order:int}>
     */
    public static function stations(string $route): array
    {
        self::assertRoute($route);
        return Cache::remember('astral:stations:' . $route, self::STATIONS_TTL, static function () use ($route): array {
            return self::parseStations(self::call(self::stationsRequest($route)));
        }, 172800);
    }

    /** @return list<array{name:string, code:string, order:int}> */
    public static function parseStations(string $json): array
    {
        $data = json_decode($json, true);
        if (!is_array($data)) {
            throw new HttpException('Risposta ASTRAL non valida');
        }
        $out = [];
        foreach ($data as $row) {
            if (!is_array($row) || !isset($row['nomeFermata'], $row['codice'], $row['ordine'])) {
                continue;
            }
            $out[] = ['name' => (string) $row['nomeFermata'], 'code' => (string) $row['codice'], 'order' => (int) $row['ordine']];
        }
        if ($out === []) {
            throw new HttpException('Nessuna stazione ASTRAL');
        }
        usort($out, static fn($a, $b) => $a['order'] <=> $b['order']);
        return $out;
    }

    /**
     * One station's entire day for a route (Entry list). Cached 15 s.
     *
     * @return list<array<string,mixed>>
     */
    public static function transitEntries(string $route, string $fermata): array
    {
        self::assertRoute($route);
        if (!CotralTime::isValidCode($fermata)) {
            throw new BadRequest('Fermata non valida');
        }
        return Cache::remember(self::transitKey($route, $fermata), self::TRANSIT_TTL, static function () use ($route, $fermata): array {
            return self::parseTransits(self::call(self::transitRequest($route, $fermata)));
        }, 60);
    }

    public static function transitKey(string $route, string $fermata): string
    {
        return 'astral:transit:' . $route . ':' . $fermata;
    }

    /**
     * ASTRAL's `ritardo` empty string = not computed yet (null), soppressa/busSostitutivo "Y" (trimmed, any case).
     * Entries whose `orario` isn't "H:MM" are dropped.
     *
     * @return list<array{id:string,time:string,sortSeconds:int,delayMinutes:?int,isCancelled:bool,isReplacementBus:bool}>
     */
    public static function parseTransits(string $json): array
    {
        $data = json_decode($json, true);
        if (!is_array($data)) {
            throw new HttpException('Risposta ASTRAL non valida');
        }
        $yes = static fn($v): bool => strtoupper(trim((string) $v, " \t")) === 'Y';
        $out = [];
        foreach ($data as $row) {
            if (!is_array($row)) {
                continue;
            }
            $time = (string) ($row['orario'] ?? '');
            $seconds = CotralTime::secondsFromHHMM($time);
            if ($seconds === null) {
                continue;
            }
            $out[] = [
                'id' => (string) ($row['corsa'] ?? ''),
                'time' => $time,
                'sortSeconds' => $seconds,
                'delayMinutes' => CotralTime::parseInt((string) ($row['ritardo'] ?? '')),
                'isCancelled' => $yes($row['soppressa'] ?? ''),
                'isReplacementBus' => $yes($row['busSostitutivo'] ?? ''),
            ];
        }
        return $out;
    }

    /**
     * Station code by name: exact match first (trimmed, lowercased), then substring in either direction.
     *
     * @param list<array{name:string, code:string, order:int}> $stations
     */
    public static function resolveFermata(array $stations, string $stationName): ?string
    {
        $norm = static fn(string $s): string => mb_strtolower(trim($s, " \t"));
        $target = $norm($stationName);
        if ($target === '') {
            return null;
        }
        foreach ($stations as $s) {
            if ($norm($s['name']) === $target) {
                return $s['code'];
            }
        }
        foreach ($stations as $s) {
            $name = $norm($s['name']);
            if ($name === '') {
                continue;
            }
            if (str_contains($name, $target) || str_contains($target, $name)) {
                return $s['code'];
            }
        }
        return null;
    }

    /**
     * The whole day's entries at `$stationName` for `$route`'s direction; null when the station can't be
     * matched for this route (not an error: the caller falls through to the next tier).
     *
     * @return array{destination:string, route:string, entries:list<array<string,mixed>>}|null
     */
    public static function departures(string $route, string $stationName): ?array
    {
        $fermata = self::resolveFermata(self::stations($route), $stationName);
        if ($fermata === null) {
            return null;
        }
        return [
            'destination' => CotralTrainRoute::destinationName($route),
            'route' => $route,
            'entries' => self::transitEntries($route, $fermata),
        ];
    }

    /**
     * `[AstralDeparture].upcoming()`: entries not yet passed (sortSeconds >= now, Rome), soonest first.
     *
     * @param list<array<string,mixed>> $entries
     * @return list<array<string,mixed>>
     */
    public static function upcoming(array $entries, ?int $nowSeconds = null): array
    {
        $now = $nowSeconds ?? Rome::secondsSinceMidnight();
        $future = array_values(array_filter($entries, static fn($e) => $e['sortSeconds'] >= $now));
        usort($future, static fn($a, $b) => $a['sortSeconds'] <=> $b['sortSeconds']);
        return $future;
    }

    /**
     * Per-station "next passage" for a line (api/astral-line.php): one /api/transit per station,
     * in parallel. A station whose call fails gets `next: null`.
     *
     * @return array<string,mixed>
     */
    public static function line(string $route): array
    {
        self::assertRoute($route);
        return Cache::remember('astral:line:' . $route, self::LINE_TTL, static function () use ($route): array {
            $stations = self::stations($route);

            $entriesByCode = [];
            $missing = [];
            foreach ($stations as $s) {
                $hit = Memo::peek(self::transitKey($route, $s['code']), self::TRANSIT_TTL);
                if ($hit !== null) {
                    $entriesByCode[$s['code']] = $hit[0];
                } else {
                    $missing[$s['code']] = self::transitRequest($route, $s['code']);
                }
            }
            foreach (Multi::fetch($missing, 10.0) as $code => $body) {
                if ($body === null) {
                    continue;
                }
                try {
                    $entries = self::parseTransits($body);
                } catch (HttpException) {
                    continue;
                }
                Memo::put(self::transitKey($route, (string) $code), $entries);
                $entriesByCode[(string) $code] = $entries;
            }

            $now = Rome::secondsSinceMidnight();
            $out = [];
            foreach ($stations as $s) {
                $next = isset($entriesByCode[$s['code']]) ? (self::upcoming($entriesByCode[$s['code']], $now)[0] ?? null) : null;
                $out[] = ['name' => $s['name'], 'code' => $s['code'], 'order' => $s['order'], 'next' => $next];
            }
            return [
                'route' => $route,
                'directionLabel' => CotralTrainRoute::directionLabel($route),
                'lineName' => CotralTrainRoute::lineName($route),
                'stations' => $out,
            ];
        }, 60);
    }
}
