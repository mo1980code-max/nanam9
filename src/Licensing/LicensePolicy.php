<?php

declare(strict_types=1);

namespace Nawras\Licensing;

use DateTimeImmutable;
use DateTimeZone;
use RuntimeException;

/**
 * The licence decision engine — pure, stateless, no database.
 *
 * Policy lives in db/license_rules.json and NOWHERE else. This class deliberately contains no
 * licence type names: tools/verify_php.py fails the build if a single one appears here, because a
 * rule that lives in PHP is a rule the static export cannot see, and the whole point of this batch
 * is that the dynamic site and the exported bundle decide with the same bytes.
 *
 * Two questions get answered, in this order:
 *
 *   1. evaluate() — one licence row: is the evidence this type demands actually recorded?
 *   2. decide()   — one game: a game is servable when AT LEAST ONE of its rows is clean
 *                   (dual licensing: "MIT OR Apache-2.0" grants either way), but a single
 *                   revoked/disputed row poisons the game regardless of its siblings, because a
 *                   dispute is about the work, not about the paperwork.
 *
 * Every finding is {code, severity, detail}; codes are the vocabulary in self::CODES and each one
 * is labelled (ar + en) in the policy file so the admin UI never renders a raw constant.
 */
final class LicensePolicy
{
    public const MODE_DYNAMIC = 'dynamic';

    public const MODE_EXPORT = 'export';

    public const SEVERITY_BLOCK = 'block';

    public const SEVERITY_WARN = 'warn';

    public const VERDICT_OK = 'ok';

    public const VERDICT_WARN = 'warn';

    public const VERDICT_BLOCKED = 'blocked';

    /**
     * The complete finding vocabulary. db/license_rules.json must label exactly these — the
     * structural gate compares the two sets in both directions, so neither can drift.
     */
    public const CODES = [
        'no_license_row', 'work_disputed', 'license_not_active', 'unknown_license_type', 'type_forbidden',
        'missing_commit_sha', 'missing_license_file', 'missing_license_sha256', 'missing_proof_url',
        'missing_invoice_ref', 'missing_expires_at',
        'bad_commit_sha', 'bad_license_sha256', 'bad_proof_url', 'bad_expires_at',
        'license_expired', 'missing_attribution', 'wildcard_origin', 'not_commercial_ok', 'no_redistribution',
        'copyleft_review', 'unpinned_upstream', 'no_capture_date', 'provider_mismatch', 'expires_soon',
        'too_many_origins',
    ];

    /** @var array<string, mixed> */
    private array $rules;

    /** @var array<string, array<string, mixed>> */
    private array $types;

    /** @var array<string, array<string, mixed>> */
    private array $statuses;

    /** @var list<string> */
    private array $evidence;

    /**
     * @param array<string, mixed>|null $rules parsed policy document (tests inject one)
     */
    public function __construct(?array $rules = null)
    {
        $rules ??= self::readRules();
        $types = $rules['types'] ?? null;
        $statuses = $rules['statuses'] ?? null;
        if (!\is_array($types) || $types === [] || !\is_array($statuses) || !isset($statuses['active'])) {
            throw new RuntimeException('Licence policy is malformed: types/statuses are required.');
        }
        $this->rules = $rules;
        $this->types = $types;
        $this->statuses = $statuses;
        $this->evidence = \array_values(\array_map(
            static fn ($f): string => (string) $f,
            (array) ($rules['evidence'] ?? [])
        ));
    }

    public static function load(?string $path = null): self
    {
        return new self(self::readRules($path));
    }

    /** @return array<string, mixed> */
    private static function readRules(?string $path = null): array
    {
        $path ??= self::defaultPath();
        if (!\is_file($path)) {
            throw new RuntimeException("Licence policy file not found ({$path}).");
        }
        $decoded = \json_decode((string) \file_get_contents($path), true);
        if (!\is_array($decoded)) {
            throw new RuntimeException("Licence policy is not valid JSON ({$path}).");
        }

        return $decoded;
    }

    private static function defaultPath(): string
    {
        $root = \defined('ARCADE_ROOT') ? (string) ARCADE_ROOT : \dirname(__DIR__, 2);

        return $root . '/db/license_rules.json';
    }

    public function version(): int
    {
        return (int) ($this->rules['version'] ?? 0);
    }

    /** @return array<string, mixed> the whole policy document — what the static export ships. */
    public function rules(): array
    {
        return $this->rules;
    }

