<?php
declare(strict_types=1);

namespace Madovai\Push;

/**
 * Web Push message encryption (RFC 8291, "aes128gcm" content coding of RFC 8188)
 * and request assembly, using only ext/openssl + hash_hkdf.
 */
final class WebPush
{
    public const RECORD_SIZE = 4096;
    /** Plaintext + 1 padding delimiter + 16 tag bytes must fit one record. */
    public const MAX_PAYLOAD = self::RECORD_SIZE - 16 - 1;

    /**
     * Encrypts $plaintext for a subscription and returns the complete request body
     * (RFC 8188 header || ciphertext).
     *
     * @param string $uaPublic   subscription p256dh, raw 65 bytes
     * @param string $authSecret subscription auth, raw 16 bytes
     * @param string|null $salt  16 random bytes (injectable for tests)
     * @param array{private:string,public:string}|null $as application-server ephemeral key pair, raw (injectable for tests)
     */
    public static function encrypt(string $plaintext, string $uaPublic, string $authSecret, ?string $salt = null, ?array $as = null): string
    {
        if (strlen($plaintext) > self::MAX_PAYLOAD) {
            throw new \InvalidArgumentException('Payload push troppo grande');
        }
        if (strlen($authSecret) !== 16) {
            throw new \InvalidArgumentException('auth secret non valido');
        }
        $uaKey = Ec::publicKey($uaPublic);
        if ($uaKey === null) {
            throw new \InvalidArgumentException('p256dh non è un punto P-256 valido');
        }
        $salt ??= random_bytes(16);
        if (strlen($salt) !== 16) {
            throw new \InvalidArgumentException('salt non valido');
        }
        $as ??= Ec::generate();
        $asPublic = $as['public'];
        $asPrivate = openssl_pkey_get_private(Ec::privatePem($as['private'], $asPublic));
        if ($asPrivate === false) {
            throw new \RuntimeException('Chiave effimera non valida');
        }

        $ecdh = openssl_pkey_derive($uaKey, $asPrivate);
        if ($ecdh === false || strlen($ecdh) !== 32) {
            throw new \RuntimeException('ECDH fallito: ' . openssl_error_string());
        }

        // RFC 8291 §3.3/3.4: combine ECDH secret and auth secret, then RFC 8188 key/nonce derivation.
        $keyInfo = "WebPush: info\0" . $uaPublic . $asPublic;
        $ikm = hash_hkdf('sha256', $ecdh, 32, $keyInfo, $authSecret);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);

        $tag = '';
        $cipher = openssl_encrypt($plaintext . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
        if ($cipher === false) {
            throw new \RuntimeException('AES-GCM fallito: ' . openssl_error_string());
        }

        // RFC 8188 §2.1 header: salt(16) | rs(4, BE) | idlen(1) | keyid (= as_public, 65)
        return $salt . pack('N', self::RECORD_SIZE) . chr(65) . $asPublic . $cipher . $tag;
    }

    /**
     * @param array{endpoint:string,keys:array{p256dh:string,auth:string}} $subscription
     * @return array{url:string,headers:list<string>,body:string}
     */
    public static function buildRequest(array $subscription, string $payload, Vapid $vapid, int $ttl = 600, string $urgency = 'high'): array
    {
        $ua = B64::dec($subscription['keys']['p256dh']);
        $auth = B64::dec($subscription['keys']['auth']);
        if ($ua === null || $auth === null) {
            throw new \InvalidArgumentException('Chiavi di sottoscrizione non valide');
        }
        $body = self::encrypt($payload, $ua, $auth);
        return [
            'url' => $subscription['endpoint'],
            'headers' => [
                'Authorization: ' . $vapid->authorization($subscription['endpoint']),
                'Content-Encoding: aes128gcm',
                'Content-Type: application/octet-stream',
                'Content-Length: ' . strlen($body),
                'TTL: ' . $ttl,
                'Urgency: ' . $urgency,
            ],
            'body' => $body,
        ];
    }
}
