<?php
declare(strict_types=1);

namespace Madovai\Push;

// BadRequest/NotReady live in Json.php (not autoloadable by class name): make sure they exist before we throw them.
require_once __DIR__ . "/../Json.php";

use Madovai\BadRequest;
use Madovai\Config;

/** Strict validation/normalisation of everything the client sends to the push endpoints. */
final class Validator
{
    public const MAX_REMINDERS = 30;
    public const MAX_ENDPOINT = 600;
    public const TRAIN_ROUTES = [
        'RL_CC-PSP', 'RL_PSP-CC', 'RN_RMMON', 'RN_MONRM',
        'RV_CATVIT', 'RV_VITCAT', 'RV_MORCAT', 'RV_CATMOR',
    ];

    /** Tests/local dev only (MADOVAI_PUSH_ALLOW_INSECURE=1): permit http://localhost endpoints. */
    private static function insecureAllowed(): bool
    {
        $v = Config::get('push_allow_insecure', false);
        return $v === true || $v === '1' || $v === 1 || $v === 'true';
    }

    /**
     * Subscription endpoint rules: https, <=600 chars, port 443, no credentials,
     * a real DNS name (no IP literals, localhost, single-label or internal TLDs).
     * Keeps the server from being used as a blind-request proxy to internal hosts.
     */
    public static function endpointError(string $endpoint): ?string
    {
        if ($endpoint === '' || strlen($endpoint) > self::MAX_ENDPOINT) {
            return 'endpoint mancante o troppo lungo';
        }
        if (preg_match('/[\x00-\x20\x7f]/', $endpoint)) {
            return 'endpoint non valido';
        }
        $p = parse_url($endpoint);
        if (!is_array($p) || !isset($p['scheme'], $p['host']) || isset($p['user']) || isset($p['pass']) || isset($p['fragment'])) {
            return 'endpoint non valido';
        }
        $p['scheme'] = strtolower($p['scheme']);
        if (self::insecureAllowed()) {
            return in_array($p['scheme'], ['http', 'https'], true) ? null : 'endpoint non valido';
        }
        if ($p['scheme'] !== 'https') {
            return 'endpoint deve essere https';
        }
        if (isset($p['port']) && $p['port'] !== 443) {
            return 'endpoint con porta non consentita';
        }
        return self::hostError($p['host']);
    }

