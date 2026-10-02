<?php
declare(strict_types=1);

namespace Madovai\Push;

/** base64url (RFC 4648 §5, no padding) helpers. */
final class B64
{
    public static function enc(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    /** Strict decode: only the url-safe alphabet, optional "=" padding; null when malformed. */
    public static function dec(string $s): ?string
    {
        if ($s === '' || !preg_match('/^[A-Za-z0-9_-]+={0,2}$/', $s)) {
            return null;
        }
        $s = rtrim($s, '=');
        if (strlen($s) % 4 === 1) {
            return null;
        }
        $bin = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        return $bin === false ? null : $bin;
    }
}
