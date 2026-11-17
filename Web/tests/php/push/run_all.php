<?php
declare(strict_types=1);

// php tests/php/push/run_all.php — runs every test_*.php in this folder, exits non-zero on any failure.
$fail = 0;
foreach (glob(__DIR__ . '/test_*.php') as $t) {
    exec(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($t) . ' 2>&1', $out, $code);
    echo end($out), "\n";
    if ($code !== 0) {
        echo implode("\n", array_filter($out, fn($l) => str_contains($l, 'FAIL'))), "\n";
        $fail = 1;
    }
    $out = [];
}
exit($fail);
