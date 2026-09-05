<?php

declare(strict_types=1);

/**
 * Front controller — the only PHP file that lives inside the docroot.
 * Point Apache/nginx (or `php -S 0.0.0.0:8080 -t public`) at public/ and everything else,
 * including config/ and db/, stays outside the web root.
 */

require \dirname(__DIR__) . '/src/App.php';

$method = \strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$path = (string) (\parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/');

// Static assets. The realpath prefix test is the whole security story here: without it
// /assets/../../config/config.php would hand over the signing key.
$candidate = \realpath(__DIR__ . $path);
$docroot = (string) \realpath(__DIR__);
if ($path !== '/' && \is_string($candidate) && \str_starts_with($candidate, $docroot . DIRECTORY_SEPARATOR)) {
    $types = ['js' => 'application/javascript', 'json' => 'application/json', 'css' => 'text/css'];
    $ext = \strtolower((string) \pathinfo($candidate, PATHINFO_EXTENSION));
    \header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream') . '; charset=utf-8');
    \readfile($candidate);
    exit;
}

Nawras\App::boot()->router()->dispatch($method, $path)->send();
