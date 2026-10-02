<?php
declare(strict_types=1);

namespace Madovai\Push;

/**
 * P-256 helpers around ext/openssl: build PEM keys from raw EC points / scalars
 * (openssl_pkey_derive and openssl_sign only take PEM/DER), generate key pairs,
 * and convert ECDSA signatures between DER and the raw R||S form JWT needs.
 */
final class Ec
{
    /** SubjectPublicKeyInfo header for an uncompressed P-256 point (id-ecPublicKey + prime256v1 + BIT STRING 0x42). */
    private const SPKI_PREFIX_HEX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

    /** @param string $raw65 uncompressed point 0x04||X||Y */
    public static function publicPem(string $raw65): string
    {
        if (strlen($raw65) !== 65 || $raw65[0] !== "\x04") {
            throw new \InvalidArgumentException('Chiave pubblica P-256 non valida');
        }
        return self::pem('PUBLIC KEY', hex2bin(self::SPKI_PREFIX_HEX) . $raw65);
    }

    /** SEC1 ECPrivateKey PEM from the raw 32-byte scalar and the matching uncompressed public point. */
    public static function privatePem(string $raw32, string $raw65): string
    {
        if (strlen($raw32) !== 32 || strlen($raw65) !== 65) {
            throw new \InvalidArgumentException('Chiave privata P-256 non valida');
        }
        $der = "\x30\x77\x02\x01\x01\x04\x20" . $raw32
            . "\xa0\x0a\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07"
            . "\xa1\x44\x03\x42\x00" . $raw65;
        return self::pem('EC PRIVATE KEY', $der);
    }

    /** @return \OpenSSLAsymmetricKey|null null when the point is not a valid P-256 point */
    public static function publicKey(string $raw65)
    {
        try {
            $key = @openssl_pkey_get_public(self::publicPem($raw65));
        } catch (\Throwable) {
            return null;
        }
        return $key === false ? null : $key;
    }

    /** @return array{private:string,public:string,pem:string} raw scalar (32B), raw point (65B), PEM private key */
    public static function generate(): array
    {
        $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
        if ($key === false) {
            throw new \RuntimeException('openssl_pkey_new fallita: ' . openssl_error_string());
        }
        $d = openssl_pkey_get_details($key)['ec'];
        $public = "\x04" . str_pad($d['x'], 32, "\0", STR_PAD_LEFT) . str_pad($d['y'], 32, "\0", STR_PAD_LEFT);
        $private = str_pad($d['d'], 32, "\0", STR_PAD_LEFT);
        return ['private' => $private, 'public' => $public, 'pem' => self::privatePem($private, $public)];
    }

    /** ECDSA DER signature -> raw 64-byte R||S. */
    public static function derToRaw(string $der): string
    {
        $p = 0;
        if (($der[$p++] ?? '') !== "\x30") {
            throw new \RuntimeException('Firma DER non valida');
        }
        $len = ord($der[$p++]);
        if ($len & 0x80) {
            $p += $len & 0x7f; // long-form length: never happens for P-256, skip defensively
        }
        $parts = [];
        for ($i = 0; $i < 2; $i++) {
            if (($der[$p++] ?? '') !== "\x02") {
                throw new \RuntimeException('Firma DER non valida');
            }
            $l = ord($der[$p++]);
            $int = substr($der, $p, $l);
            $p += $l;
            $int = ltrim($int, "\0");
            if (strlen($int) > 32) {
                throw new \RuntimeException('Firma DER non valida');
            }
            $parts[] = str_pad($int, 32, "\0", STR_PAD_LEFT);
        }
        return $parts[0] . $parts[1];
    }

    /** raw 64-byte R||S -> ECDSA DER signature (for openssl_verify). */
    public static function rawToDer(string $raw): string
    {
        if (strlen($raw) !== 64) {
            throw new \InvalidArgumentException('Firma raw non valida');
        }
        $ints = '';
        foreach ([substr($raw, 0, 32), substr($raw, 32)] as $r) {
            $r = ltrim($r, "\0");
            if ($r === '' || ord($r[0]) & 0x80) {
                $r = "\0" . $r;
            }
            $ints .= "\x02" . chr(strlen($r)) . $r;
        }
        return "\x30" . chr(strlen($ints)) . $ints;
    }

    private static function pem(string $label, string $der): string
    {
        return "-----BEGIN $label-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END $label-----\n";
    }
}
