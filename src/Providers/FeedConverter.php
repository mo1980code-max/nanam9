<?php

declare(strict_types=1);

namespace Nawras\Providers;

use DateTimeImmutable;
use DateTimeZone;
use Nawras\Db\Connection;
use Nawras\Licensing\LicensePolicy;

/**
 * Turns a provider feed into catalogue candidates — and refuses to fetch anything unsafe.
 *
 * The contract, in order:
 *
 *   1. The feed URL passes UrlGuard BEFORE any request leaves the server. A refused URL is still
 *      recorded in `provider_runs`, because "we were asked to fetch the cloud metadata endpoint and
 *      said no" belongs in the audit trail.
 *   2. Every raw item is stored verbatim in `provider_games`, keyed by (provider, external_id) —
 *      the idempotency key the whole sync relies on. Re-running a feed never duplicates a row.
 *   3. Each item is turned into a licence row and judged by the SAME LicensePolicy that guards the
 *      live catalogue. A feed cannot hand us a game we are not allowed to host; it can only hand us
 *      a candidate, and the candidate is rejected with a reason we keep.
 *
 * `provider_runs` records seen/new/rejected for every run, so a buyer can answer "what did the
 * GameDistribution sync do last Tuesday and what did it throw away?" from the database.
 */
final class FeedConverter
{
    public const SQL_LOOKUP = 'SELECT id FROM provider_games WHERE provider = ? AND external_id = ?';

    public const SQL_STORE = 'INSERT INTO provider_games (provider, external_id, payload, fetched_at)
        VALUES (?, ?, ?, ?)';

    public const SQL_REFRESH = 'UPDATE provider_games SET payload = ?, fetched_at = ? WHERE id = ?';

    public const SQL_RUN_OPEN = 'INSERT INTO provider_runs (provider, status, rows_seen, rows_new, rows_rejected, started_at)
        VALUES (?, ?, ?, ?, ?, ?)';

    public const SQL_RUN_CLOSE = 'UPDATE provider_runs SET status = ?, rows_seen = ?, rows_new = ?, rows_rejected = ?, detail = ?, finished_at = ? WHERE id = ?';

    /** Fields an item must carry to be considered at all. */
    public const REQUIRED_ITEM = ['external_id', 'title_en', 'license_type'];

    public function __construct(
        private readonly Connection $db,
        private readonly LicensePolicy $policy,
        private readonly UrlGuard $guard,
    ) {
    }

