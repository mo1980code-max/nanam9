<?php

declare(strict_types=1);

namespace Nawras;

use Nawras\Db\Connection;
use Nawras\Gamify\Leaderboard;
use Nawras\Gamify\Signer;

if (!\defined('ARCADE_ROOT')) {
    \define('ARCADE_ROOT', \dirname(__DIR__));
}

/**
 * Composition root. Builds the object graph once, exposes it to Routes.
 * Everything a controller needs is reachable from here — no service locator strings,
 * no container magic a buyer has to debug at 2am on shared hosting.
 */
final class App
{
    private Connection $db;

    private Leaderboard $board;

    private Signer $signer;

    public function __construct(private readonly array $config)
    {
        require_once __DIR__ . '/autoload.php';
        $this->db = new Connection((array) ($config['db'] ?? []));
        $secret = (string) ($config['secret'] ?? '');
        $this->signer = new Signer($secret);
        $this->board = new Leaderboard($this->db, $secret);
    }

    public static function boot(?array $config = null): self
    {
        $config ??= self::loadConfig();

        return new self($config);
    }

    /** @return array<string, mixed> */
    public static function loadConfig(): array
    {
        $file = ARCADE_ROOT . '/config/config.php';
        if (!\is_file($file)) {
            $file = ARCADE_ROOT . '/config/config.sample.php';
        }
        if (!\is_file($file)) {
            throw new \RuntimeException('No config file found (config/config.php).');
        }
        /** @var array<string, mixed> $config */
        $config = require $file;

        return $config;
    }

    public function db(): Connection
    {
        return $this->db;
    }

    public function leaderboard(): Leaderboard
    {
        return $this->board;
    }

    public function signer(): Signer
    {
        return $this->signer;
    }

    public function secret(): string
    {
        return (string) ($this->config['secret'] ?? '');
    }

    public function router(): Routes
    {
        return Routes::register($this);
    }
}
