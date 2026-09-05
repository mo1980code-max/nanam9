<?php

declare(strict_types=1);

namespace Nawras\Http;

/**
 * Value object for an HTTP response. Immutable on purpose: controllers return these,
 * the kernel echoes them — nothing mutates a response halfway out the door.
 */
final class Response
{
    /** @var array<int, array{0: string, 1: string}> */
    private array $headers = [];

    public function __construct(
        private string $body = '',
        private int $status = 200,
        private string $contentType = 'text/html; charset=utf-8',
    ) {
    }

    public static function json(array|object $data, int $status = 200): self
    {
        return new self(
            (string) \json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            $status,
            'application/json; charset=utf-8'
        );
    }

    public static function text(string $body, int $status = 200): self
    {
        return new self($body, $status, 'text/plain; charset=utf-8');
    }

    public static function html(string $body, int $status = 200): self
    {
        return new self($body, $status, 'text/html; charset=utf-8');
    }

    public static function redirect(string $to, int $status = 302): self
    {
        $res = new self('', $status);
        $res->headers[] = ['Location', $to];

        return $res;
    }

    public function withHeader(string $name, string $value): self
    {
        $clone = clone $this;
        $clone->headers[] = [\trim($name), \trim($value)];

        return $clone;
    }

    public function body(): string
    {
        return $this->body;
    }

    public function status(): int
    {
        return $this->status;
    }

    public function contentType(): string
    {
        return $this->contentType;
    }

    /** @return array<int, array{0: string, 1: string}> */
    public function headers(): array
    {
        return $this->headers;
    }

    /** Sends the response and returns true (so a router can stop after echoing). */
    public function send(): bool
    {
        \http_response_code($this->status);
        \header('Content-Type: ' . $this->contentType);
        foreach ($this->headers as [$name, $value]) {
            \header($name . ': ' . $value);
        }
        echo $this->body;

        return true;
    }
}
