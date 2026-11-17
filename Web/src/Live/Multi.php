<?php
declare(strict_types=1);

namespace Madovai\Live;

/**
 * Concurrent HTTP fan-out on curl_multi with a hard overall deadline, so one
 * slow upstream can never pin a PHP worker. A request that fails, times out or
 * answers non-2xx simply yields null (like Swift's `try?` in the iOS fan-outs).
 */
final class Multi
{
    /**
     * @param array<string|int, array{url:string, method?:string, body?:string, headers?:list<string>, opts?:array<int,mixed>}> $requests
     * @param float $deadlineSeconds  overall budget for the whole batch
     * @return array<string|int, ?string>  same keys; response body or null
     */
    public static function fetch(array $requests, float $deadlineSeconds = 10.0, int $maxConnections = 12): array
    {
        Preload::exceptions();
        $results = array_fill_keys(array_keys($requests), null);
        if ($requests === []) {
            return $results;
        }
        $deadlineAt = microtime(true) + $deadlineSeconds;
        $mh = curl_multi_init();
        if (defined('CURLMOPT_MAX_TOTAL_CONNECTIONS')) {
            curl_multi_setopt($mh, CURLMOPT_MAX_TOTAL_CONNECTIONS, $maxConnections);
        }

        /** @var array<int, array{0:\CurlHandle, 1:string|int}> $handles */
        $handles = [];
        foreach ($requests as $key => $req) {
            $ch = curl_init($req['url']);
            $opts = [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS => 3,
                CURLOPT_TIMEOUT => max(1, (int) ceil($deadlineSeconds)),
                CURLOPT_CONNECTTIMEOUT => 6,
                CURLOPT_USERAGENT => 'MadovaiWeb/1.0',
                CURLOPT_ENCODING => '',
                CURLOPT_HTTPHEADER => $req['headers'] ?? [],
            ];
            if (($req['method'] ?? 'GET') === 'POST') {
                $opts[CURLOPT_POST] = true;
                $opts[CURLOPT_POSTFIELDS] = $req['body'] ?? '';
            }
            foreach ($req['opts'] ?? [] as $opt => $value) {
                $opts[$opt] = $value;
            }
            curl_setopt_array($ch, $opts);
            curl_multi_add_handle($mh, $ch);
            $handles[spl_object_id($ch)] = [$ch, $key];
        }

        $running = 0;
        do {
            $status = curl_multi_exec($mh, $running);
        } while ($status === CURLM_CALL_MULTI_PERFORM);

        while ($running > 0 && $status === CURLM_OK && microtime(true) < $deadlineAt) {
            if (curl_multi_select($mh, 0.25) === -1) {
                usleep(20000);
            }
            do {
                $status = curl_multi_exec($mh, $running);
            } while ($status === CURLM_CALL_MULTI_PERFORM);
        }

        foreach ($handles as [$ch, $key]) {
            if (curl_errno($ch) === 0 && curl_multi_getcontent($ch) !== null) {
                $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                if ($code >= 200 && $code < 300) {
                    $results[$key] = (string) curl_multi_getcontent($ch);
                }
            }
            curl_multi_remove_handle($mh, $ch);
        }
        curl_multi_close($mh);
        return $results;
    }

    /**
     * One request, throwing HttpException (with curl's message) on any failure.
     *
     * @param array{url:string, method?:string, body?:string, headers?:list<string>, opts?:array<int,mixed>} $req
     */
    public static function single(array $req, int $timeout = 10): string
    {
        Preload::exceptions();
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_USERAGENT => 'MadovaiWeb/1.0',
            CURLOPT_ENCODING => '',
            CURLOPT_HTTPHEADER => $req['headers'] ?? [],
        ];
        if (($req['method'] ?? 'GET') === 'POST') {
            $opts[CURLOPT_POST] = true;
            $opts[CURLOPT_POSTFIELDS] = $req['body'] ?? '';
        }
        foreach ($req['opts'] ?? [] as $opt => $value) {
            $opts[$opt] = $value;
        }
        $ch = curl_init($req['url']);
        curl_setopt_array($ch, $opts);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        if ($body === false) {
            throw new \Madovai\HttpException('Richiesta fallita: ' . $error);
        }
        if ($status < 200 || $status >= 300) {
            throw new \Madovai\HttpException("HTTP $status", $status);
        }
        return (string) $body;
    }
}
