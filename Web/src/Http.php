<?php
declare(strict_types=1);

namespace Madovai;

final class HttpException extends \RuntimeException
{
    public function __construct(string $message, public readonly int $status = 0)
    {
        parent::__construct($message, $status);
    }
}

/** Thin cURL wrapper — GET and JSON POST with timeouts, redirects followed. */
final class Http
{
    public static function get(string $url, int $timeout = Config::REQUEST_TIMEOUT): string
    {
        return self::request($url, 'GET', null, [], $timeout);
    }

    /** @param array<string,mixed> $body */
    public static function postJson(string $url, array $body, int $timeout = Config::REQUEST_TIMEOUT): string
    {
        return self::request($url, 'POST', json_encode($body, JSON_UNESCAPED_UNICODE) ?: '{}', ['Content-Type: application/json'], $timeout);
    }

    /**
     * Raw POST used by Web Push. Returns [status, body] and does NOT throw on 4xx/5xx
     * (the caller needs 404/410 to prune dead subscriptions).
     *
     * @param array<int,string> $headers
     * @return array{0:int,1:string}
     */
    public static function postRaw(string $url, string $body, array $headers, int $timeout = 15): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_USERAGENT => 'MadovaiWeb/1.0',
        ]);
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        if ($response === false) {
            throw new HttpException('Richiesta fallita: ' . $error);
        }
        return [$status, (string) $response];
    }

    /**
     * Downloads `$url` straight to `$destFile` (used for the big GTFS zips — never buffered in memory).
     */
    public static function download(string $url, string $destFile, int $timeout = 600): void
    {
        $fp = fopen($destFile, 'wb');
        if ($fp === false) {
            throw new HttpException("Impossibile scrivere $destFile");
        }
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_FILE => $fp,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_USERAGENT => 'MadovaiWeb/1.0',
            CURLOPT_FAILONERROR => true,
        ]);
        $ok = curl_exec($ch);
        $error = curl_error($ch);
        fclose($fp);
        if ($ok === false) {
            @unlink($destFile);
            throw new HttpException("Download fallito ($url): $error");
        }
    }

    /**
     * @param array<int,string> $headers
     */
    private static function request(string $url, string $method, ?string $body, array $headers, int $timeout): string
    {
        $ch = curl_init($url);
        $opts = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_USERAGENT => 'MadovaiWeb/1.0',
            CURLOPT_ENCODING => '', // accept gzip/deflate transparently
            CURLOPT_HTTPHEADER => $headers,
        ];
        if ($method === 'POST') {
            $opts[CURLOPT_POST] = true;
            $opts[CURLOPT_POSTFIELDS] = $body ?? '';
        }
        curl_setopt_array($ch, $opts);
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);

        if ($response === false) {
            throw new HttpException('Richiesta fallita: ' . $error);
        }
        if ($status < 200 || $status >= 300) {
            throw new HttpException("HTTP $status", $status);
        }
        return (string) $response;
    }
}
