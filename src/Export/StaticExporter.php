<?php

declare(strict_types=1);

namespace Nawras\Export;

use Nawras\Licensing\LicenseAuditor;
use RuntimeException;

/**
 * Writes the redistributable bundle: one page per game the licence auditor cleared in export
 * mode, the audit manifest next to it, and the exact policy bytes the decision was made with.
 *
 * The rule this class exists to enforce is a negative one — **a blocked game produces no file**.
 * Not a page with a warning, not a page behind a flag: no file at all. A buyer who unzips the
 * bundle should find it impossible to ship something the auditor refused, because the thing is
 * not there. The manifest still lists every refusal with its reasons, so the decision is
 * auditable without the export being exploitable.
 *
 * Two hashes are written into the manifest:
 *   rules_file_sha256  sha256 of the policy bytes copied into dist/ (byte-exact, checkable in JS)
 *   rules_sha256       the auditor's own hash of the decoded policy (content identity)
 * A static host can recompute the first from the file it serves and know it is showing the same
 * rules the audit ran against.
 */
final class StaticExporter
{
    public function __construct(
        private readonly LicenseAuditor $licenses,
        private readonly string $distDir,
        private readonly string $rulesSource,
        private readonly string $siteName = 'Nawras Arcade',
    ) {
    }

    /**
     * @return array{ok: bool, exported: int, blocked: int, bytes: int, rules_file_sha256: string,
     *               rules_version: int, files: array<int, string>, refusals: array<int, array<string, mixed>>}
     */
    public function export(?DateTimeImmutable $at = null): array
    {
        $manifest = $this->licenses->manifest($at);

        $rulesBytes = (string) \file_get_contents($this->rulesSource);
        $decoded = \json_decode($rulesBytes, true);
        if (!\is_array($decoded)) {
            throw new RuntimeException("Licence policy is not valid JSON ({$this->rulesSource}).");
        }
        // Content identity: the policy the auditor judged with must be the policy being shipped.
        // Compared on the re-encoded decode so that whitespace in the file cannot mask a change.
        if (\hash('sha256', (string) \json_encode($decoded)) !== (string) $manifest['rules_sha256']) {
            throw new RuntimeException(
                'The policy file on disk is not the policy the audit ran against; refusing to export.'
            );
        }

        $this->ensureDir($this->distDir);
        $this->ensureDir($this->distDir . '/assets');

        $files = [];
        $refusals = [];
        $bytes = 0;
        $exported = 0;

        foreach ((array) $manifest['games'] as $game) {
            $slug = (string) $game['slug'];
            if ((bool) $game['exportable'] === false) {
                // No page, no partial page, no page behind a flag. The reason lives in the manifest.
                $refusals[] = [
                    'slug' => $slug,
                    'verdict' => (string) $game['verdict'],
                    'license_type' => $game['license_type'],
                    'reasons' => $game['reasons'],
                ];
                continue;
            }
            $html = $this->page($slug, $game);
            $path = $this->distDir . '/game/' . $slug . '/index.html';
            $this->ensureDir(\dirname($path));
            $written = (int) \file_put_contents($path, $html);
            $files[] = '/game/' . $slug . '/index.html';
            $bytes += $written;
            $exported++;
        }

        $rulesTarget = $this->distDir . '/assets/license-rules.json';
        $rulesWritten = (int) \file_put_contents($rulesTarget, $rulesBytes);
        $files[] = '/assets/license-rules.json';
        $bytes += $rulesWritten;

        $manifest['rules_file_sha256'] = \hash('sha256', $rulesBytes);
        $manifest['site'] = $this->siteName;
        $manifest['exported'] = $exported;
        $manifest['refusals'] = $refusals;

        $manifestJson = (string) \json_encode(
            $manifest,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT
        );
        $manifestWritten = (int) \file_put_contents($this->distDir . '/license-manifest.json', $manifestJson);
        $files[] = '/license-manifest.json';
        $bytes += $manifestWritten;

        $indexHtml = $this->index($manifest, $exported);
        $indexWritten = (int) \file_put_contents($this->distDir . '/index.html', $indexHtml);
        $files[] = '/index.html';
        $bytes += $indexWritten;

        return [
            'ok' => $exported > 0,
            'exported' => $exported,
            'blocked' => \count($refusals),
            'bytes' => $bytes,
            'rules_file_sha256' => $manifest['rules_file_sha256'],
            'rules_version' => (int) $manifest['rules_version'],
            'files' => $files,
            'refusals' => $refusals,
        ];
    }

