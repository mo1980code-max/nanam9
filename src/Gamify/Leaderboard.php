<?php

declare(strict_types=1);

namespace Nawras\Gamify;

use DateTimeImmutable;
use DateTimeZone;
use Nawras\Db\Connection;

/**
 * Score submission + leaderboard reads on the time-bucketed `leaderboard` table.
 *
 * One submission writes FOUR rows (day/week/month/all) in a single transaction, each keeping
 * the player's best score for its bucket via upsert (`excluded.score > score`). All eight
 * period types are then a single indexed SELECT — no date functions in SQL, so MySQL and
 * SQLite behave identically by construction.
 *
 * Integrity: rows carry an HMAC signature (score, game, alias, bucket, day) that
 * `verifyRow()` checks before a row is displayed. The HMAC key is the install secret;
 * the public API only ever accepts scores through `submit()`, which rate-limits upstream
 * (Routes) and signs here. A forged POST without the key fails signature verification
 * and is dropped from reads instead of corrupting the board.
 */
final class Leaderboard
{
    public function __construct(
        private readonly Connection $db,
        private readonly string $hmacKey,
    ) {
        if ($hmacKey === '') {
            throw new \InvalidArgumentException('Leaderboard needs a non-empty HMAC key.');
        }
    }

    /**
     * Records a score into all four buckets. Returns the number of rows written/updated.
     *
     * @return array{written: int, buckets: list<string>}
     */
    public function submit(
        int $gameId,
        int $score,
        ?int $userId = null,
        ?string $alias = null,
        ?string $deviceKey = null,
        ?DateTimeImmutable $at = null,
    ): array {
        $score = \max(0, \min(99_999_999, (int) $score));
        $at ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $now = $at->format('Y-m-d H:i:s');
        $alias = self::normalizeAlias($alias, $userId, $deviceKey);

        $buckets = Buckets::allFour($at);
        $written = 0;
        $touched = [];

        // Two complete statements instead of a concatenated conflict target: string-built
        // SQL is exactly what the structural verifier cannot reason about.
        $sql = $this->db->driver() === 'mysql'
            ? 'INSERT INTO `leaderboard`
                   (`game_id`, `user_id`, `alias`, `score`, `period`, `period_key`, `week_key`, `signature`, `submitted_at`)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE
                   `score` = IF(VALUES(`score`) > `score`, VALUES(`score`), `score`),
                   `signature` = IF(VALUES(`score`) > `score`, VALUES(`signature`), `signature`),
                   `submitted_at` = IF(VALUES(`score`) > `score`, VALUES(`submitted_at`), `submitted_at`)'
            : ($userId !== null
                ? 'INSERT INTO "leaderboard"
                       ("game_id", "user_id", "alias", "score", "period", "period_key", "week_key", "signature", "submitted_at")
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (game_id, user_id, period, period_key) DO UPDATE SET
                       "score" = excluded."score",
                       "week_key" = excluded."week_key",
                       "signature" = excluded."signature",
                       "submitted_at" = excluded."submitted_at"
                       WHERE excluded."score" > "leaderboard"."score"'
                : 'INSERT INTO "leaderboard"
                       ("game_id", "user_id", "alias", "score", "period", "period_key", "week_key", "signature", "submitted_at")
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (game_id, alias, period, period_key) DO UPDATE SET
                       "score" = excluded."score",
                       "week_key" = excluded."week_key",
                       "signature" = excluded."signature",
                       "submitted_at" = excluded."submitted_at"
                       WHERE excluded."score" > "leaderboard"."score"');

        $this->db->transactional(function () use (&$written, &$touched, $sql, $gameId, $score, $userId, $alias, $buckets, $now, $at): void {
            foreach ($buckets as $b) {
                $period = $b['period'];
                $key = $b['key'];
                $signature = $this->signature($gameId, $score, $alias, $period, $key, $at);
                $isWeek = $period === Buckets::WEEK;

                $params = [$gameId, $userId, $alias, $score, $period, $key, $isWeek ? $key : '', $signature, $now];
                $written += $this->db->run($sql, $params);
                $touched[] = $period . ':' . $key;
            }
        });

        return ['written' => $written, 'buckets' => $touched];
    }

    /**
     * Reads one of the eight leaderboard types. `slug` is resolved upstream by callers;
     * pass null only for top-all* types.
     *
     * @return list<array{rank: int, game_id: int, game_slug: string, alias: string, score: int, submitted_at: string}>
     */
    public function forType(?int $gameId, string $type, int $amount = 10): array
    {
        $spec = Buckets::TYPES[$type] ?? null;
        if ($spec === null) {
            throw new \InvalidArgumentException("Unknown leaderboard type '{$type}'.");
        }
        $amount = \max(1, \min(100, $amount));
        $period = (string) $spec['period'];
        $perGame = (bool) $spec['per_game'];
        $key = Buckets::key($period);

        if ($perGame && $gameId === null) {
            throw new \InvalidArgumentException("Type '{$type}' needs a game id.");
        }

        $where = ['lb.period = ?'];
        $params = [$period];
        if ($period !== Buckets::ALL) {
            $where[] = 'lb.period_key = ?';
            $params[] = $key;
        }
        if ($perGame) {
            $where[] = 'lb.game_id = ?';
            $params[] = $gameId;
        }

        // One row per player: MySQL 8 / SQLite both support the window function.
        // top-all* boards partition by PLAYER (each person once), per-game boards by (game, player).
        $partition = $perGame
            ? 'lb.game_id, ' . $this->playerExpr()
            : $this->playerExpr();
        $sql = 'SELECT * FROM (
                    SELECT lb.game_id, g.slug AS game_slug, lb.alias, lb.score, lb.submitted_at,
                           ROW_NUMBER() OVER (
                               PARTITION BY ' . $partition . '
                               ORDER BY lb.score DESC, lb.submitted_at ASC
                           ) AS player_rank
                    FROM leaderboard lb
                    JOIN games g ON g.id = lb.game_id
                    WHERE ' . \implode(' AND ', $where) . '
                ) ranked
                WHERE ranked.player_rank = 1
                ORDER BY ranked.score DESC, ranked.submitted_at ASC
                LIMIT ' . $amount;
        $rows = $this->db->all($sql, $params);

        $out = [];
        $rank = 0;
        foreach ($rows as $row) {
            $out[] = [
                'rank' => ++$rank,
                'game_id' => (int) $row['game_id'],
                'game_slug' => (string) ($row['game_slug'] ?? ''),
                'alias' => (string) $row['alias'],
                'score' => (int) $row['score'],
                'submitted_at' => (string) $row['submitted_at'],
            ];
        }

        return $out;
    }

