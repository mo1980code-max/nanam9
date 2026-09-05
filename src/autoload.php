<?php

declare(strict_types=1);

/**
 * Minimal PSR-4-style autoloader: Nawras\ -> src/.
 * No composer required to run; composer.json exists for buyers who want it.
 */
\spl_autoload_register(static function (string $class): void {
    $prefix = 'Nawras\\';
    if (!\str_starts_with($class, $prefix)) {
        return;
    }
    $rel = \substr($class, \strlen($prefix));
    $file = __DIR__ . '/' . \str_replace('\\', '/', $rel) . '.php';
    if (\is_file($file)) {
        require $file;
    }
});
