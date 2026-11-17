<?php
declare(strict_types=1);

/**
 * Minimal PSR-4 style autoloader: Madovai\Foo\Bar -> src/Foo/Bar.php.
 * No Composer needed (deliberate: the server only needs plain PHP).
 */
// Classes that live in a file named after a *different* class (the autoloader can't guess these).
const MADOVAI_CLASSMAP = [
    'Madovai\\HttpException' => 'Http.php',
    'Madovai\\BadRequest' => 'Json.php',
    'Madovai\\NotReady' => 'Json.php',
];

spl_autoload_register(static function (string $class): void {
    if (isset(MADOVAI_CLASSMAP[$class])) {
        require_once __DIR__ . '/' . MADOVAI_CLASSMAP[$class];
        return;
    }
    $prefix = 'Madovai\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $file = __DIR__ . '/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($file)) {
        require $file;
    }
});

date_default_timezone_set('Europe/Rome');
mb_internal_encoding('UTF-8');
