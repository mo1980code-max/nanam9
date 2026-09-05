<?php

declare(strict_types=1);

namespace Nawras\Licensing;

use DateTimeImmutable;
use DateTimeZone;
use Nawras\Db\Connection;

/**
 * The gate between the catalogue and the public.
 *
 * The rule this class exists to enforce: **no game is served, exported or scored unless a row in
 * `game_licenses` says why it may be.** A marketplace arcade that cannot answer "where did this
 * game come from and what lets you host it?" is one takedown notice away from being delisted, and
 * every competitor ships games with no provenance at all.
 *
 * Decisions come from LicensePolicy (db/license_rules.json); this class only fetches rows, applies
 * the policy, and writes the result into the append-only `license_audits` ledger so that "we
 * audited this on <date> against rules v<N>" is a fact on disk rather than a claim.
 *
 * Two modes, one policy:
 *   MODE_DYNAMIC — serving from this install;
 *   MODE_EXPORT  — copying into a static bundle that leaves the server (adds redistribution rules).
 */
final class LicenseAuditor
{
    /** Every column LicensePolicy reads, selected explicitly — no SELECT * that drifts. */
    public const SQL_GAME_LICENSES = 'SELECT id, game_id, provider, license_type, license_ref, upstream_repo,
               commit_sha, license_file, license_sha256, proof_url, invoice_ref, allow_origins,
               attribution_required, attribution_html, captured_at, expires_at, status
        FROM game_licenses WHERE game_id = ? ORDER BY id ASC';

    /** Published games with every licence row they have; LEFT JOIN so an unlicensed game still appears. */
    public const SQL_PUBLISHED = 'SELECT g.id AS game_id, g.slug AS game_slug, g.provider AS game_provider,
               gl.id AS license_id, gl.provider, gl.license_type, gl.license_ref, gl.upstream_repo,
               gl.commit_sha, gl.license_file, gl.license_sha256, gl.proof_url, gl.invoice_ref,
               gl.allow_origins, gl.attribution_required, gl.attribution_html, gl.captured_at,
               gl.expires_at, gl.status
        FROM games g
        LEFT JOIN game_licenses gl ON gl.game_id = g.id
        WHERE g.status = ?
        ORDER BY g.id ASC, gl.id ASC';

    /** The admin's "what is invisible right now and why" query — one indexed scan, no PHP loop. */
    public const SQL_UNLICENSED = 'SELECT g.id AS game_id, g.slug AS game_slug
        FROM games g
        WHERE g.status = ?
          AND NOT EXISTS (SELECT 1 FROM game_licenses gl WHERE gl.game_id = g.id AND gl.status = ?)
        ORDER BY g.id ASC';

