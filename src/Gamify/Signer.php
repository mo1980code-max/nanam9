<?php

declare(strict_types=1);

namespace Nawras\Gamify;

use DateTimeImmutable;
use DateTimeZone;

/**
 * Page tokens for score submission.
 *
 * The client never sees the HMAC secret, so it cannot sign an arbitrary payload. Instead,
 * when the server renders a game page it embeds a token: {ts, nonce, sig} where
 * sig = HMAC_SHA256(secret, game|ts|nonce). POST /api/score must carry that token and a
 * fresh ts; the score value itself is trusted within the rate limit — this is the honest
 * ceiling of every client-side arcade (including the commercial ones), and the server-side
 * row signature + audit ledger catch the tampering that matters (cross-game rows, replays
 * across installs).
 */
final class Signer
{
    private const WINDOW = 600; // seconds a token stays valid

    public function __construct(private readonly string $secret)
    {
        if ($secret === '') {
            throw new \InvalidArgumentException('Signer needs a non-empty secret.');
        }
    }

    /** Token embedded into a game page's markup. */
    public function pageToken(string $gameSlug, ?DateTimeImmutable $at = null): array
    {
        $at ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $ts = (string) $at->getTimestamp();
        $nonce = \bin2hex(\random_bytes(8));

        return [
            'ts' => $ts,
            'nonce' => $nonce,
            'sig' => $this->sig($gameSlug, $ts, $nonce),
        ];
    }

    /** Server-side check of a submitted token. */
    public function check(string $gameSlug, string $ts, string $nonce, string $sig): bool
    {
        if ($sig === '' || $ts === '' || $nonce === '') {
            return false;
        }
        $now = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->getTimestamp();
        if (\abs($now - (int) $ts) > self::WINDOW) {
            return false;
        }

        return \hash_equals($this->sig($gameSlug, $ts, $nonce), $sig);
    }

    private function sig(string $gameSlug, string $ts, string $nonce): string
    {
        return \hash_hmac('sha256', $gameSlug . '|' . $ts . '|' . $nonce, $this->secret);
    }
}