    /** @return array<string, array<string, mixed>> */
    public function types(): array
    {
        return $this->types;
    }

    public function isKnownType(string $type): bool
    {
        return isset($this->types[$type]);
    }

    /** Human label for a finding code, in the requested locale. */
    public function label(string $code, string $locale = 'ar'): string
    {
        $entry = (array) ($this->rules['finding_labels'][$code] ?? []);

        return (string) ($entry[$locale] ?? $entry['en'] ?? $code);
    }

    /**
     * Judges one licence row.
     *
     * @param array<string, mixed> $license a game_licenses row
     * @param array<string, mixed> $ctx     commercial_install: bool, game_provider: string, at: DateTimeImmutable
     *
     * @return list<array{code: string, severity: string, detail: string}>
     */
    public function evaluate(array $license, string $mode = self::MODE_DYNAMIC, array $ctx = []): array
    {
        $findings = [];
        $at = self::clock($ctx);
        $today = $at->format('Y-m-d');

        $status = (string) ($license['status'] ?? '');
        $statusSpec = $this->statuses[$status] ?? null;
        if ($statusSpec === null || (bool) ($statusSpec['servable'] ?? false) === false) {
            $findings[] = $this->finding('license_not_active', self::SEVERITY_BLOCK, $status === '' ? 'empty' : $status);
        }

        $type = (string) ($license['license_type'] ?? '');
        $spec = $this->types[$type] ?? null;
        if ($spec === null) {
            // Nothing else is decidable: the evidence a type demands is defined by the type.
            $findings[] = $this->finding('unknown_license_type', self::SEVERITY_BLOCK, $type === '' ? 'empty' : $type);

            return $findings;
        }
        if ((bool) ($spec['forbidden'] ?? false)) {
            $findings[] = $this->finding('type_forbidden', self::SEVERITY_BLOCK, $type);
        }

        foreach ($this->evidence as $field) {
            if ((bool) ($spec['needs'][$field] ?? false) === false) {
                continue;
            }
            $value = \trim((string) ($license[$field] ?? ''));
            if ($value === '') {
                $findings[] = $this->finding('missing_' . $field, self::SEVERITY_BLOCK, $type);
                continue;
            }
            $bad = $this->malformed($field, $value);
            if ($bad !== null) {
                $findings[] = $this->finding($bad, self::SEVERITY_BLOCK, $value);
            }
        }

        if ($this->expired($license, $today)) {
            $findings[] = $this->finding('license_expired', self::SEVERITY_BLOCK, (string) ($license['expires_at'] ?? ''));
        }
        // Attribution is owed when the type demands it OR the row itself says so — a buyer who
        // negotiated a notice into an otherwise notice-free licence must be able to enforce it.
        if ($this->wantsAttribution($license, $spec) && \trim((string) ($license['attribution_html'] ?? '')) === '') {
            $findings[] = $this->finding('missing_attribution', self::SEVERITY_BLOCK, $type);
        }
        foreach ($this->originFindings($license) as $finding) {
            $findings[] = $finding;
        }
        if ((bool) ($spec['commercial_ok'] ?? true) === false && (bool) ($ctx['commercial_install'] ?? true)) {
            $findings[] = $this->finding('not_commercial_ok', self::SEVERITY_BLOCK, $type);
        }
        if ($mode === self::MODE_EXPORT && (bool) ($spec['redistribution_ok'] ?? true) === false) {
            $findings[] = $this->finding('no_redistribution', self::SEVERITY_BLOCK, $type);
        }

        foreach ($this->warnings($license, $spec, $type, $at, $ctx) as $finding) {
            $findings[] = $finding;
        }

        return $findings;
    }

    /**
     * @param array<string, mixed> $license
     * @param array<string, mixed> $spec
     */
    private function wantsAttribution(array $license, array $spec): bool
    {
        return (bool) ($spec['attribution_required'] ?? false)
            || (bool) ($license['attribution_required'] ?? false);
    }