    private static function hostError(string $host): ?string
    {
        $host = strtolower(trim($host, '[]'));
        if (filter_var($host, FILTER_VALIDATE_IP) !== false || str_contains($host, ':')) {
            return 'endpoint con IP non consentito';
        }
        if (!preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]+$/', $host)
            || preg_match('/\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/', $host)) {
            return 'endpoint host non consentito';
        }
        return null;
    }

    /**
     * Send-time guard (defence in depth): same URL rules + the host must not
     * resolve to a private/reserved address.
     */
    public static function pushHostAllowed(string $endpoint): bool
    {
        if (self::endpointError($endpoint) !== null) {
            return false;
        }
        if (self::insecureAllowed()) {
            return true;
        }
        $host = (string) parse_url($endpoint, PHP_URL_HOST);
        $ips = @gethostbynamel($host) ?: [];
        if ($ips === []) {
            return true; // unresolvable: curl will fail by itself
        }
        foreach ($ips as $ip) {
            if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
                return false;
            }
        }
        return true;
    }

    /**
     * @param mixed $sub decoded `subscription` object
     * @return array{endpoint:string,keys:array{p256dh:string,auth:string}}
     */
    public static function subscription($sub, bool $needKeys = true): array
    {
        if (!is_array($sub)) {
            throw new BadRequest('subscription mancante');
        }
        $endpoint = $sub['endpoint'] ?? null;
        if (!is_string($endpoint)) {
            throw new BadRequest('subscription.endpoint mancante');
        }
        if (($e = self::endpointError($endpoint)) !== null) {
            throw new BadRequest($e);
        }
        if (!$needKeys) {
            return ['endpoint' => $endpoint, 'keys' => ['p256dh' => '', 'auth' => '']];
        }
        $keys = $sub['keys'] ?? null;
        if (!is_array($keys) || !is_string($keys['p256dh'] ?? null) || !is_string($keys['auth'] ?? null)) {
            throw new BadRequest('subscription.keys mancanti');
        }
        $p256dh = B64::dec($keys['p256dh']);
        if ($p256dh === null || strlen($p256dh) !== 65 || str_contains($keys['p256dh'], '=') || Ec::publicKey($p256dh) === null) {
            throw new BadRequest('keys.p256dh non valida');
        }
        $auth = B64::dec($keys['auth']);
        if ($auth === null || strlen($auth) !== 16 || str_contains($keys['auth'], '=')) {
            throw new BadRequest('keys.auth non valida');
        }
        return ['endpoint' => $endpoint, 'keys' => ['p256dh' => $keys['p256dh'], 'auth' => $keys['auth']]];
    }

    /**
     * @param mixed $list decoded `reminders` array
     * @return list<array<string,mixed>> normalised reminders (unknown keys dropped)
     */
    public static function reminders($list): array
    {
        if (!is_array($list) || ($list !== [] && !array_is_list($list))) {
            throw new BadRequest('reminders deve essere un array');
        }
        if (count($list) > self::MAX_REMINDERS) {
            throw new BadRequest('Troppi promemoria (max ' . self::MAX_REMINDERS . ')');
        }
        $out = [];
        $seen = [];
        foreach ($list as $r) {
            $n = self::reminder($r);
            if (isset($seen[$n['id']])) {
                throw new BadRequest('id promemoria duplicato');
            }
            $seen[$n['id']] = true;
            $out[] = $n;
        }
        return $out;
    }

    /**
     * @param mixed $r
     * @return array<string,mixed>
     */
    public static function reminder($r): array
    {
        if (!is_array($r)) {
            throw new BadRequest('promemoria non valido');
        }
        $id = $r['id'] ?? null;
        if (!is_string($id) || !preg_match('/^[A-Za-z0-9-]{1,64}$/', $id)) {
            throw new BadRequest('promemoria.id non valido');
        }
        $stopName = self::text($r['stopName'] ?? null, 120, 'stopName');
        $hour = $r['hour'] ?? null;
        $minute = $r['minute'] ?? null;
        if (!is_int($hour) || $hour < 0 || $hour > 23) {
            throw new BadRequest('hour deve essere 0-23');
        }
        if (!is_int($minute) || $minute < 0 || $minute > 59) {
            throw new BadRequest('minute deve essere 0-59');
        }
        $wd = $r['weekdays'] ?? null;
        if (!is_array($wd) || $wd === [] || count($wd) > 14) {
            throw new BadRequest('weekdays non valido');
        }
        $days = [];
        foreach ($wd as $d) {
            if (!is_int($d) || $d < 1 || $d > 7) {
                throw new BadRequest('weekdays deve contenere interi 1-7');
            }
            $days[$d] = $d;
        }
        ksort($days);
        return [
            'id' => $id,
            'stopName' => $stopName,
            'weekdays' => array_values($days),
            'hour' => $hour,
            'minute' => $minute,
            'source' => self::source($r['source'] ?? null),
        ];
    }

    /**
     * @param mixed $s
     * @return array<string,string>
     */
    public static function source($s): array
    {
        if (!is_array($s) || !is_string($s['type'] ?? null)) {
            throw new BadRequest('source non valida');
        }
        switch ($s['type']) {
            case 'cotralBus':
                return ['type' => 'cotralBus', 'poleCode' => self::text($s['poleCode'] ?? null, 64, 'poleCode')];
            case 'cotralTrain':
                $route = $s['route'] ?? null;
                if (!is_string($route) || !in_array($route, self::TRAIN_ROUTES, true)) {
                    throw new BadRequest('source.route non valida');
                }
                return ['type' => 'cotralTrain', 'stationName' => self::text($s['stationName'] ?? null, 64, 'stationName'), 'route' => $route];
            case 'atacStop':
                return ['type' => 'atacStop', 'stopId' => self::text($s['stopId'] ?? null, 64, 'stopId')];
        }
        throw new BadRequest('source.type non valido');
    }

    /** @param mixed $v */
    private static function text($v, int $max, string $name): string
    {
        if (!is_string($v)) {
            throw new BadRequest("$name mancante");
        }
        $v = trim($v);
        if ($v === '' || mb_strlen($v) > $max || !mb_check_encoding($v, 'UTF-8') || preg_match('/[\x00-\x1f\x7f]/', $v)) {
            throw new BadRequest("$name non valido");
        }
        return $v;
    }
}