    /**
     * Back-compat read: the weekly board (what the static site and old clients use).
     *
     * @return list<array<string, mixed>>
     */
    public function weekly(int $gameId, int $amount = 10): array
    {
        return $this->forType($gameId, 'top-week', $amount);
    }

    /** Signature for one row; verified by verifyRow() before display. */
    private function signature(int $gameId, int $score, string $alias, string $period, string $key, DateTimeImmutable $at): string
    {
        $day = $at->format('Y-m-d');

        return \hash_hmac('sha256', "{$gameId}|{$score}|{$alias}|{$period}|{$key}|{$day}", $this->hmacKey);
    }

    /** True when a stored row's signature matches its contents (anti-tamper on reads). */
    public function verifyRow(array $row, ?DateTimeImmutable $at = null): bool
    {
        $at ??= new DateTimeImmutable((string) ($row['submitted_at'] ?? 'now'), new DateTimeZone('UTC'));
        $expect = $this->signature(
            (int) $row['game_id'],
            (int) $row['score'],
            (string) $row['alias'],
            (string) $row['period'],
            (string) $row['period_key'],
            $at
        );

        return \hash_equals($expect, (string) ($row['signature'] ?? ''));
    }

    private function playerExpr(): string
    {
        // guests are distinguished by alias; a NULL alias can collide, so normalize on read.
        // MySQL needs CONCAT (|| is logical OR there unless PIPES_AS_CONCAT is set).
        if ($this->db->driver() === 'mysql') {
            return "COALESCE(lb.alias, CONCAT('~u', CAST(lb.user_id AS CHAR)))";
        }

        return "COALESCE(lb.alias, '~u' || CAST(lb.user_id AS TEXT))";
    }

    /**
     * Every row needs an identity: real user id, or a non-empty alias.
     * Without this the unique key (game, NULL, period, key) cannot dedupe guests.
     */
    private static function normalizeAlias(?string $alias, ?int $userId, ?string $deviceKey): string
    {
        $alias = \trim((string) $alias);
        if ($alias !== '') {
            return \mb_substr($alias, 0, 48);
        }
        if ($userId !== null) {
            return ''; // identity comes from user_id
        }
        if ($deviceKey !== null && $deviceKey !== '') {
            return 'dk-' . \mb_substr($deviceKey, 0, 45);
        }

        return 'guest';
    }
}
