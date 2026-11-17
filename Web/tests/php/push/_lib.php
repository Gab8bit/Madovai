<?php
declare(strict_types=1);

// Tiny assertion harness (no PHPUnit). Each test file requires this, runs checks, calls done().
// Uses an isolated temp data dir so the repo's data/ is never touched.
$__tmp = sys_get_temp_dir() . '/madovai-push-test-' . getmypid() . '-' . bin2hex(random_bytes(3));
mkdir($__tmp, 0775, true);
putenv('MADOVAI_DATA_DIR=' . $__tmp);
register_shutdown_function(static function () use ($__tmp): void {
    foreach (glob($__tmp . '/*') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($__tmp);
});

require __DIR__ . '/../../../src/bootstrap.php';

$GLOBALS['__pass'] = 0;
$GLOBALS['__fail'] = 0;

function check(bool $cond, string $name): void
{
    if ($cond) {
        $GLOBALS['__pass']++;
        echo "  ok   $name\n";
    } else {
        $GLOBALS['__fail']++;
        echo "  FAIL $name\n";
    }
}

function same($expected, $actual, string $name): void
{
    $ok = $expected === $actual;
    check($ok, $name);
    if (!$ok) {
        echo '       expected: ' . var_export($expected, true) . "\n       actual:   " . var_export($actual, true) . "\n";
    }
}

function throwsBadRequest(callable $f, string $name): void
{
    try {
        $f();
        check(false, $name . ' (nessuna eccezione)');
    } catch (\Madovai\BadRequest $e) {
        check(true, $name);
    }
}

function done(string $title): never
{
    echo "$title: {$GLOBALS['__pass']} ok, {$GLOBALS['__fail']} failed\n";
    exit($GLOBALS['__fail'] > 0 ? 1 : 0);
}

function rome(string $s): \DateTimeImmutable
{
    return new \DateTimeImmutable($s, \Madovai\Rome::tz());
}
