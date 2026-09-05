<?php

declare(strict_types=1);

namespace Nawras\Install;

use Nawras\Db\Connection;
use Nawras\Db\Migrator;
use RuntimeException;

/**
 * First-run installer. Turns a unzipped copy of this package into a running site without
 * asking the operator to run five commands in the right order.
 *
 * Order matters and is not negotiable:
 *   1. environment   — PHP version + extensions, before touching any file
 *   2. config        — written from the sample, with a REAL random secret; the shipped
 *                      placeholder is never accepted because every install would then sign
 *                      leaderboard tokens with a public string
 *   3. migrate       — Migrator, which is idempotent and dialect-aware
 *   4. seed          — the settings rows the admin panel reads, and the first admin account
 *   5. self-check    — schema version == Migrator::CURRENT and every table in db/schema.json
 *                      actually exists; an install that cannot prove its own schema is a
 *                      support ticket waiting to happen
 *
 * Every step is reported as pass/fail with a reason, and the run stops at the first failure:
 * a half-installed site that pretends to work is worse than a clear error.
 */
final class Installer
{
    public const MIN_PHP = '8.1.0';

    /** Extensions the engine genuinely calls into; a missing one is a hard failure. */
    public const REQUIRED_EXTENSIONS = ['pdo', 'json', 'mbstring', 'hash'];

    /**
     * Settings rows the admin reads. Seeded with DO NOTHING, not DO UPDATE: re-running the
     * installer after an upgrade must never overwrite copy the operator already changed. A setting
     * added in a later version is still inserted, because it does not exist yet.
     */
    private const DEFAULT_SETTINGS = [
        ['site_name_ar', 'string', 'أركيد نورس'],
        ['site_name_en', 'string', 'Nawras Arcade'],
        ['locale_default', 'string', 'ar'],
        ['commercial', 'bool', '1'],
        ['leaderboard_default_type', 'string', 'top-week'],
    ];

    private const SQL_SETTING = 'INSERT INTO settings (key_name, value_type, value_text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key_name) DO NOTHING';

    private const SQL_ADMIN = 'INSERT INTO users (username, email, password_hash, display_name, role, locale, xp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(username) DO NOTHING';

    /** Set by the migrate step so seed and self-check reuse the same handle. */
    private ?Connection $connection = null;

    /** @param array<string, mixed> $options force|admin_user|admin_password|root */
    public function __construct(private readonly array $options = [])
    {
    }

    /**
     * @return array{ok: bool, steps: array<int, array<string, mixed>>, fatal: string|null}
     */
    public function run(): array
    {
        $steps = [];
        $fatal = null;

        $steps[] = $this->step('environment', fn (): string => $this->checkEnvironment());
        if ($steps[0]['ok'] === false) {
            return ['ok' => false, 'steps' => $steps, 'fatal' => (string) $steps[0]['detail']];
        }

        $steps[] = $this->step('config', fn (): string => $this->writeConfig());
        if ($steps[1]['ok'] === false) {
            return ['ok' => false, 'steps' => $steps, 'fatal' => (string) $steps[1]['detail']];
        }

        $config = $this->loadConfig();
        $steps[] = $this->step('migrate', function () use ($config): string {
            $db = new Connection((array) ($config['db'] ?? []));
            $migrator = new Migrator($db);
            $applied = $migrator->migrate();
            $this->connection = $db;

            return \count($applied) . ' migration step(s) applied';
        });
        if ($steps[2]['ok'] === false) {
            return ['ok' => false, 'steps' => $steps, 'fatal' => (string) $steps[2]['detail']];
        }

        $steps[] = $this->step('seed', fn (): string => $this->seed());
        $steps[] = $this->step('self_check', fn (): string => $this->selfCheck());

        foreach ($steps as $one) {
            if ($one['ok'] === false) {
                $fatal = (string) $one['detail'];
                break;
            }
        }

        return ['ok' => $fatal === null, 'steps' => $steps, 'fatal' => $fatal];
    }

    /** @return array<string, mixed> */
    private function step(string $name, callable $work): array
    {
        try {
            $detail = (string) $work();

            return ['name' => $name, 'ok' => true, 'detail' => $detail];
        } catch (\Throwable $e) {
            return ['name' => $name, 'ok' => false, 'detail' => $e->getMessage()];
        }
    }

    private function root(): string
    {
        $root = (string) ($this->options['root'] ?? '');
        if ($root !== '') {
            return \rtrim($root, '/');
        }

        return \defined('ARCADE_ROOT') ? (string) ARCADE_ROOT : \dirname(__DIR__, 2);
    }

