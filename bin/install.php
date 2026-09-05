#!/usr/bin/env php
<?php

declare(strict_types=1);

/**
 * php bin/install.php [--force] [--admin-user=NAME]
 *
 * Idempotent: run it again after an upgrade and it applies only the missing migrations.
 * Exits 0 when every step passed, 1 on the first failure — a CI job can gate a deploy on it.
 */

use Nawras\Install\Installer;

require \dirname(__DIR__) . '/src/autoload.php';

$argv = $_SERVER['argv'] ?? [];
$options = ['force' => \in_array('--force', $argv, true)];
foreach ($argv as $arg) {
    if (\str_starts_with((string) $arg, '--admin-user=')) {
        $options['admin_user'] = (string) \substr((string) $arg, 13);
    }
}

$report = (new Installer($options))->run();

foreach ($report['steps'] as $step) {
    \printf("  %s %-12s %s\n", $step['ok'] ? '✓' : '✗', $step['name'], $step['detail']);
}
if ($report['ok']) {
    echo "\n  install complete · log in with the admin user and change its password\n";
    exit(0);
}
\printf("\n  install FAILED at: %s\n", (string) $report['fatal']);
exit(1);
