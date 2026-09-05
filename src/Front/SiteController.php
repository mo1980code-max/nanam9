<?php

declare(strict_types=1);

namespace Nawras\Front;

use DateTimeImmutable;
use DateTimeZone;
use Nawras\Db\Connection;
use Nawras\Gamify\Buckets;
use Nawras\Gamify\Leaderboard;
use Nawras\Gamify\Signer;
use Nawras\Http\Response;
use Nawras\Licensing\LicenseAuditor;
use Nawras\Licensing\LicensePolicy;

/**
 * Public, accountless endpoints. Score integrity model:
 *
 *   1. The server renders each game page with an HMAC page token (Gamify\Signer) —
 *      the secret never leaves the server.
 *   2. `POST /api/score` accepts {game, alias?, score, ts, nonce, sig}; sig covers
 *      game|ts|nonce. The score value is client-chosen and rate-limited — the honest
 *      ceiling of every client-side arcade, commercial ones included.
 *   3. Stored rows carry a server-side HMAC over their contents; reads re-verify.
 *
 * Every endpoint that touches a game passes the licence gate first: a game with no usable row in
 * `game_licenses` is refused with 451 (Unavailable For Legal Reasons) instead of being served.
 */
final class SiteController
{
    private const SCORE_TYPES = ['top', 'top-day', 'top-week', 'top-month', 'top-all', 'top-all-day', 'top-all-week', 'top-all-month'];

    public function __construct(
        private readonly Connection $db,
        private readonly Leaderboard $board,
        private readonly Signer $signer,
        private readonly LicenseAuditor $licenses,
        private readonly bool $commercial = true,
    ) {
    }

    /** GET /api/leaderboard?game=slug|id&type=top-week&amount=10 */
    public function leaderboard(): Response
    {
        $type = (string) ($_GET['type'] ?? 'top-week');
        if (!\in_array($type, self::SCORE_TYPES, true)) {
            return Response::json(
                ['ok' => false, 'error' => "Unknown type '{$type}'. Valid: " . \implode(', ', self::SCORE_TYPES)],
                422
            );
        }
        $amount = (int) ($_GET['amount'] ?? 10);
        $amount = \max(1, \min(100, $amount));
        $gameRef = \trim((string) ($_GET['game'] ?? ''));
        $game = $gameRef === '' ? null : $this->game($gameRef);

        if (($game === null && \str_starts_with($type, 'top') && !\str_starts_with($type, 'top-all'))) {
            return Response::json(['ok' => false, 'error' => "game '{$gameRef}' not found"], 404);
        }

        $rows = $this->board->forType($game === null ? null : (int) $game['id'], $type, $amount);

        return Response::json([
            'ok' => true,
            'type' => $type,
            'game' => $game['slug'] ?? null,
            'period_key' => Buckets::key(Buckets::TYPES[$type]['period']),
            'amount' => $amount,
            'rows' => $rows,
        ]);
    }