    /**
     * Judges one game from all of its licence rows.
     *
     * @param list<array<string, mixed>> $licenses every game_licenses row for the game, any order
     *
     * @return array{ok: bool, verdict: string, license_id: int|null, license_type: string|null,
     *               reasons: list<string>, warnings: list<string>, details: array<string, string>,
     *               attribution: string|null}
     */
    public function decide(array $licenses, string $mode = self::MODE_DYNAMIC, array $ctx = []): array
    {
        if ($licenses === []) {
            return $this->verdict(self::VERDICT_BLOCKED, null, null, ['no_license_row'], [], ['no_license_row' => 'no rows']);
        }

        // A revoked/disputed row is about the WORK: another clean row cannot launder it.
        foreach ($licenses as $row) {
            $status = (string) ($row['status'] ?? '');
            if ((bool) ($this->statuses[$status]['blocking'] ?? false)) {
                return $this->verdict(
                    self::VERDICT_BLOCKED,
                    (int) ($row['id'] ?? 0) ?: null,
                    (string) ($row['license_type'] ?? '') ?: null,
                    ['work_disputed'],
                    [],
                    ['work_disputed' => $status]
                );
            }
        }

        $cleanest = null;
        foreach ($licenses as $row) {
            $findings = $this->evaluate($row, $mode, $ctx);
            $blocks = $this->codes($findings, self::SEVERITY_BLOCK);
            $warns = $this->codes($findings, self::SEVERITY_WARN);
            if ($blocks === []) {
                return $this->verdict(
                    $warns === [] ? self::VERDICT_OK : self::VERDICT_WARN,
                    (int) ($row['id'] ?? 0) ?: null,
                    (string) ($row['license_type'] ?? ''),
                    [],
                    $warns,
                    $this->details($findings, self::SEVERITY_WARN),
                    $this->attribution($row)
                );
            }
            if ($cleanest === null || \count($blocks) < \count($cleanest['blocks'])) {
                $cleanest = [
                    'blocks' => $blocks,
                    'warns' => $warns,
                    'details' => $this->details($findings, self::SEVERITY_BLOCK),
                ];
            }
        }

        return $this->verdict(
            self::VERDICT_BLOCKED,
            null,
            null,
            $cleanest['blocks'],
            $cleanest['warns'],
            $cleanest['details']
        );
    }

    /**
     * Attribution text owed for a granting row, or null when the type owes none.
     * Kept as HTML on purpose: cc-by notices are links, and the static export embeds this verbatim.
     */
    public function attribution(array $license): ?string
    {
        $spec = $this->types[(string) ($license['license_type'] ?? '')] ?? null;
        if ($spec === null || $this->wantsAttribution($license, $spec) === false) {
            return null;
        }
        $html = \trim((string) ($license['attribution_html'] ?? ''));

        return $html !== '' ? $html : null;
    }

    /**
     * @param list<array{code: string, severity: string, detail: string}> $findings
     *
     * @return list<string>
     */
    private function codes(array $findings, string $severity): array
    {
        $out = [];
        foreach ($findings as $finding) {
            if ($finding['severity'] === $severity) {
                $out[] = $finding['code'];
            }
        }

        return $out;
    }

    /**
     * @param list<array{code: string, severity: string, detail: string}> $findings
     *
     * @return array<string, string>
     */
    private function details(array $findings, string $severity): array
    {
        $out = [];
        foreach ($findings as $finding) {
            if ($finding['severity'] === $severity) {
                $out[$finding['code']] = $finding['detail'];
            }
        }

        return $out;
    }

    /** @return array{code: string, severity: string, detail: string} */
    private function finding(string $code, string $severity, string $detail = ''): array
    {
        return ['code' => $code, 'severity' => $severity, 'detail' => $detail];
    }

    /**
     * @param list<string> $reasons
     * @param list<string> $warnings
     * @param array<string, string> $details
     *
     * @return array{ok: bool, verdict: string, license_id: int|null, license_type: string|null,
     *               reasons: list<string>, warnings: list<string>, details: array<string, string>,
     *               attribution: string|null}
     */
    private function verdict(
        string $verdict,
        ?int $licenseId,
        ?string $type,
        array $reasons,
        array $warnings,
        array $details,
        ?string $attribution = null,
    ): array {
        return [
            'ok' => $verdict !== self::VERDICT_BLOCKED,
            'verdict' => $verdict,
            'license_id' => $licenseId,
            'license_type' => $type,
            'reasons' => $reasons,
            'warnings' => $warnings,
            'details' => $details,
            'attribution' => $attribution,
        ];
    }

