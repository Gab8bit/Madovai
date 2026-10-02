<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

use Madovai\Push\B64;
use Madovai\Push\Ec;
use Madovai\Push\Vapid;
use Madovai\Push\WebPush;

echo "RFC 8291 Appendix A vector\n";
$uaPublic = B64::dec('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
$asPublic = B64::dec('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
$asPrivate = B64::dec('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
$auth = B64::dec('BTBZMqHH6r4Tts7J_aSIgg');
$salt = B64::dec('DGv6ra1nlYgDCS1FRnbzlw');
$plain = 'When I grow up, I want to be a watermelon';
$expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    . 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    . 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
check(strlen((string) $uaPublic) === 65 && strlen((string) $asPublic) === 65, 'vector keys decode to 65 bytes');
$body = WebPush::encrypt($plain, $uaPublic, $auth, $salt, ['private' => $asPrivate, 'public' => $asPublic]);
same(144, strlen($body), 'body is 144 bytes (192 base64url chars; the RFC example header says 145, a known erratum)');
same($expected, B64::enc($body), 'ciphertext matches RFC 8291 section 5 byte-for-byte');

echo "base64url\n";
same('AQID', B64::enc("\x01\x02\x03"), 'enc');
same("\x01\x02", B64::dec('AQI'), 'dec unpadded');
same("\x01\x02", B64::dec('AQI='), 'dec padded');
same(null, B64::dec('AQ+/'), 'dec rejects std alphabet');
same(null, B64::dec('A'), 'dec rejects bad length');

echo "EC helpers\n";
$k = Ec::generate();
same(65, strlen($k['public']), 'generated public is 65 bytes');
same("\x04", $k['public'][0], 'uncompressed marker');
check(Ec::publicKey($k['public']) !== null, 'generated point accepted');
$bad = $k['public'];
$bad[64] = chr(ord($bad[64]) ^ 1);
check(Ec::publicKey($bad) === null, 'off-curve point rejected');
check(Ec::publicKey(str_repeat("\x04", 65)) === null, 'garbage point rejected');
// DER <-> raw round trip, including r/s with leading zero bytes and high bit
foreach ([str_repeat("\x01", 32) . str_repeat("\xff", 32), "\x00\x00" . str_repeat("\x7f", 30) . str_repeat("\x80", 32), str_repeat("\x00", 31) . "\x01" . str_repeat("\x00", 31) . "\x01"] as $raw) {
    same($raw, Ec::derToRaw(Ec::rawToDer($raw)), 'raw->DER->raw ' . bin2hex(substr($raw, 0, 3)));
}

echo "VAPID\n";
$path = $GLOBALS['__tmp'] ?? null;
$vfile = Madovai\Config::dataDir() . '/vapid.json';
$pub = Vapid::generate($vfile);
check(is_file($vfile), 'vapid.json created');
same('0600', substr(sprintf('%o', fileperms($vfile)), -4), 'vapid.json chmod 600');
same(65, strlen((string) B64::dec($pub)), 'public key is 65 bytes');
try {
    Vapid::generate($vfile);
    check(false, 'generate refuses to overwrite');
} catch (\RuntimeException $e) {
    check(true, 'generate refuses to overwrite');
}
$v = Vapid::load($vfile);
same($pub, $v->publicKey(), 'load returns same public key');
$endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def';
same('https://fcm.googleapis.com', Vapid::audience($endpoint), 'aud is origin');
same('https://push.example.net:8443', Vapid::audience('https://push.example.net:8443/x'), 'aud keeps port');
$now = 1_800_000_000;
$jwt = $v->jwt(Vapid::audience($endpoint), $now);
$parts = explode('.', $jwt);
same(3, count($parts), 'JWT has 3 parts');
same(['typ' => 'JWT', 'alg' => 'ES256'], json_decode((string) B64::dec($parts[0]), true), 'JWT header');
$claims = json_decode((string) B64::dec($parts[1]), true);
same('https://fcm.googleapis.com', $claims['aud'], 'JWT aud');
check($claims['exp'] - $now <= 12 * 3600 && $claims['exp'] > $now, 'JWT exp within 12h');
same(64, strlen((string) B64::dec($parts[2])), 'JWT signature is raw 64 bytes');
check(Vapid::verify($jwt, $pub), 'JWT verifies (DER round trip + openssl_verify)');
$tampered = $parts[0] . '.' . B64::enc(str_replace('fcm', 'evil', (string) B64::dec($parts[1]))) . '.' . $parts[2];
check(!Vapid::verify($tampered, $pub), 'tampered JWT fails verification');
$other = Ec::generate();
check(!Vapid::verify($jwt, B64::enc($other['public'])), 'JWT fails against another key');
$auth = $v->authorization($endpoint, $now);
check(preg_match('/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=' . preg_quote($pub, '/') . '$/', $auth) === 1, 'Authorization header format');

echo "Request assembly\n";
$recv = Ec::generate();
$sub = ['endpoint' => $endpoint, 'keys' => ['p256dh' => B64::enc($recv['public']), 'auth' => B64::enc(random_bytes(16))]];
$req = WebPush::buildRequest($sub, '{"title":"x"}', $v);
check(in_array('Content-Encoding: aes128gcm', $req['headers'], true), 'Content-Encoding header');
check(in_array('TTL: 600', $req['headers'], true), 'TTL header');
check(in_array('Urgency: high', $req['headers'], true), 'Urgency header');
check(in_array('Content-Type: application/octet-stream', $req['headers'], true), 'Content-Type header');
same(86 + strlen('{"title":"x"}') + 1 + 16, strlen($req['body']), 'body = 86 header + payload + delimiter + tag');
same(4096, unpack('N', substr($req['body'], 16, 4))[1], 'record size 4096');
same(65, ord($req['body'][20]), 'idlen 65');
try {
    WebPush::encrypt(str_repeat('a', 4100), $recv['public'], str_repeat("\0", 16));
    check(false, 'oversized payload rejected');
} catch (\InvalidArgumentException $e) {
    check(true, 'oversized payload rejected');
}

// ---- Independent cross-check: decrypt with Node (written from RFC 8291) ----
echo "Node cross-decrypt\n";
$node = trim((string) shell_exec('command -v node'));
if ($node === '') {
    echo "  skip node not installed\n";
} else {
    $receiver = Ec::generate();
    $authSecret = random_bytes(16);
    $payload = json_encode(['title' => 'Prossimo bus alle 07:45', 'body' => "Il prossimo bus per Città è in ritardo di 3 minuti.", 'tag' => 'x', 'url' => './#/promemoria'], JSON_UNESCAPED_UNICODE);
    foreach ([$payload, 'a', str_repeat('é', 1500)] as $i => $msg) {
        $body = WebPush::encrypt($msg, $receiver['public'], $authSecret);
        $in = json_encode(['body' => B64::enc($body), 'uaPrivate' => B64::enc($receiver['private']), 'uaPublic' => B64::enc($receiver['public']), 'auth' => B64::enc($authSecret)]);
        $proc = proc_open([$node, __DIR__ . '/node-decrypt.js'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        fwrite($pipes[0], $in);
        fclose($pipes[0]);
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        proc_close($proc);
        same($msg, (string) B64::dec(trim($out)) ?: $out, "node decrypts PHP message #$i (" . strlen($msg) . ' bytes)');
        if ($err !== '') {
            echo "       node stderr: $err\n";
        }
    }
    // and the RFC vector must also decrypt in node with the RFC's receiver key
    $in = json_encode(['body' => $expected, 'uaPrivate' => 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94', 'uaPublic' => 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'auth' => 'BTBZMqHH6r4Tts7J_aSIgg']);
    $proc = proc_open([$node, __DIR__ . '/node-decrypt.js'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    fwrite($pipes[0], $in);
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    stream_get_contents($pipes[2]);
    proc_close($proc);
    same($plain, (string) B64::dec(trim($out)), 'node decrypts the RFC example');
}

done('test_webpush');
