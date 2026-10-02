<?php
declare(strict_types=1);

namespace Madovai;

/** JSON response helpers shared by every endpoint under public/api. */
final class Json
{
    /**
     * Runs an endpoint body, turning any exception into a clean JSON error.
     * Endpoints are written as `Json::run(function () { ...; return $data; });`
     *
     * @param callable():mixed $body
     * @param int|null $maxAge  browser/CDN cache hint in seconds (null = no-store)
     */
    public static function run(callable $body, ?int $maxAge = null): never
    {
        try {
            $data = $body();
            self::out($data, 200, $maxAge);
        } catch (HttpException $e) {
            self::out(['error' => 'Servizio upstream non raggiungibile: ' . $e->getMessage()], 502);
        } catch (BadRequest $e) {
            self::out(['error' => $e->getMessage()], 400);
        } catch (NotReady $e) {
            self::out(['error' => $e->getMessage()], 503);
        } catch (\Throwable $e) {
            error_log('[madovai] ' . $e::class . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            self::out(['error' => 'Errore interno'], 500);
        }
    }

    /** @param mixed $data */
    public static function out($data, int $status = 200, ?int $maxAge = null): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header($maxAge !== null && $status === 200 ? 'Cache-Control: public, max-age=' . $maxAge : 'Cache-Control: no-store');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
        exit;
    }

    public static function requireMethod(string ...$methods): void
    {
        if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', $methods, true)) {
            header('Allow: ' . implode(', ', $methods));
            self::out(['error' => 'Metodo non consentito'], 405);
        }
    }

    /** @return array<string,mixed> decoded JSON request body */
    public static function body(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if (strlen($raw) > 256 * 1024) {
            throw new BadRequest('Richiesta troppo grande');
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new BadRequest('Corpo JSON non valido');
        }
        return $data;
    }
}

final class BadRequest extends \RuntimeException {}

/** Thrown when static data (the SQLite GTFS database) hasn't been generated yet. */
final class NotReady extends \RuntimeException {}
