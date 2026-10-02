<?php
// Router for the PHP built-in server (local development only):
//   php -S 127.0.0.1:8099 -t public public/router.php
// On Apache the endpoints are plain files (api/foo.php), nothing to route.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (preg_match('#^/api/([a-z0-9-]+)(\.php)?$#', $path, $m) && is_file(__DIR__ . "/api/{$m[1]}.php")) {
    require __DIR__ . "/api/{$m[1]}.php";
    return true;
}
return false; // static file (or 404)
