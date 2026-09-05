<?php

declare(strict_types=1);

namespace Nawras\Gamify;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Time-bucket math lives here and ONLY here.
 *
 * The leaderboard answers eight period types (a CloudArcade-compatible contract):
 *
 *   top          -> bucket all,   filtered by game
 *   top-day      -> bucket day,   filtered by game
 *   top-week     -> bucket week,  filtered by game
 *   top-month    -> bucket month, filtered by game
 *   top-all      -> bucket all,   across games
 *   top-all-day  -> bucket day,   across games
 *   top-all-week -> bucket week,  across games
 *   top-all-month-> bucket month, across games
 *
 * Period keys are computed in PHP from one clock (UTC) and written into the row, so a read
 * is a plain indexed WHERE and no dialect-specific date SQL ever enters a query. MySQL's
 * DATE() vs SQLite's strftime() divergence is exactly the kind of "works on my machine"
 * this project refuses to ship.
 */
final class Buckets
{
    public const ALL = 'all';
    public const DAY = 'day';
    public const WEEK = 'week';
    public const MONTH = 'month';

    public const PERIODS = [self::DAY, self::WEEK, self::MONTH, self::ALL];

    public const TYPES = [
        'top' => ['period' => self::ALL, 'per_game' => true],
        'top-day' => ['period' => self::DAY, 'per_game' => true],
        'top-week' => ['period' => self::WEEK, 'per_game' => true],
        'top-month' => ['period' => self::MONTH, 'per_game' => true],
        'top-all' => ['period' => self::ALL, 'per_game' => false],
        'top-all-day' => ['period' => self::DAY, 'per_game' => false],
        'top-all-week' => ['period' => self::WEEK, 'per_game' => false],
        'top-all-month' => ['period' => self::MONTH, 'per_game' => false],
    ];

    public static function isValidPeriod(string $period): bool
    {
        return \in_array($period, self::PERIODS, true);
    }

    /** True for 'top', 'top-day', ... / false for 'top-all*'. Null for unknown types. */
    public static function isPerGame(string $type): ?bool
    {
        return self::TYPES[$type]['per_game'] ?? null;
    }

    /**
     * The bucket key a score submitted at $at falls into.
     *
     * day   -> '2026-09-05'
     * week  -> '2026-W36'  (ISO week, Monday-based)
     * month -> '2026-09'
     * all   -> 'all'
     */
    public static function key(string $period, ?DateTimeImmutable $at = null): string
    {
        $at ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        return match ($period) {
            self::DAY => $at->format('Y-m-d'),
            self::WEEK => $at->format('o') . '-W' . $at->format('W'),
            self::MONTH => $at->format('Y-m'),
            default => self::ALL,
        };
    }

    /**
     * All four (period, key) pairs for one submission, in a fixed order.
     *
     * @return array<array{period: string, key: string}>
     */
    public static function allFour(?DateTimeImmutable $at = null): array
    {
        $out = [];
        foreach (self::PERIODS as $period) {
            $out[] = ['period' => $period, 'key' => self::key($period, $at)];
        }

        return $out;
    }
}
