<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

/**
 * A GTFS feed as a set of named text files, read as streams — either a plain directory
 * (already extracted) or a zip read in place (ZipArchive, or the `unzip -p` binary when the
 * zip extension is missing). Nothing is ever extracted to disk, so the 410 MB of stop_times
 * only exist as a stream.
 */
final class FeedSource
{
    /** @var array<string,string> basename => path inside the zip */
    private array $zipEntries = [];
    private ?\ZipArchive $zip = null;
    /** @var array<int,bool> popen handles (closed with pclose) */
    private array $pipes = [];

    private function __construct(private string $path, private bool $isZip)
    {
    }

    public static function fromDir(string $dir): self
    {
        if (!is_dir($dir)) {
            throw new \RuntimeException("Cartella GTFS inesistente: $dir");
        }
        return new self(rtrim($dir, '/'), false);
    }

    public static function fromZip(string $zipPath): self
    {
        $self = new self($zipPath, true);
        if (class_exists(\ZipArchive::class)) {
            $zip = new \ZipArchive();
            $rc = $zip->open($zipPath);
            if ($rc !== true) {
                throw new \RuntimeException("Zip non valido ($rc): $zipPath");
            }
            $self->zip = $zip;
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = (string) $zip->getNameIndex($i);
                if (!str_ends_with($name, '/')) {
                    $self->zipEntries[basename($name)] = $name;
                }
            }
        } else {
            $out = [];
            exec('unzip -Z1 ' . escapeshellarg($zipPath) . ' 2>/dev/null', $out, $rc);
            if ($rc !== 0) {
                throw new \RuntimeException('Né ZipArchive né il comando unzip sono disponibili (o zip non valido)');
            }
            foreach ($out as $name) {
                if ($name !== '' && !str_ends_with($name, '/')) {
                    $self->zipEntries[basename($name)] = $name;
                }
            }
        }
        return $self;
    }

    public function has(string $file): bool
    {
        return $this->isZip ? isset($this->zipEntries[$file]) : is_file($this->path . '/' . $file);
    }

    /** @return resource|null null if the file is not part of the feed */
    public function open(string $file)
    {
        if (!$this->has($file)) {
            return null;
        }
        if (!$this->isZip) {
            $h = fopen($this->path . '/' . $file, 'rb');
            return $h === false ? null : $h;
        }
        $entry = $this->zipEntries[$file];
        if ($this->zip !== null) {
            $h = $this->zip->getStream($entry);
            return $h === false ? null : $h;
        }
        $h = popen('unzip -p ' . escapeshellarg($this->path) . ' ' . escapeshellarg($entry) . ' 2>/dev/null', 'r');
        if ($h === false) {
            return null;
        }
        $this->pipes[(int) $h] = true;
        return $h;
    }

    /** @param resource $handle */
    public function close($handle): void
    {
        if (isset($this->pipes[(int) $handle])) {
            unset($this->pipes[(int) $handle]);
            pclose($handle);
        } else {
            fclose($handle);
        }
    }

    public function __destruct()
    {
        $this->zip?->close();
    }
}
