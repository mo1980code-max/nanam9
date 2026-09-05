<?php

declare(strict_types=1);

namespace Nawras\Admin;

use Nawras\Db\Connection;
use Nawras\Http\Response;
use Nawras\Licensing\LicenseAuditor;
use Nawras\Licensing\LicensePolicy;

/**
 * The licence-ops side of the admin panel: what is published, what is blocked and why, and the
 * audit trail behind each decision. Every answer here comes from the auditor or from the ledger
 * tables — nothing is recomputed in the view, so the panel cannot drift from what the gate
 * actually enforces.
 *
 * Deliberately JSON-only. A licence decision is data a buyer needs to export, diff and attach to
 * a takedown reply; a themed HTML page would be the third place the same facts are rendered.
 */
final class AdminController
{
    private const SQL_COUNT = 'SELECT COUNT(*) AS n FROM games WHERE status = ?';

    private const SQL_LEDGER = 'SELECT id, game_id, license_id, verdict, mode, rules_version, reasons, audited_at
                                FROM license_audits ORDER BY id DESC LIMIT ?';

    private const SQL_LICENSED = 'SELECT COUNT(DISTINCT game_id) AS n FROM game_licenses';

    private const SQL_BY_VERDICT = 'SELECT verdict, COUNT(*) AS n FROM license_audits GROUP BY verdict';

    private const SQL_RUNS = 'SELECT id, provider, status, rows_seen, rows_new, rows_rejected, started_at
                              FROM provider_runs ORDER BY id DESC LIMIT ?';

    public function __construct(
        private readonly Connection $db,
        private readonly LicenseAuditor $licenses,
        private readonly bool $commercial = true,
    ) {
    }

    /** The one screen that answers "is this site legally servable right now". */
    public function dashboard(): Response
    {
        $published = (int) $this->db->scalar(self::SQL_COUNT, ['published']);
        $licensed = (int) $this->db->scalar(self::SQL_LICENSED);
        $verdicts = [];
        foreach ($this->db->all(self::SQL_BY_VERDICT) as $row) {
            $verdicts[(string) $row['verdict']] = (int) $row['n'];
        }
        $unlicensed = $this->licenses->unlicensed();

        return Response::json([
            'ok' => true,
            'commercial' => $this->commercial,
            'rules_version' => $this->licenses->rulesVersion(),
            'games' => [
                'published' => $published,
                'with_license_row' => $licensed,
                // A published game with no licence row cannot be served: the gate returns
                // no_license_row. This number being non-zero is the thing to fix first.
                'published_without_license' => \count($unlicensed),
            ],
            'ledger' => $verdicts,
            'unlicensed_slugs' => $this->slugs($unlicensed),
        ]);
    }

    /** Most recent audit rows, newest first — the trail a takedown reply gets answered with. */
    public function ledger(int $limit = 50): Response
    {
        $limit = $limit < 1 ? 50 : ($limit > 500 ? 500 : $limit);
        $rows = $this->db->all(self::SQL_LEDGER, [$limit]);
        foreach ($rows as &$row) {
            $row['reasons'] = \json_decode((string) $row['reasons'], true) ?? [];
        }
        unset($row);

        return Response::json(['ok' => true, 'count' => \count($rows), 'rows' => $rows]);
    }

    /** Games the licence gate currently refuses, with the finding codes that caused it. */
    public function blocked(): Response
    {
        $audit = $this->licenses->auditPublished(LicensePolicy::MODE_DYNAMIC);
        $rows = [];
        foreach ((array) $audit['rows'] as $row) {
            if ((bool) $row['ok'] === true) {
                continue;
            }
            $rows[] = [
                'slug' => (string) $row['game_slug'],
                'verdict' => (string) $row['verdict'],
                'license_type' => $row['license_type'],
                'reasons' => $row['reasons'],
            ];
        }

        return Response::json([
            'ok' => true,
            'counts' => ['ok' => $audit['ok'], 'warn' => $audit['warn'], 'blocked' => $audit['blocked']],
            'blocked' => $rows,
        ]);
    }

    /** Runs a full audit in export mode — what the static bundle would be allowed to contain. */
    public function exportPreview(): Response
    {
        return Response::json(['ok' => true, 'manifest' => $this->licenses->manifest()]);
    }

    /** Recent provider runs, so a stalled feed is visible next to the licence picture. */
    public function providerRuns(int $limit = 20): Response
    {
        $limit = $limit < 1 ? 20 : ($limit > 200 ? 200 : $limit);

        return Response::json([
            'ok' => true,
            'runs' => $this->db->all(self::SQL_RUNS, [$limit]),
        ]);
    }

    /** @param array<int, array<string, mixed>> $rows @return array<int, string> */
    private function slugs(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            $out[] = (string) ($row['game_slug'] ?? '');
        }

        return $out;
    }
}
