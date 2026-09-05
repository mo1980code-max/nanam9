<?php

declare(strict_types=1);

namespace Nawras;

use Nawras\Front\SiteController;
use Nawras\Http\Response;

/**
 * Route table + the tiny dispatcher that serves it.
 *
 * Public API surface (CloudArcade-compatible names on the read side):
 *   GET  /api/leaderboard?game=slug&type=top-week&amount=10   (eight types, see Gamify\Buckets)
 *   GET  /api/license?game=slug    provenance + attribution owed for one game (Licensing)
 *   POST /api/score        {game, alias?, score, ts, sig}
 *   POST /api/play         {game}
 *   GET  /assets/ca-compat.js   drop-in bridge for games authored against ca_api
 *
 * The dispatcher is deliberately ~40 lines: every marketplace script buries its router in
 * three layers of facade; here one switch statement answers "what runs for this URL".
 */
final class Routes
{
    /** @var array<string, array<string, callable>> */
    private array $routes = ['GET' => [], 'POST' => []];

    public function get(string $path, callable $handler): void
    {
        $this->routes['GET'][$path] = $handler;
    }

    public function post(string $path, callable $handler): void
    {
        $this->routes['POST'][$path] = $handler;
    }

    public static function register(App $app): self
    {
        $router = new self();
        $db = $app->db();
        $board = $app->leaderboard();
        $site = new SiteController($db, $board, $app->signer(), $app->licensing(), $app->isCommercial());

        $router->get('/api/leaderboard', fn (): Response => $site->leaderboard());
        $router->get('/api/license', fn (): Response => $site->license());
        $router->post('/api/score', fn (): Response => $site->submitScore());
        $router->post('/api/play', fn (): Response => $site->play());

        return $router;
    }

    /** @return array{0: callable, 1: int}|null handler + 404 marker */
    public function match(string $method, string $path): ?callable
    {
        return $this->routes[$method][$path] ?? null;
    }

    /** CLI/test entry: dispatch without touching superglobals. */
    public function dispatch(string $method, string $path): Response
    {
        $handler = $this->match($method, $path);
        if ($handler === null) {
            return Response::json(['ok' => false, 'error' => 'not found'], 404);
        }

        return $handler();
    }
}