    private function checkEnvironment(): string
    {
        if (\version_compare(PHP_VERSION, self::MIN_PHP, '<')) {
            throw new RuntimeException('PHP ' . self::MIN_PHP . '+ required, found ' . PHP_VERSION);
        }
        $missing = [];
        foreach (self::REQUIRED_EXTENSIONS as $ext) {
            if (!\extension_loaded($ext)) {
                $missing[] = $ext;
            }
        }
        if ($missing !== []) {
            throw new RuntimeException('Missing PHP extensions: ' . \implode(', ', $missing));
        }
        $drivers = \class_exists('PDO') ? \PDO::getAvailableDrivers() : [];
        if (!\in_array('mysql', $drivers, true) && !\in_array('sqlite', $drivers, true)) {
            throw new RuntimeException('PDO needs pdo_mysql or pdo_sqlite; found: ' . \implode(', ', $drivers));
        }
        $var = $this->root() . '/var';
        if (!\is_dir($var) && !\mkdir($var, 0775, true) && !\is_dir($var)) {
            throw new RuntimeException("Cannot create {$var} — check directory permissions");
        }
        if (!\is_writable($var)) {
            throw new RuntimeException("{$var} is not writable by the web server user");
        }

        return 'PHP ' . PHP_VERSION . ' · pdo drivers: ' . \implode(', ', $drivers);
    }

    private function writeConfig(): string
    {
        $target = $this->root() . '/config/config.php';
        $sample = $this->root() . '/config/config.sample.php';
        if (\is_file($target) && (bool) ($this->options['force'] ?? false) === false) {
            return 'config/config.php already exists — left untouched';
        }
        if (!\is_file($sample)) {
            throw new RuntimeException("config/config.sample.php is missing from this package ({$sample})");
        }
        /** @var array<string, mixed> $config */
        $config = require $sample;
        // The shipped secret is a placeholder on purpose. Installing it verbatim would give every
        // buyer the same signing key, so leaderboard tokens from one site would validate on another.
        $config['secret'] = $this->randomSecret();
        $php = "<?php\n\n// Generated by Nawras\\Install\\Installer. Gitignored. Do not commit.\n\nreturn "
            . \var_export($config, true) . ";\n";
        if (\file_put_contents($target, $php, 0640) === false) {
            throw new RuntimeException("Cannot write {$target}");
        }

        return 'config/config.php written with a fresh 32-byte secret';
    }

    private function randomSecret(): string
    {
        $bytes = \random_bytes(32);

        return \bin2hex($bytes);
    }

    /** @return array<string, mixed> */
    private function loadConfig(): array
    {
        $file = $this->root() . '/config/config.php';
        if (!\is_file($file)) {
            throw new RuntimeException("Config was not written ({$file})");
        }
        /** @var array<string, mixed> $config */
        $config = require $file;
        if (\strlen((string) ($config['secret'] ?? '')) < 32) {
            throw new RuntimeException('Refusing to continue: the configured secret is shorter than 32 bytes');
        }

        return $config;
    }

    private function seed(): string
    {
        $db = $this->connection();
        $stamp = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d H:i:s');
        $settings = 0;
        foreach (self::DEFAULT_SETTINGS as [$key, $type, $value]) {
            $settings += $db->run(self::SQL_SETTING, [$key, $type, $value, $stamp]);
        }

        $user = (string) ($this->options['admin_user'] ?? 'admin');
        $password = (string) ($this->options['admin_password'] ?? '');
        if ($password === '') {
            $password = \bin2hex(\random_bytes(9));
        }
        if (\strlen($password) < 8) {
            throw new RuntimeException('The admin password must be at least 8 characters');
        }
        $hash = \password_hash($password, PASSWORD_DEFAULT);
        $db->run(self::SQL_ADMIN, [$user, null, $hash, $user, 'admin', 'ar', $stamp, $stamp]);

        return \count(self::DEFAULT_SETTINGS) . ' setting(s) upserted · admin "' . $user . '" ensured';
    }

    private function selfCheck(): string
    {
        $db = $this->connection();
        $migrator = new Migrator($db);
        $version = $migrator->version();
        if ($version !== Migrator::CURRENT) {
            throw new RuntimeException(
                'Schema is at version ' . $version . ' but this build expects ' . Migrator::CURRENT
            );
        }
        $schemaFile = $this->root() . '/db/schema.json';
        $decoded = \json_decode((string) \file_get_contents($schemaFile), true);
        if (!\is_array($decoded) || !isset($decoded['tables']) || !\is_array($decoded['tables'])) {
            throw new RuntimeException("db/schema.json is unreadable ({$schemaFile})");
        }
        $expected = \array_keys((array) $decoded['tables']);
        $present = $migrator->tables();
        $missing = \array_values(\array_diff($expected, $present));
        if ($missing !== []) {
            throw new RuntimeException('Schema is missing table(s): ' . \implode(', ', $missing));
        }

        return 'schema v' . $version . ' · ' . \count($present) . ' tables present, none missing';
    }

    private function connection(): Connection
    {
        if ($this->connection === null) {
            throw new RuntimeException('Installer has no database connection; run() must create one first');
        }

        return $this->connection;
    }
}