    /** Format check for one non-empty evidence field; null when the value is acceptable. */
    private function malformed(string $field, string $value): ?string
    {
        $formats = (array) ($this->rules['formats'] ?? []);
        $spec = $formats[$field] ?? null;
        if (!\is_array($spec)) {
            return null;
        }
        if (isset($spec['length']) && \strlen($value) !== (int) $spec['length']) {
            return 'bad_' . $field;
        }
        if (isset($spec['pattern']) && \preg_match('/' . (string) $spec['pattern'] . '/', $value) !== 1) {
            return 'bad_' . $field;
        }
        if (isset($spec['schemes'])) {
            $ok = false;
            foreach ((array) $spec['schemes'] as $scheme) {
                if (\str_starts_with($value, (string) $scheme)) {
                    $ok = true;
                    break;
                }
            }
            if (!$ok) {
                return 'bad_' . $field;
            }
        }

        return null;
    }

    /** @param array<string, mixed> $license */
    private function expired(array $license, string $today): bool
    {
        $expires = \trim((string) ($license['expires_at'] ?? ''));
        if ($expires === '') {
            return false;
        }
        if (\DateTimeImmutable::createFromFormat('Y-m-d', $expires) === false) {
            return false; // reported as bad_expires_at by malformed()
        }

        return $expires < $today;
    }

    /**
     * allow_origins is the embed allow-list a buyer sets per work. A wildcard would let any site
     * hotlink a licensed asset, which is how a clean install ends up serving someone else's game.
     *
     * @param array<string, mixed> $license
     *
     * @return list<array{code: string, severity: string, detail: string}>
     */
    private function originFindings(array $license): array
    {
        $raw = \trim((string) ($license['allow_origins'] ?? ''));
        if ($raw === '') {
            return [];
        }
        $policy = (array) ($this->rules['origins'] ?? []);
        $separator = (string) ($policy['separator'] ?? ',');
        $origins = \array_values(\array_filter(\array_map('trim', \explode($separator, $raw))));
        $findings = [];
        if ((bool) ($policy['wildcard_allowed'] ?? false) === false && \in_array('*', $origins, true)) {
            $findings[] = $this->finding('wildcard_origin', self::SEVERITY_BLOCK, $raw);
        }
        $max = (int) ($policy['max'] ?? 8);
        if ($max > 0 && \count($origins) > $max) {
            $findings[] = $this->finding('too_many_origins', self::SEVERITY_WARN, (string) \count($origins));
        }

        return $findings;
    }

    /**
     * @param array<string, mixed> $license
     * @param array<string, mixed> $spec
     * @param array<string, mixed> $ctx
     *
     * @return list<array{code: string, severity: string, detail: string}>
     */
    private function warnings(array $license, array $spec, string $type, DateTimeImmutable $at, array $ctx): array
    {
        $findings = [];
        if ((bool) ($spec['copyleft'] ?? false) && (bool) ($spec['forbidden'] ?? false) === false) {
            $findings[] = $this->finding('copyleft_review', self::SEVERITY_WARN, $type);
        }
        if (\trim((string) ($license['commit_sha'] ?? '')) !== '' && \trim((string) ($license['upstream_repo'] ?? '')) === '') {
            $findings[] = $this->finding('unpinned_upstream', self::SEVERITY_WARN, (string) $license['commit_sha']);
        }
        if (\trim((string) ($license['captured_at'] ?? '')) === '') {
            $findings[] = $this->finding('no_capture_date', self::SEVERITY_WARN, $type);
        }
        $gameProvider = \trim((string) ($ctx['game_provider'] ?? ''));
        if ($gameProvider !== '' && $gameProvider !== \trim((string) ($license['provider'] ?? ''))) {
            $findings[] = $this->finding('provider_mismatch', self::SEVERITY_WARN, $gameProvider);
        }
        $expires = \trim((string) ($license['expires_at'] ?? ''));
        if ($expires !== '' && \DateTimeImmutable::createFromFormat('Y-m-d', $expires) !== false) {
            $days = (int) ($this->rules['expiry']['warn_days_before'] ?? 30);
            $soon = $at->modify('+' . $days . ' days')->format('Y-m-d');
            if ($expires >= $at->format('Y-m-d') && $expires <= $soon) {
                $findings[] = $this->finding('expires_soon', self::SEVERITY_WARN, $expires);
            }
        }

        return $findings;
    }

    /** @param array<string, mixed> $ctx */
    private static function clock(array $ctx): DateTimeImmutable
    {
        $at = $ctx['at'] ?? null;
        if ($at instanceof DateTimeImmutable) {
            return $at;
        }

        return new DateTimeImmutable('now', new DateTimeZone('UTC'));
    }
}