    /** @param array<string, mixed> $game */
    public function page(string $slug, array $game): string
    {
        $attribution = $game['attribution'] === null ? '' : (string) $game['attribution'];
        $type = (string) ($game['license_type'] ?? '');
        $escapedSlug = \htmlspecialchars($slug, ENT_QUOTES, 'UTF-8');
        $escapedName = \htmlspecialchars($this->siteName, ENT_QUOTES, 'UTF-8');
        $escapedType = \htmlspecialchars($type, ENT_QUOTES, 'UTF-8');
        $escapedAttribution = \htmlspecialchars($attribution, ENT_QUOTES, 'UTF-8');

        return '<!doctype html>' . "\n"
            . '<html lang="ar" dir="rtl">' . "\n"
            . '<head><meta charset="utf-8"><title>' . $escapedSlug . ' · ' . $escapedName . '</title></head>' . "\n"
            . '<body data-game="' . $escapedSlug . '" data-license="' . $escapedType . '">' . "\n"
            . '<h1>' . $escapedSlug . '</h1>' . "\n"
            . '<div id="game" data-src="' . $escapedSlug . '.html"></div>' . "\n"
            // The attribution is part of the exported page, not a footnote a buyer has to add:
            // the licence is satisfied by the file itself.
            . '<footer class="attribution" lang="en" dir="ltr">' . $escapedAttribution . '</footer>' . "\n"
            . '<script>/* rules: assets/license-rules.json · hash checked at build time */</script>' . "\n"
            . '</body></html>' . "\n";
    }

    /** @param array<string, mixed> $manifest */
    private function index(array $manifest, int $exported): string
    {
        $counts = (array) $manifest['counts'];
        $name = \htmlspecialchars($this->siteName, ENT_QUOTES, 'UTF-8');
        $rows = '';
        foreach ((array) $manifest['games'] as $game) {
            if ((bool) $game['exportable'] === false) {
                continue;
            }
            $slug = \htmlspecialchars((string) $game['slug'], ENT_QUOTES, 'UTF-8');
            $rows .= '<li><a href="/game/' . $slug . '/">' . $slug . '</a></li>' . "\n";
        }

        return '<!doctype html>' . "\n"
            . '<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>' . $name . '</title></head>' . "\n"
            . '<body>' . "\n"
            . '<h1>' . $name . '</h1>' . "\n"
            . '<p>ألعاب مُصدَّرة: ' . $exported
            . ' · مسموح: ' . (int) ($counts['ok'] ?? 0)
            . ' · تحذير: ' . (int) ($counts['warn'] ?? 0)
            . ' · محظور: ' . (int) ($counts['blocked'] ?? 0) . '</p>' . "\n"
            . '<ul>' . "\n" . $rows . '</ul>' . "\n"
            . '<p lang="en" dir="ltr">Exported under licence rules v' . (int) $manifest['rules_version']
            . ' · manifest: <a href="/license-manifest.json">license-manifest.json</a></p>' . "\n"
            . '</body></html>' . "\n";
    }

    private function ensureDir(string $dir): void
    {
        if (\is_dir($dir)) {
            return;
        }
        if (!\mkdir($dir, 0775, true) && !\is_dir($dir)) {
            throw new RuntimeException("Cannot create export directory ({$dir}).");
        }
    }
}
