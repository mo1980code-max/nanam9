<?php

declare(strict_types=1);

namespace Nawras\Db;

use RuntimeException;

/**
 * Makes an installed copy upgradable instead of reinstallable.
 *
 * The old Migrator only created missing tables — it never ran ALTER, so any column added
 * after a buyer's install silently never existed for them. This Migrator versions the schema:
 *
 *   - fresh database  -> executes db/schema.<driver>.sql, stamps the highest version;
 *   - existing copy   -> applies pending steps from db/migrations.json in order, stamping each.
 *
 * Every ALTER/UPDATE step is idempotent by design (duplicate column/key errors are tolerated,
 * see IGNORABLE) so a step that half-applied before a crash can safely re-run.
 */
final class Migrator
{
    public const CURRENT = 3;

    /** MySQL server error codes that mean "already applied" for one statement. */
    private const IGNORABLE_MYSQL = [1060, 1061, 1091];

    /** SQLite driver message fragments with the same meaning. */
    private const IGNORABLE_SQLITE = [
        'duplicate column name', 'already exists', 'no such index', 'no such column', 'no such table',
    ];

    public function __construct(private readonly Connection $db)
    {
    }

    /**
     * Brings the database to Migrator::CURRENT.
     *
     * @return list<string> human-readable log lines (what ran, what was already there)
     */
    public function migrate(): array
    {
        $log = [];
        $driver = $this->db->driver();

        if ($this->isFresh()) {
            $file = ARCADE_ROOT . '/db/schema.' . $driver . '.sql';
            if (!\is_file($file)) {
                throw new RuntimeException("No schema for driver '{$driver}' (expected {$file}).");
            }
            foreach ($this->statements((string) \file_get_contents($file)) as $statement) {
                $this->db->pdo()->exec($statement);
            }
            $this->stamp(self::CURRENT, 'baseline (full DDL)');
            $log[] = "installed baseline schema v" . self::CURRENT . " ({$driver})";

            return $log;
        }

        $from = $this->version();
        if ($from >= self::CURRENT) {
            $log[] = "schema already at v{$from}, nothing to do";

            return $log;
        }

        $steps = $this->steps();
        foreach ($steps as $version => $step) {
            if ($version <= $from) {
                continue;
            }
            foreach ($step['statements'] as $statement) {
                $this->apply($statement);
            }
            $this->stamp($version, (string) $step['note']);
            $log[] = "applied migration v{$version}: " . (string) $step['note']
                . ' (' . \count($step['statements']) . ' statements)';
        }

        return $log;
    }

    /** Highest applied version, 0 when the version table does not exist yet. */
    public function version(): int
    {
        if (\strtolower($this->db->driver()) === 'mysql') {
            $exists = $this->db->one('SHOW TABLES LIKE ?', ['schema_version']);
        } else {
            $exists = $this->db->one(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'"
            );
        }
        if ($exists === null) {
            return 0;
        }

        return (int) ($this->db->scalar('SELECT COALESCE(MAX(version), 0) FROM schema_version') ?? 0);
    }

    public function isFresh(): bool
    {
        return $this->tables() === [];
    }

    /** @return list<string> lowercase table names */
    public function tables(): array
    {
        if ($this->db->driver() === 'mysql') {
            $rows = $this->db->all('SHOW TABLES');
        } else {
            $rows = $this->db->all("SELECT name FROM sqlite_master WHERE type = 'table'");
        }
        $out = [];
        foreach ($rows as $row) {
            $first = \array_values($row)[0] ?? null;
            if (\is_string($first)) {
                $out[] = \strtolower($first);
            }
        }

        return $out;
    }

