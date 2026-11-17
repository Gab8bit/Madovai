<?php
declare(strict_types=1);

namespace Madovai\Push;

// BadRequest/NotReady live in Json.php (not autoloadable by class name): make sure they exist before we throw them.
require_once __DIR__ . "/../Json.php";

use Madovai\Config;
use Madovai\NotReady;

/**
 * VAPID (RFC 8292) application server identity: a P-256 key pair stored in
 * data/vapid.json, and ES256 JWTs scoped to a push service origin.
 */
final class Vapid
{
    /** JWT lifetime. RFC 8292 caps `exp` at 24h; Apple/others are fine with <=12h, we stay below. */
    public const JWT_TTL = 11 * 3600;

    public function __construct(
        private readonly string $privatePem,
        private readonly string $publicKeyB64,
        private readonly string $subject,
    ) {}

    public static function path(): string
    {
        return Config::dataDir() . '/vapid.json';
    }

    /** Creates the key pair file (chmod 600). Refuses to overwrite unless $force. */
    public static function generate(?string $path = null, bool $force = false): string
    {
        $path ??= self::path();
        if (is_file($path) && !$force) {
            throw new \RuntimeException("$path esiste già (rigenerare le chiavi invalida tutte le sottoscrizioni push: usa --force)");
        }
        $pair = Ec::generate();
        $json = json_encode([
            'publicKey' => B64::enc($pair['public']),
            'privateKeyPem' => $pair['pem'],
            'createdAt' => gmdate('c'),
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        $old = umask(0077);
        try {
            $tmp = $path . '.' . getmypid() . '.tmp';
            file_put_contents($tmp, $json . "\n");
            chmod($tmp, 0600);
            rename($tmp, $path);
        } finally {
            umask($old);
        }
        return B64::enc($pair['public']);
    }

    public static function exists(?string $path = null): bool
    {
        return is_file($path ?? self::path());
    }

    /** @throws NotReady when the key file is missing/corrupt */
    public static function load(?string $path = null): self
    {
        $path ??= self::path();
        $raw = @file_get_contents($path);
        $d = $raw === false ? null : json_decode($raw, true);
        if (!is_array($d) || !is_string($d['publicKey'] ?? null) || !is_string($d['privateKeyPem'] ?? null)) {
            throw new NotReady('Web Push non configurato: esegui "php bin/gen-vapid.php" sul server.');
        }
        $subject = (string) Config::get('vapid_subject', 'mailto:admin@example.com');
        return new self($d['privateKeyPem'], $d['publicKey'], $subject);
    }

    public function publicKey(): string
    {
        return $this->publicKeyB64;
    }

    /** "https://push.example.net" from a push endpoint URL (the JWT `aud`). */
    public static function audience(string $endpoint): string
    {
        $p = parse_url($endpoint);
        if (!is_array($p) || !isset($p['scheme'], $p['host'])) {
            throw new \InvalidArgumentException('Endpoint push non valido');
        }
        return $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    }

    public function jwt(string $audience, ?int $now = null): string
    {
        $now ??= time();
        $header = B64::enc(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
        $claims = B64::enc(json_encode(['aud' => $audience, 'exp' => $now + self::JWT_TTL, 'sub' => $this->subject], JSON_UNESCAPED_SLASHES));
        $input = $header . '.' . $claims;
        $der = '';
        if (!openssl_sign($input, $der, $this->privatePem, OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('Firma VAPID fallita: ' . openssl_error_string());
        }
        return $input . '.' . B64::enc(Ec::derToRaw($der));
    }

    /** Value of the Authorization header (RFC 8292 §3, "vapid" scheme — accepted by FCM, Mozilla, Apple, WNS). */
    public function authorization(string $endpoint, ?int $now = null): string
    {
        return 'vapid t=' . $this->jwt(self::audience($endpoint), $now) . ', k=' . $this->publicKeyB64;
    }

    /** Verifies an ES256 JWT against a base64url public key (used by tests). */
    public static function verify(string $jwt, string $publicKeyB64): bool
    {
        $parts = explode('.', $jwt);
        $pub = B64::dec($publicKeyB64);
        $sig = count($parts) === 3 ? B64::dec($parts[2]) : null;
        if ($pub === null || $sig === null || strlen($sig) !== 64) {
            return false;
        }
        $key = Ec::publicKey($pub);
        return $key !== null
            && openssl_verify($parts[0] . '.' . $parts[1], Ec::rawToDer($sig), $key, OPENSSL_ALGO_SHA256) === 1;
    }
}
