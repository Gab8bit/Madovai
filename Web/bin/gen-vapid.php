<?php
declare(strict_types=1);

/**
 * Generates the VAPID key pair (data/vapid.json, chmod 600) used to sign Web Push requests.
 * Run once on the server. Re-generating invalidates every existing push subscription (use --force).
 *
 *   php bin/gen-vapid.php [--force]
 *
 * Set the contact URL/mailto in config.php ('vapid_subject' => 'mailto:you@example.com')
 * or MADOVAI_VAPID_SUBJECT.
 */
require __DIR__ . '/../src/bootstrap.php';

use Madovai\Push\Vapid;

try {
    $force = in_array('--force', $argv, true);
    $pub = Vapid::generate(null, $force);
    fwrite(STDOUT, "Chiavi VAPID create in " . Vapid::path() . "\nChiave pubblica: $pub\n");
    if (\Madovai\Config::get('vapid_subject') === null) {
        fwrite(STDERR, "Nota: imposta 'vapid_subject' (es. mailto:tu@dominio.it) in config.php.\n");
    }
} catch (\Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