    /**
     * POST /api/score  {game: slug, alias?, score, ts, nonce, sig}
     * sig = HMAC_SHA256(secret, game|ts|nonce) — issued with the page markup (Signer).
     */
    public function submitScore(): Response
    {
        $body = $this->jsonBody();
        $gameRef = (string) ($body['game'] ?? '');
        $score = (int) ($body['score'] ?? -1);
        $ts = (string) ($body['ts'] ?? '');
        $nonce = (string) ($body['nonce'] ?? '');
        $alias = \array_key_exists('alias', $body) ? (string) $body['alias'] : null;
        $sig = (string) ($body['sig'] ?? '');

        if ($gameRef === '' || $score < 0) {
            return Response::json(['ok' => false, 'error' => 'game and score are required'], 422);
        }
        $game = $this->game($gameRef);
        if ($game === null || ($game['status'] ?? '') !== 'published') {
            return Response::json(['ok' => false, 'error' => 'unknown game'], 404);
        }
        if (!$this->signer->check($gameRef, $ts, $nonce, $sig)) {
            return Response::json(['ok' => false, 'error' => 'bad or stale page token'], 403);
        }
        if (($refused = $this->gate($game)) !== null) {
            return $refused;
        }

        $result = $this->board->submit(
            (int) $game['id'],
            $score,
            null, // no accounts on the public site by design
            $alias,
            \substr(\hash('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? '0')), 0, 32),
        );

        return Response::json([
            'ok' => true,
            'written' => $result['written'],
            'buckets' => $result['buckets'],
        ]);
    }

    /** POST /api/play {game: slug} — counts a play (idempotent per minute). */
    public function play(): Response
    {
        $body = $this->jsonBody();
        $game = $this->game((string) ($body['game'] ?? ''));
        if ($game === null) {
            return Response::json(['ok' => false, 'error' => 'unknown game'], 404);
        }
        if (($refused = $this->gate($game)) !== null) {
            return $refused;
        }
        $now = (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        $this->db->run('INSERT INTO play_events (game_id, source, played_at) VALUES (?, ?, ?)', [
            (int) $game['id'],
            'site',
            $now,
        ]);
        $this->db->run(
            'UPDATE games SET plays_count = plays_count + 1, plays_7d = plays_7d + 1 WHERE id = ?',
            [(int) $game['id']]
        );

        return Response::json(['ok' => true]);
    }

    /**
     * The licence gate. Returns null when the game may be served; otherwise the refusal response.
     * 451 on purpose: this is a legal block, not a server fault and not a permission problem.
     */
    private function gate(array $game): ?Response
    {
        $verdict = $this->licenses->canServe((int) $game['id'], $this->licenseCtx($game));
        if ((bool) $verdict['ok'] === true) {
            return null;
        }

        return Response::json([
            'ok' => false,
            'error' => 'this game is not licensed for serving',
            'game' => (string) ($game['slug'] ?? ''),
            'reasons' => $verdict['reasons'],
            'details' => $verdict['details'],
        ], 451);
    }

    /** @param array<string, mixed> $game  @return array<string, mixed> */
    private function licenseCtx(array $game): array
    {
        return [
            'commercial_install' => $this->commercial,
            'game_provider' => (string) ($game['provider'] ?? ''),
        ];
    }

    /**
     * GET /api/license?game=slug — public provenance for one game.
     *
     * Attribution notices are a licence OBLIGATION (cc-by and friends), so they are public by
     * design. `invoice_ref` and `allow_origins` are not: they are the buyer's commercial paperwork.
     */
    public function license(): Response
    {
        $game = $this->game(\trim((string) ($_GET['game'] ?? '')));
        if ($game === null) {
            return Response::json(['ok' => false, 'error' => 'unknown game'], 404);
        }
        $gameId = (int) $game['id'];
        $verdict = $this->licenses->audit($gameId, LicensePolicy::MODE_DYNAMIC, $this->licenseCtx($game));
        $rows = [];
        foreach ($this->licenses->licensesFor($gameId) as $row) {
            $rows[] = [
                'provider' => (string) ($row['provider'] ?? ''),
                'license_type' => (string) ($row['license_type'] ?? ''),
                'license_ref' => (string) ($row['license_ref'] ?? ''),
                'upstream_repo' => (string) ($row['upstream_repo'] ?? ''),
                'commit_sha' => (string) ($row['commit_sha'] ?? ''),
                'proof_url' => (string) ($row['proof_url'] ?? ''),
                'attribution_html' => $row['attribution_html'] === null ? null : (string) $row['attribution_html'],
                'captured_at' => $row['captured_at'] === null ? null : (string) $row['captured_at'],
                'expires_at' => $row['expires_at'] === null ? null : (string) $row['expires_at'],
                'status' => (string) ($row['status'] ?? ''),
            ];
        }

        return Response::json([
            'ok' => true,
            'game' => (string) ($game['slug'] ?? ''),
            'servable' => (bool) $verdict['ok'],
            'verdict' => (string) $verdict['verdict'],
            'attribution' => $verdict['attribution'],
            'reasons' => $verdict['reasons'],
            'warnings' => $verdict['warnings'],
            'licenses' => $rows,
        ], (bool) $verdict['ok'] === true ? 200 : 451);
    }

    /** @return array<string, mixed>|null */
    private function game(string $ref): ?array
    {
        $ref = \trim($ref);
        if ($ref === '') {
            return null;
        }
        if (\ctype_digit($ref)) {
            return $this->db->one('SELECT id, slug, title_ar, title_en, status, provider FROM games WHERE id = ?', [(int) $ref]);
        }

        return $this->db->one('SELECT id, slug, title_ar, title_en, status, provider FROM games WHERE slug = ?', [$ref]);
    }

    /** @return array<string, mixed> */
    private function jsonBody(): array
    {
        $raw = \file_get_contents('php://input') ?: '';
        $decoded = \json_decode($raw, true);

        return \is_array($decoded) ? $decoded : [];
    }
}
