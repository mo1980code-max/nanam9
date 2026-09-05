<?php

declare(strict_types=1);

namespace Nawras\Db;

use PDO;
use PDOException;
use RuntimeException;

/**
 * Thin PDO wrapper. One connection, two dialects.
 *
 * Why not an ORM: buyers install this on shared hosts where the only guaranteed
 * extension is pdo_mysql; every query here is reviewable by the license auditor's
 * tooling and by any competent freelancer the buyer hires later.
 */
final class Connection
{
    private PDO $pdo;

    private string $driver;

    public function __construct(array $config)
    {
        $driver = (string) ($config['driver'] ?? 'mysql');
        if (!\in_array($driver, ['mysql', 'sqlite'], true)) {
            throw new RuntimeException("Unsupported db driver '{$driver}'.");
        }
        $this->driver = $driver;

        try {
            if ($driver === 'sqlite') {
                $path = (string) ($config['sqlite_path'] ?? (ARCADE_ROOT . '/var/arcade.sqlite'));
                $dir = \dirname($path);
                if (!\is_dir($dir)) {
                    @\mkdir($dir, 0775, true);
                }
                $this->pdo = new PDO('sqlite:' . $path);
                $this->pdo->exec('PRAGMA foreign_keys = ON');
                $this->pdo->exec('PRAGMA journal_mode = WAL');
            } else {
                $dsn = \sprintf(
                    'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                    (string) ($config['host'] ?? '127.0.0.1'),
                    (int) ($config['port'] ?? 3306),
                    (string) ($config['database'] ?? 'arcade')
                );
                $this->pdo = new PDO($dsn, (string) ($config['username'] ?? ''), (string) ($config['password'] ?? ''));
            }
        } catch (PDOException $e) {
            throw new RuntimeException('Database connection failed: ' . $e->getMessage(), 0, $e);
        }

        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    /** 'mysql' | 'sqlite' */
    public function driver(): string
    {
        return $this->driver;
    }

    /** Runs a statement, returns affected row count. */
    public function run(string $sql, array $params = []): int
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);

        return $stmt->rowCount();
    }

    /** Fetches all rows as assoc arrays. */
    public function all(string $sql, array $params = []): array
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);

        return $stmt->fetchAll() ?: [];
    }

    /** Fetches the first row or null. */
    public function one(string $sql, array $params = []): ?array
    {
        $rows = $this->all($sql, $params);

        return $rows[0] ?? null;
    }

    /** Fetches a scalar (first column of first row) or null. */
    public function scalar(string $sql, array $params = []): mixed
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        $value = $stmt->fetchColumn();

        return $value === false ? null : $value;
    }

    /**
     * Runs $fn inside a transaction. SQLite here is single-writer (WAL), MySQL buyers
     * on shared hosts rarely have InnoDB concurrency to spare — keep transactions short.
     *
     * @template T
     *
     * @param callable():T $fn
     *
     * @return T
     */
    public function transactional(callable $fn): mixed
    {
        $this->pdo->beginTransaction();
        try {
            $result = $fn($this);
            $this->pdo->commit();

            return $result;
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }
}