    /**
     * @return array<int, array{note: string, statements: list<string>}>
     */
    private function steps(): array
    {
        $file = ARCADE_ROOT . '/db/migrations.json';
        if (!\is_file($file)) {
            return [];
        }
        $raw = \json_decode((string) \file_get_contents($file), true);
        if (!\is_array($raw)) {
            throw new RuntimeException('db/migrations.json is not valid JSON.');
        }
        $driver = $this->db->driver();
        $steps = [];
        foreach ($raw as $key => $step) {
            if (!\ctype_digit((string) $key) || !\is_array($step) || isset($step['_note'])) {
                continue; // "_note" and friends
            }
            $statements = $step[$driver] ?? null;
            if (!\is_array($statements)) {
                throw new RuntimeException("Migration v{$key} has no '{$driver}' statement list.");
            }
            $steps[(int) $key] = [
                'note' => (string) ($step['note'] ?? ''),
                'statements' => \array_values(\array_map(static fn ($s): string => (string) $s, $statements)),
            ];
        }
        \ksort($steps);

        return $steps;
    }

    /**
     * One statement, tolerating "already applied" errors so re-runs converge.
     */
    private function apply(string $statement): void
    {
        try {
            $this->db->pdo()->exec($statement);
        } catch (\PDOException $e) {
            if (!$this->isIgnorable($e)) {
                throw $e;
            }
        }
    }

    private function isIgnorable(\PDOException $e): bool
    {
        if ($this->db->driver() === 'mysql') {
            $info = $e->errorInfo ?? [];
            $code = (int) ($info[1] ?? 0);

            return \in_array($code, self::IGNORABLE_MYSQL, true);
        }
        $message = \strtolower($e->getMessage());
        foreach (self::IGNORABLE_SQLITE as $fragment) {
            if (\str_contains($message, $fragment)) {
                return true;
            }
        }

        return false;
    }

    private function stamp(int $version, string $note): void
    {
        $this->apply('CREATE TABLE IF NOT EXISTS ' . $this->versionTableDdl());
        $this->db->run(
            'INSERT INTO schema_version (version, note, applied_at) VALUES (?, ?, ?)'
            . $this->onConflictIgnore(),
            [$version, $note, \date('Y-m-d H:i:s')]
        );
    }

    private function versionTableDdl(): string
    {
        return $this->db->driver() === 'mysql'
            ? '`schema_version` (`id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, '
                . '`version` INT NOT NULL, `note` VARCHAR(190) NOT NULL DEFAULT \'\', '
                . '`applied_at` DATETIME NOT NULL, UNIQUE KEY `uq_schema_version_version` (`version`)) '
                . 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
            : '"schema_version" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "version" INTEGER NOT NULL, '
                . '"note" TEXT NOT NULL DEFAULT \'\', "applied_at" TEXT NOT NULL)';
    }

    private function onConflictIgnore(): string
    {
        return $this->db->driver() === 'mysql'
            ? ' ON DUPLICATE KEY UPDATE `note` = VALUES(`note`)'
            : ' ON CONFLICT("version") DO UPDATE SET "note" = excluded."note"';
    }

    /**
     * Splits a .sql dump into single statements, respecting quoted strings and comments.
     *
     * @return list<string>
     */
    private function statements(string $sql): array
    {
        $out = [];
        $buffer = '';
        $inSingle = false;
        $len = \strlen($sql);
        for ($i = 0; $i < $len; $i++) {
            $char = $sql[$i];
            if ($char === "'" ) {
                $inSingle = !$inSingle;
                $buffer .= $char;
                continue;
            }
            if (!$inSingle && $char === ';') {
                $trimmed = \trim($buffer);
                if ($trimmed !== '') {
                    $out[] = $trimmed;
                }
                $buffer = '';
                continue;
            }
            if (!$inSingle && $char === '-' && $i + 1 < $len && $sql[$i + 1] === '-') {
                while ($i < $len && $sql[$i] !== "\n") {
                    $i++;
                }
                continue;
            }
            $buffer .= $char;
        }
        $trimmed = \trim($buffer);
        if ($trimmed !== '') {
            $out[] = $trimmed;
        }

        return $out;
    }
}
