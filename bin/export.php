#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * php bin/export.php [dist] [--site-name="Nawras Arcade"]
 *
 * Writes the static bundle. A game the licence auditor refuses in export mode gets NO page:
 * see src/Export/StaticExporter.php. Exits 1 when nothing was exportable, so an empty bundle
 * cannot be published by accident.
 */

use Nawras\App;
use Nawras\Export\StaticExporter;

require \dirname(__DIR__) . '/src/autoload.php';

$argv = $_SERVER['argv'] ?? [];
$root = \dirname(__DIR__);
$dist = $root . '/dist';
$siteName = 'Nawras Arcade';
foreach ($argv as $arg) {
    if (\str_starts_with((string) $arg, '--site-name=')) {
        $siteName = (string) \substr((string) $arg, 12);
        continue;
    }
    if (\str_starts_with((string) $arg, '--') || $arg === 'bin/export.php') {
        continue;
    }
    $dist = (string) $arg;
}

$app = App::boot();
$exporter = new StaticExporter($app->licensing(), $dist, $root . '/db/license_rules.json', $siteName);
$report = $exporter->export();

\printf("  exported %d game(s) · refused %d · %d bytes · rules v%d\n",
    $report['exported'], $report['blocked'], $report['bytes'], $report['rules_version']);
\printf("  rules sha256 %s\n", $report['rules_file_sha256']);
foreach ($report['refusals'] as $refusal) {
    \printf("  ✗ %-20s %s (%s)\n", $refusal['slug'], $refusal['verdict'],
        \implode(', ', (array) $refusal['reasons']));
}
if (!$report['ok']) {
    echo "\n  nothing exportable — no bundle written to publish\n";
    exit(1);
}
\printf("\n  bundle ready in %s\n", $dist);
exit(0);