    /**
     * Ingests one feed.
     *
     * @param list<array<string, mixed>> $items decoded feed items (the caller fetched them)
     *
     * @return array{ok: bool, reason: string, provider: string, seen: int, new: int, rejected: int,
     *               accepted: int, rejections: list<array{external_id: string, reasons: list<string>}>}
     */
    public function ingest(
        string $provider,
        string $feedUrl,
        array $items,
        ?DateTimeImmutable $at = null,
    ): array {
        $at ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $stamp = $at->format('Y-m-d H:i:s');
        $provider = \mb_substr(\trim($provider), 0, 32);

        $verdict = $this->guard->inspect($feedUrl);
        $runId = $this->openRun($provider, $verdict['ok'] === false ? 'refused' : 'running', $stamp);
        if ($verdict['ok'] === false) {
            $detail = (string) \json_encode([
                'feed_url' => $feedUrl,
                'refused' => (string) $verdict['reason'],
                'host' => (string) $verdict['host'],
                'ips' => $verdict['ips'],
            ], JSON_UNESCAPED_SLASHES);
            $this->closeRun($runId, 'refused', 0, 0, 0, $detail, $stamp);

            return $this->report($provider, (string) $verdict['reason'], 0, 0, 0, 0, []);
        }

        $seen = 0;
        $new = 0;
        $rejected = 0;
        $accepted = 0;
        $rejections = [];

        $this->db->transactional(function () use (
            $provider, $items, $stamp, &$seen, &$new, &$rejected, &$accepted, &$rejections
        ): void {
            foreach ($items as $item) {
                if (!\is_array($item)) {
                    continue;
                }
                $seen++;
                $missing = [];
                foreach (self::REQUIRED_ITEM as $field) {
                    if (\trim((string) ($item[$field] ?? '')) === '') {
                        $missing[] = $field;
                    }
                }
                $externalId = \mb_substr((string) ($item['external_id'] ?? ''), 0, 64);

                $existing = $this->db->one(self::SQL_LOOKUP, [$provider, $externalId]);
                $payload = (string) \json_encode($item, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                if ($existing === null) {
                    $new++;
                    $this->db->run(self::SQL_STORE, [$provider, $externalId, $payload, $stamp]);
                } else {
                    $this->db->run(self::SQL_REFRESH, [$payload, $stamp, (int) $existing['id']]);
                }

                if ($missing !== []) {
                    $rejected++;
                    $rejections[] = ['external_id' => $externalId, 'reasons' => $missing];
                    continue;
                }

                $decision = $this->policy->decide([$this->licenseRow($item)], LicensePolicy::MODE_DYNAMIC);
                if ($decision['ok'] === false) {
                    $rejected++;
                    $rejections[] = ['external_id' => $externalId, 'reasons' => $decision['reasons']];
                    continue;
                }
                $accepted++;
            }
        });

        $detail = (string) \json_encode([
            'feed_url' => $feedUrl,
            'host' => (string) $verdict['host'],
            'rejections' => $rejections,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $this->closeRun($runId, 'ok', $seen, $new, $rejected, $detail, $stamp);

        return $this->report($provider, '', $seen, $new, $rejected, $accepted, $rejections);
    }

    /**
     * The licence row a feed item would need before its game could be published.
     *
     * @param array<string, mixed> $item
     *
     * @return array<string, mixed>
     */
    public function licenseRow(array $item): array
    {
        return [
            'id' => 0,
            'provider' => (string) ($item['provider'] ?? 'feed'),
            'external_id' => (string) ($item['external_id'] ?? ''),
            'license_type' => (string) ($item['license_type'] ?? ''),
            'license_ref' => (string) ($item['license_ref'] ?? ''),
            'upstream_repo' => (string) ($item['upstream_repo'] ?? ''),
            'commit_sha' => (string) ($item['commit_sha'] ?? ''),
            'license_file' => (string) ($item['license_file'] ?? ''),
            'license_sha256' => (string) ($item['license_sha256'] ?? ''),
            'proof_url' => (string) ($item['proof_url'] ?? ''),
            'invoice_ref' => (string) ($item['invoice_ref'] ?? ''),
            'allow_origins' => (string) ($item['allow_origins'] ?? ''),
            'attribution_required' => (int) ($item['attribution_required'] ?? 0),
            'attribution_html' => $item['attribution_html'] ?? null,
            'captured_at' => $item['captured_at'] ?? null,
            'expires_at' => $item['expires_at'] ?? null,
            'status' => (string) ($item['status'] ?? 'active'),
        ];
    }

    private function openRun(string $provider, string $status, string $stamp): int
    {
        $this->db->run(self::SQL_RUN_OPEN, [$provider, $status, 0, 0, 0, $stamp]);

        return (int) ($this->db->pdo()->lastInsertId() ?: 0);
    }

    private function closeRun(int $runId, string $status, int $seen, int $new, int $rejected, string $detail, string $stamp): void
    {
        $this->db->run(self::SQL_RUN_CLOSE, [$status, $seen, $new, $rejected, $detail, $stamp, $runId]);
    }

    /**
     * @param list<array{external_id: string, reasons: list<string>}> $rejections
     *
     * @return array{ok: bool, reason: string, provider: string, seen: int, new: int, rejected: int,
     *               accepted: int, rejections: list<array{external_id: string, reasons: list<string>}>}
     */
    private function report(
        string $provider,
        string $reason,
        int $seen,
        int $new,
        int $rejected,
        int $accepted,
        array $rejections,
    ): array {
        return [
            'ok' => $reason === '',
            'reason' => $reason,
            'provider' => $provider,
            'seen' => $seen,
            'new' => $new,
            'rejected' => $rejected,
            'accepted' => $accepted,
            'rejections' => $rejections,
        ];
    }
}
