<?php

/**
 * Sample configuration. Copy to config/config.php and fill in.
 * config.php is gitignored; config.sample.php is what ships.
 */

return [
    // 32+ random bytes — signs score page-tokens and leaderboard rows. Never commit a real one.
    'secret' => 'change-me-to-32-plus-random-bytes',

    'db' => [
        // 'mysql' for production buyers, 'sqlite' for the zero-config quick start
        'driver' => 'sqlite',
        'sqlite_path' => __DIR__ . '/../var/arcade.sqlite',

        // 'driver' => 'mysql',
        // 'host' => '127.0.0.1',
        // 'port' => 3306,
        // 'database' => 'arcade',
        // 'username' => 'arcade',
        // 'password' => '',
    ],

    'site' => [
        'name_ar' => 'أركيد نورس',
        'name_en' => 'Nawras Arcade',
        'base_url' => 'https://example.com',
    ],
];
