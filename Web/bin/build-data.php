#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Builds data/madovai.sqlite (static GTFS: Cotral bus + rail, Rome/Atac).
 * Run from cron once a day (the feeds change at most daily):
 *
 *   php bin/build-data.php
 *
 * Options:
 *   --data-dir=DIR     where to write madovai.sqlite (default: MADOVAI_DATA_DIR or <root>/data)
 *   --from-dir=DIR     use already extracted feeds in DIR/bus, DIR/rail, DIR/atac (no download)
 *   --from-zips=DIR    use DIR/cotral_bus.zip, DIR/cotral_rail.zip, DIR/atac.zip (no download)
 *   --quiet            no progress output
 *
 * The new DB is built in a temp file next to the final one and moved into place atomically,
 * so a failed build never breaks the running site. Needs ~300 MB RAM (stop_times are streamed),
 * a few hundred MB of free disk, and only pdo_sqlite + curl (+ zip, or the `unzip` binary).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

ini_set('memory_limit', '512M');
set_time_limit(0);

$opts = getopt('', ['data-dir:', 'from-dir:', 'from-zips:', 'quiet', 'help']);
if (isset($opts['help'])) {
    echo "Uso: php bin/build-data.php [--data-dir=DIR] [--from-dir=DIR | --from-zips=DIR] [--quiet]\n";
    exit(0);
}
if (!empty($opts['data-dir'])) {
    putenv('MADOVAI_DATA_DIR=' . $opts['data-dir']);
}

require __DIR__ . '/../src/bootstrap.php';

use Madovai\Config;
use Madovai\Gtfs\Builder;
use Madovai\Gtfs\FeedSource;
use Madovai\Http;

$quiet = isset($opts['quiet']);
$say = static function (string $m) use ($quiet): void {
    if (!$quiet) {
        fwrite(STDERR, $m . "\n");
    }
};

$dataDir = Config::dataDir();
$final = $dataDir . '/madovai.sqlite';

// One build at a time.
$lock = fopen($dataDir . '/build.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "Un'altra build è già in corso.\n");
    exit(1);
}

$tmpDir = null;
$exit = 0;
try {
    $info = [];
    if (!empty($opts['from-dir'])) {
        $dir = rtrim((string) $opts['from-dir'], '/');
        $feeds = [
            'bus' => FeedSource::fromDir("$dir/bus"),
            'rail' => FeedSource::fromDir("$dir/rail"),
            'atac' => FeedSource::fromDir("$dir/atac"),
        ];
        $info['source'] = "dir:$dir";
    } else {
        $zips = [];
        if (!empty($opts['from-zips'])) {
            $d = rtrim((string) $opts['from-zips'], '/');
            $zips = ['bus' => "$d/cotral_bus.zip", 'rail' => "$d/cotral_rail.zip", 'atac' => "$d/atac.zip"];
            $info['source'] = "zips:$d";
        } else {
            $tmpDir = $dataDir . '/build-tmp-' . getmypid();
            if (!mkdir($tmpDir, 0775, true) && !is_dir($tmpDir)) {
                throw new RuntimeException("Impossibile creare $tmpDir");
            }
            $urls = [
                'bus' => Config::GTFS_BUS_ZIP_URL,
                'rail' => Config::GTFS_RAIL_ZIP_URL,
                'atac' => Config::ATAC_GTFS_ZIP_URL,
            ];
            foreach ($urls as $k => $url) {
                $dest = "$tmpDir/$k.zip";
                $say("download $k: $url");
                $t = microtime(true);
                $attempt = 0;
                while (true) {
                    try {
                        Http::download($url, $dest);
                        break;
                    } catch (Throwable $e) {
                        if (++$attempt >= 3) {
                            throw $e;
                        }
                        $say("  tentativo $attempt fallito: " . $e->getMessage());
                        sleep(5);
                    }
                }
                $say(sprintf('  %.1f MB in %.1fs', filesize($dest) / 1048576, microtime(true) - $t));
                $zips[$k] = $dest;
                $info["url_$k"] = $url;
            }
        }
        $feeds = [];
        foreach ($zips as $k => $path) {
            $feeds[$k] = FeedSource::fromZip($path);
        }
    }

    $stats = (new Builder($dataDir, $quiet ? static function (string $m): void {} : null))->build($feeds, $final, $info);
    $say('');
    $say('OK ' . $final);
    foreach ($stats as $k => $v) {
        $say(sprintf('  %-22s %s', $k, is_int($v) && str_ends_with($k, '_bytes') ? number_format($v / 1048576, 1) . ' MB' : $v));
    }
} catch (Throwable $e) {
    fwrite(STDERR, 'ERRORE: ' . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n");
    $exit = 1;
} finally {
    unset($feeds); // release zip handles before deleting the temp dir
    if ($tmpDir !== null && is_dir($tmpDir)) {
        foreach (glob($tmpDir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($tmpDir);
    }
    flock($lock, LOCK_UN);
}
exit($exit);
