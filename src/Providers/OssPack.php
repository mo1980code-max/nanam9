<?php

declare(strict_types=1);

namespace Nawras\Providers;

use Nawras\Licensing\LicensePolicy;
use RuntimeException;

/**
 * The bundled open-source pack — and the gate that decides what may be in it.
 *
 * A pack entry is a `game_licenses` row with game metadata attached. That is not a shortcut, it is
 * the point: the same LicensePolicy that guards the live catalogue judges the pack, so a game
 * cannot sneak into the shipped bundle through a side door. Entries are verified in EXPORT mode,
 * because a pack is by definition redistributed — which means a licence type that forbids
 * redistribution can never ship in one.
 *
 * On top of the licence rules the pack adds exactly one invariant of its own: **every entry is
 * pinned to a full commit sha.** "We took it from GitHub" is not provenance; "we took commit
 * 9f2c1ab… whose LICENSE hashes to e3b0c44…" is.
 *
 * db/oss_pack.json ships as a worked example (five entries, two of them deliberately broken) so a
 * buyer sees the gate reject something before they trust it to accept something. Curating the real
 * 50-game pack is data entry against this format — the validator, not the list, is the product.
 */
final class OssPack
{
    /** Fields every entry must carry, whatever its licence type. */
    public const REQUIRED = [
        'slug', 'title_ar', 'title_en', 'provider', 'license_type', 'license_ref',
        'upstream_repo', 'commit_sha', 'license_file', 'license_sha256', 'proof_url',
    ];

    /** @var array<string, mixed> */
    private array $pack;

    /**
     * @param array<string, mixed> $pack
     */
    public function __construct(
        private readonly LicensePolicy $policy,
        array $pack,
    ) {
        if (!isset($pack['entries']) || !\is_array($pack['entries'])) {
            throw new RuntimeException('Pack file is malformed: "entries" must be a list.');
        }
        $this->pack = $pack;
    }

    public static function load(LicensePolicy $policy, ?string $path = null): self
    {
        $path ??= (\defined('ARCADE_ROOT') ? (string) ARCADE_ROOT : \dirname(__DIR__, 2)) . '/db/oss_pack.json';
        if (!\is_file($path)) {
            throw new RuntimeException("Pack file not found ({$path}).");
        }
        $decoded = \json_decode((string) \file_get_contents($path), true);
        if (!\is_array($decoded)) {
            throw new RuntimeException("Pack file is not valid JSON ({$path}).");
        }

        return new self($policy, $decoded);
    }

    public function version(): int
    {
        return (int) ($this->pack['version'] ?? 0);
    }

    /** @return list<array<string, mixed>> */
    public function entries(): array
    {
        return \array_values((array) $this->pack['entries']);
    }

    /**
     * @return array{ok: bool, verdict: string, slug: string, license_type: string,
     *               missing: list<string>, reasons: list<string>, warnings: list<string>}
     */
    public function verifyEntry(array $entry): array
    {
        $slug = (string) ($entry['slug'] ?? '');
        $missing = [];
        foreach (self::REQUIRED as $field) {
            if (\trim((string) ($entry[$field] ?? '')) === '') {
                $missing[] = $field;
            }
        }
        if ($missing !== []) {
            return $this->result(false, 'incomplete', $slug, (string) ($entry['license_type'] ?? ''), $missing, [], []);
        }

        // A pack is redistributed, so export rules apply: commercial/AGPL entries cannot ship here.
        $verdict = $this->policy->decide([$this->licenseRow($entry)], LicensePolicy::MODE_EXPORT);
        if ($verdict['ok'] === false) {
            return $this->result(
                false,
                (string) $verdict['verdict'],
                $slug,
                // the type the entry CLAIMED, not the granting one (there is none) — an admin
                // reading a rejection needs "claims mit, refused because …"
                (string) ($entry['license_type'] ?? ''),
                [],
                $verdict['reasons'],
                $verdict['warnings']
            );
        }

        return $this->result(
            true,
            (string) $verdict['verdict'],
            $slug,
            (string) ($entry['license_type'] ?? ''),
            [],
            [],
            $verdict['warnings']
        );
    }

    /**
     * @return array{pack_version: int, total: int, accepted: int, rejected: int,
     *               entries: list<array<string, mixed>>}
     */
    public function verifyAll(): array
    {
        $accepted = 0;
        $rows = [];
        foreach ($this->entries() as $entry) {
            $result = $this->verifyEntry($entry);
            $accepted += $result['ok'] ? 1 : 0;
            $rows[] = $result;
        }

        return [
            'pack_version' => $this->version(),
            'total' => \count($rows),
            'accepted' => $accepted,
            'rejected' => \count($rows) - $accepted,
            'entries' => $rows,
        ];
    }

    /**
     * The `game_licenses` row this entry would write — the exact shape LicensePolicy judges and
     * tools/prove_runtime.py proof E reproduces.
     *
     * @param array<string, mixed> $entry
     *
     * @return array<string, mixed>
     */
    public function licenseRow(array $entry): array
    {
        return [
            'id' => 0,
            'provider' => (string) ($entry['provider'] ?? 'oss'),
            'external_id' => (string) ($entry['slug'] ?? ''),
            'license_type' => (string) ($entry['license_type'] ?? ''),
            'license_ref' => (string) ($entry['license_ref'] ?? ''),
            'upstream_repo' => (string) ($entry['upstream_repo'] ?? ''),
            'commit_sha' => (string) ($entry['commit_sha'] ?? ''),
            'license_file' => (string) ($entry['license_file'] ?? ''),
            'license_sha256' => (string) ($entry['license_sha256'] ?? ''),
            'proof_url' => (string) ($entry['proof_url'] ?? ''),
            'invoice_ref' => (string) ($entry['invoice_ref'] ?? ''),
            'allow_origins' => (string) ($entry['allow_origins'] ?? ''),
            'attribution_required' => (int) ($entry['attribution_required'] ?? 0),
            'attribution_html' => $entry['attribution_html'] ?? null,
            'captured_at' => $entry['captured_at'] ?? null,
            'expires_at' => $entry['expires_at'] ?? null,
            'status' => (string) ($entry['status'] ?? 'active'),
        ];
    }

    /**
     * @param array<string, mixed> $entry
     *
     * @return array{ok: bool, verdict: string, slug: string, license_type: string,
     *               missing: list<string>, reasons: list<string>, warnings: list<string>}
     */
    private function result(
        bool $ok,
        string $verdict,
        string $slug,
        string $type,
        array $missing,
        array $reasons,
        array $warnings,
    ): array {
        return [
            'ok' => $ok,
            'verdict' => $verdict,
            'slug' => $slug,
            'license_type' => $type,
            'missing' => $missing,
            'reasons' => $reasons,
            'warnings' => $warnings,
        ];
    }
}