    private const SQL_RECORD = 'INSERT INTO license_audits
        (game_id, license_id, verdict, mode, rules_version, reasons, details, audited_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

    private const SQL_MARK = 'UPDATE game_licenses SET audited_at = ?, audit_verdict = ? WHERE id = ?';

    public function __construct(
        private readonly Connection $db,
        private readonly LicensePolicy $policy,
    ) {
    }

    public function rulesVersion(): int
    {
        return $this->policy->version();
    }

    /**
     * @return list<array<string, mixed>> the game's licence rows, empty when it has none
     */
    public function licensesFor(int $gameId): array
    {
        return $this->db->all(self::SQL_GAME_LICENSES, [$gameId]);
    }

    /**
     * Full verdict for one game, without touching the ledger.
     *
     * @param array<string, mixed> $ctx
     *
     * @return array<string, mixed>
     */
    public function audit(int $gameId, string $mode = LicensePolicy::MODE_DYNAMIC, array $ctx = []): array
    {
        $licenses = $this->licensesFor($gameId);
        $verdict = $this->policy->decide($licenses, $mode, $ctx);
        $verdict['game_id'] = $gameId;
        $verdict['licenses'] = \count($licenses);

        return $verdict;
    }

    /**
     * The gate SiteController calls before it lets a game be played or scored.
     *
     * @param array<string, mixed> $ctx
     *
     * @return array<string, mixed> ok: bool + reasons for the log/response
     */
    public function canServe(int $gameId, array $ctx = []): array
    {
        return $this->audit($gameId, LicensePolicy::MODE_DYNAMIC, $ctx);
    }

    /**
     * The gate the static exporter calls: same policy, plus the redistribution rules.
     *
     * @param array<string, mixed> $ctx
     *
     * @return array<string, mixed>
     */
    public function canExport(int $gameId, array $ctx = []): array
    {
        return $this->audit($gameId, LicensePolicy::MODE_EXPORT, $ctx);
    }

    /**
     * Audits every published game in one pass and writes the ledger.
     *
     * @param array<string, mixed> $ctx
     *
     * @return array{audited: int, ok: int, warn: int, blocked: int, rows: list<array<string, mixed>>}
     */
    public function auditPublished(string $mode = LicensePolicy::MODE_DYNAMIC, array $ctx = []): array
    {
        $at = ($ctx['at'] ?? null) instanceof DateTimeImmutable
            ? $ctx['at']
            : new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $ctx['at'] = $at;
        $stamp = $at->format('Y-m-d H:i:s');

        $grouped = [];
        foreach ($this->db->all(self::SQL_PUBLISHED, ['published']) as $row) {
            $gameId = (int) $row['game_id'];
            $grouped[$gameId]['slug'] = (string) $row['game_slug'];
            $grouped[$gameId]['provider'] = (string) ($row['game_provider'] ?? '');
            if (($row['license_id'] ?? null) !== null) {
                $grouped[$gameId]['licenses'][] = $row;
            }
        }

        $rows = [];
        $counts = ['ok' => 0, 'warn' => 0, 'blocked' => 0];
        $this->db->transactional(function () use ($grouped, $mode, $ctx, $stamp, &$rows, &$counts): void {
            foreach ($grouped as $gameId => $game) {
                $licenses = $game['licenses'] ?? [];
                $ctx['game_provider'] = (string) ($game['provider'] ?? '');
                $verdict = $this->policy->decide($licenses, $mode, $ctx);
                $verdict['game_id'] = (int) $gameId;
                $verdict['game_slug'] = (string) $game['slug'];
                $verdict['licenses'] = \count($licenses);
                $counts[$verdict['verdict']] = ($counts[$verdict['verdict']] ?? 0) + 1;

                $this->record($gameId, $verdict['license_id'], (string) $verdict['verdict'], $mode, $verdict, $at);
                foreach ($licenses as $license) {
                    $this->markLicense((int) $license['license_id'], (string) $verdict['verdict'], $stamp);
                }
                $rows[] = $verdict;
            }
        });

        return [
            'audited' => \count($rows),
            'ok' => $counts['ok'],
            'warn' => $counts['warn'],
            'blocked' => $counts['blocked'],
            'rows' => $rows,
        ];
    }

    /**
     * Published games with no usable licence row. Drives the admin warning banner and is the
     * single query that proves the catalogue is not silently hosting unlicensed work.
     *
     * @return list<array{game_id: int, game_slug: string}>
     */
    public function unlicensed(string $status = 'published'): array
    {
        $out = [];
        foreach ($this->db->all(self::SQL_UNLICENSED, [$status, 'active']) as $row) {
            $out[] = ['game_id' => (int) $row['game_id'], 'game_slug' => (string) $row['game_slug']];
        }

        return $out;
    }

    /**
     * One append-only ledger row. Never updated, never deleted: this is the evidence you show a
     * rights holder.
     *
     * @param array<string, mixed> $verdict
     */
    public function record(
        int $gameId,
        ?int $licenseId,
        string $verdictCode,
        string $mode,
        array $verdictData,
        ?DateTimeImmutable $at = null,
    ): int {
        $at ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $reasons = (array) ($verdictData['reasons'] ?? []);
        $details = (array) ($verdictData['details'] ?? []);
        $labelled = [];
        foreach ($reasons as $code) {
            $labelled[(string) $code] = $this->policy->label((string) $code, 'ar');
        }

        return $this->db->run(self::SQL_RECORD, [
            $gameId,
            $licenseId,
            $verdictCode,
            $mode,
            $this->policy->version(),
            (string) \json_encode(\array_values($reasons), JSON_UNESCAPED_UNICODE),
            (string) \json_encode(['details' => $details, 'labels' => $labelled], JSON_UNESCAPED_UNICODE),
            $at->format('Y-m-d H:i:s'),
        ]);
    }

    /** Caches the last verdict on the licence row so admin lists can filter without re-auditing. */
    public function markLicense(int $licenseId, string $verdict, string $stamp): int
    {
        return $this->db->run(self::SQL_MARK, [$stamp, $verdict, $licenseId]);
    }

    /**
     * What the static exporter writes next to the bundle: which games may be copied, which may not
     * and why, plus the attribution text each surviving game owes. The static site re-reads
     * public/assets/license-rules.json (the same bytes this policy loaded) and can therefore
     * re-check itself; rules_sha256 is how it proves it is checking the same rules.
     *
     * @return array<string, mixed>
     */
    public function manifest(?DateTimeImmutable $at = null): array
    {
        $at ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $audit = $this->auditPublished(LicensePolicy::MODE_EXPORT, ['at' => $at]);
        $games = [];
        foreach ($audit['rows'] as $row) {
            $games[] = [
                'slug' => (string) ($row['game_slug'] ?? ''),
                'verdict' => (string) $row['verdict'],
                'license_type' => $row['license_type'],
                'exportable' => (bool) $row['ok'],
                'attribution' => $row['attribution'],
                'reasons' => $row['reasons'],
                'warnings' => $row['warnings'],
            ];
        }

        return [
            'rules_version' => $this->policy->version(),
            'rules_sha256' => \hash('sha256', (string) \json_encode($this->policy->rules())),
            'mode' => LicensePolicy::MODE_EXPORT,
            'generated_at' => $at->format('Y-m-d H:i:s'),
            'counts' => ['ok' => $audit['ok'], 'warn' => $audit['warn'], 'blocked' => $audit['blocked']],
            'games' => $games,
        ];
    }
}
