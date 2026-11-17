<?php
declare(strict_types=1);

namespace Madovai\Gtfs;

/** Buffers rows and writes them with multi-row prepared INSERTs (far faster than 1 row per statement). */
final class BatchInsert
{
    private \PDOStatement $full;
    /** @var list<mixed> */
    private array $params = [];
    private int $rows = 0;
    private int $total = 0;
    private int $ncols;
    private string $head;

    /**
     * @param list<string> $columns
     * @param string $verb INSERT | INSERT OR REPLACE | INSERT OR IGNORE
     */
    public function __construct(private \PDO $db, private string $table, private array $columns, private int $perBatch = 150, string $verb = 'INSERT')
    {
        $this->ncols = count($columns);
        $this->perBatch = max(1, min($perBatch, intdiv(990, $this->ncols))); // old SQLite: max 999 bound variables
        $this->head = "$verb INTO $table (" . implode(',', $columns) . ') VALUES ';
        $this->full = $db->prepare($this->head . $this->placeholders($this->perBatch));
    }

    private function placeholders(int $n): string
    {
        $one = '(' . implode(',', array_fill(0, $this->ncols, '?')) . ')';
        return implode(',', array_fill(0, $n, $one));
    }

    /** @param list<mixed> $row values in column order */
    public function add(array $row): void
    {
        foreach ($row as $v) {
            $this->params[] = $v;
        }
        if (++$this->rows >= $this->perBatch) {
            $this->full->execute($this->params);
            $this->total += $this->rows;
            $this->params = [];
            $this->rows = 0;
        }
    }

    public function finish(): int
    {
        if ($this->rows > 0) {
            $this->db->prepare($this->head . $this->placeholders($this->rows))->execute($this->params);
            $this->total += $this->rows;
            $this->params = [];
            $this->rows = 0;
        }
        return $this->total;
    }
}
