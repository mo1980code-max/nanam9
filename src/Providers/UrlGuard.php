<?php

declare(strict_types=1);

namespace Nawras\Providers;

use RuntimeException;

/**
 * The gate every outbound fetch passes through.
 *
 * Marketplace arcade scripts let the admin paste a feed URL and then `file_get_contents()` it from
 * the server. On a VPS that is an SSRF primitive: `http://169.254.169.254/latest/meta-data/` hands
 * over the cloud instance's credentials, `http://127.0.0.1:3306/` probes the database port, and a
 * DNS name that resolves to `10.0.0.5` walks the private network. This class refuses all of it
 * BEFORE anything is fetched, including the encodings that dodge a naive string check.
 *
 * What "blocked" means here (and tools/prove_runtime.py proof E pins every one of these):
 *   - any scheme but http/https (file://, gopher://, dict://, php:// …);
 *   - userinfo in the URL (`http://user@host` — the classic parser-confusion bypass);
 *   - a port outside 80/443;
 *   - a literal IP inside any reserved range, in dotted, decimal, octal or hex form;
 *   - a hostname whose DNS answer contains ANY address in a reserved range;
 *   - `localhost` and the `.local` / `.internal` / `.localhost` suffixes.
 *
 * The range lists are duplicated in tools/prove_runtime.py on purpose, and tools/verify_php.py
 * fails the build when the two lists differ — a range that exists only in PHP is a range the proof
 * never tested.
 */
final class UrlGuard
{
    public const ALLOWED_SCHEMES = ['http', 'https'];

    public const ALLOWED_PORTS = [80, 443];

    public const MAX_REDIRECTS = 3;

    public const MAX_BYTES = 8388608; // 8 MiB — a feed is kilobytes, not a disk image

    public const ALLOWED_TYPES = ['application/json', 'text/plain'];

    /** Reserved IPv4 space. Never fetchable, whatever the operator typed. */
    public const BLOCKED_V4 = [
        '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
        '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15',
        '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
    ];

    /** Reserved IPv6 space, including the NAT64 prefix that can smuggle an IPv4 literal. */
    public const BLOCKED_V6 = [
        '::/128', '::1/128', '64:ff9b::/96', '100::/64', '2001:db8::/32', 'fc00::/7',
        'fe80::/10', 'ff00::/8',
    ];

    public const BLOCKED_HOSTS = ['localhost'];

    public const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.intranet'];

    /** @param bool $resolve false in unit contexts where DNS must not be touched */
    public function __construct(private readonly bool $resolve = true)
    {
    }

    /**
     * Judges a URL without fetching it.
     *
     * @return array{ok: bool, reason: string, host: string, port: int, ips: list<string>}
     */
    public function inspect(string $url): array
    {
        $url = \trim($url);
        if ($url === '') {
            return $this->verdict(false, 'empty_url', '', 0, []);
        }
        $parts = \parse_url($url);
        if ($parts === false) {
            return $this->verdict(false, 'unparsable', '', 0, []);
        }
        // Scheme first: `php://input` and `file:///etc/passwd` have no host at all, and checking
        // the host first would report "unparsable" instead of the reason that actually matters.
        $scheme = \strtolower((string) ($parts['scheme'] ?? ''));
        if (!\in_array($scheme, self::ALLOWED_SCHEMES, true)) {
            return $this->verdict(false, 'scheme_not_allowed', (string) ($parts['host'] ?? ''), 0, []);
        }
        if (!isset($parts['host']) || $parts['host'] === '') {
            return $this->verdict(false, 'no_host', '', 0, []);
        }
        if (isset($parts['user']) || isset($parts['pass'])) {
            return $this->verdict(false, 'userinfo_not_allowed', (string) $parts['host'], 0, []);
        }
        $port = (int) ($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
        if (!\in_array($port, self::ALLOWED_PORTS, true)) {
            return $this->verdict(false, 'port_not_allowed', (string) $parts['host'], $port, []);
        }

        $host = \strtolower((string) $parts['host']);
        $bare = \trim($host, '[]');
        if ($host !== $bare || \str_contains($host, ':')) {
            $ip = self::normalizeIp($bare);
            if ($ip === null) {
                return $this->verdict(false, 'unparsable_host', $host, $port, []);
            }

            return $this->verdict(!$this->isBlockedIp($ip), 'ip_blocked', $host, $port, [$ip]);
        }
        if (\in_array($host, self::BLOCKED_HOSTS, true)) {
            return $this->verdict(false, 'host_blocked', $host, $port, []);
        }
        foreach (self::BLOCKED_SUFFIXES as $suffix) {
            if (\str_ends_with($host, $suffix)) {
                return $this->verdict(false, 'host_blocked', $host, $port, []);
            }
        }

        $ip = self::normalizeIp($host);
        if ($ip !== null) {
            return $this->verdict(!$this->isBlockedIp($ip), 'ip_blocked', $host, $port, [$ip]);
        }

        $ips = $this->resolve ? $this->lookup($host) : [];
        if ($this->resolve && $ips === []) {
            return $this->verdict(false, 'unresolvable', $host, $port, []);
        }
        foreach ($ips as $resolved) {
            if ($this->isBlockedIp($resolved)) {
                return $this->verdict(false, 'dns_blocked', $host, $port, $ips);
            }
        }

        return $this->verdict(true, '', $host, $port, $ips);
    }

    /** Throws unless the URL is safe; returns the URL to fetch. */
    public function assertSafe(string $url): string
    {
        $result = $this->inspect($url);
        if ($result['ok'] === false) {
            throw new RuntimeException("Refusing to fetch '{$url}': {$result['reason']}");
        }

        return $url;
    }

    /** True when an IP literal (already normalized) falls in a reserved range. */
    public function isBlockedIp(string $ip): bool
    {
        $packed = @\inet_pton($ip);
        if ($packed === false) {
            return true; // not an IP we understand — refuse rather than guess
        }
        $bits = \strlen($packed) * 8;
        $ranges = $bits === 32 ? self::BLOCKED_V4 : self::BLOCKED_V6;
        foreach ($ranges as $range) {
            if (self::inRange($packed, $range, $bits)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Accepts the forms curl and browsers accept, not just dotted quads:
     * `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1` and `::ffff:127.0.0.1` all mean 127.0.0.1.
     * A guard that only string-matches "127.0.0.1" is decorative.
     */
    public static function normalizeIp(string $host): ?string
    {
        $host = \trim($host, '[]');
        if ($host === '') {
            return null;
        }
        if (\str_contains($host, ':')) {
            $mapped = \strtolower($host);
            if (\str_starts_with($mapped, '::ffff:')) {
                $tail = \substr($mapped, 7);
                $v4 = self::normalizeIp($tail);

                return $v4 !== null && \substr_count($v4, '.') === 3 ? $v4 : (\inet_pton($mapped) === false ? null : $mapped);
            }

            return \inet_pton($mapped) === false ? null : $mapped;
        }
        if (\filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) {
            return $host;
        }
        $parts = \explode('.', $host);
        if (\count($parts) > 4) {
            return null;
        }
        $numbers = [];
        foreach ($parts as $part) {
            $value = self::parseNumeric($part);
            if ($value === null) {
                return null;
            }
            $numbers[] = $value;
        }
        // 127.1 == 127.0.0.1, 2130706433 == 127.0.0.1 — the short forms POSIX/inet_aton accept
        $count = \count($numbers);
        $limit = $count === 1 ? 0xFFFFFFFF : ($count === 2 ? 0xFFFFFF : ($count === 3 ? 0xFFFF : 0xFF));
        if ($numbers[$count - 1] > $limit) {
            return null;
        }
        // inet_aton semantics: every part but the last is ONE byte at the top, and the last part
        // fills the remainder. So 127.1 == 127.0.0.1 and 2130706433 == 127.0.0.1. The obvious
        // formula 8 * (4 - count + index) puts the last part at the TOP instead of the bottom and
        // turns 127.1 into 1.0.127.0 — a public address, i.e. an open loopback hole.
        $packed = 0;
        foreach ($numbers as $index => $value) {
            $shift = $index === $count - 1 ? 0 : 8 * (3 - $index);
            $packed |= $value << $shift;
        }

        return \long2ip($packed & 0xFFFFFFFF);
    }

    private static function parseNumeric(string $part): ?int
    {
        if ($part === '') {
            return null;
        }
        if (\preg_match('/^0[xX][0-9a-fA-F]+$/', $part)) {
            return (int) \hexdec(\substr($part, 2));
        }
        if (\preg_match('/^0[0-7]+$/', $part)) {
            return (int) \octdec(\substr($part, 1));
        }
        if (\preg_match('/^[0-9]+$/', $part)) {
            return (int) $part;
        }

        return null;
    }

    /** @param non-empty-string $packed */
    private static function inRange(string $packed, string $range, int $bits): bool
    {
        [$network, $length] = \explode('/', $range);
        $netPacked = \inet_pton((string) $network);
        if ($netPacked === false || \strlen($netPacked) * 8 !== $bits) {
            return false;
        }
        $length = (int) $length;
        $full = \str_repeat("\xFF", intdiv($length, 8));
        $remainder = $length % 8;
        if ($remainder > 0) {
            $full .= \chr(0xFF << (8 - $remainder) & 0xFF);
        }
        $mask = \str_pad($full, intdiv($bits, 8), "\x00");

        return ($packed & $mask) === ($netPacked & $mask);
    }

    /** @return list<string> */
    private function lookup(string $host): array
    {
        $ips = [];
        $v4 = @\gethostbynamel($host);
        if (\is_array($v4)) {
            foreach ($v4 as $ip) {
                $ips[] = (string) $ip;
            }
        }
        $v6 = @\dns_get_record($host, DNS_AAAA);
        if (\is_array($v6)) {
            foreach ($v6 as $record) {
                if (isset($record['ipv6'])) {
                    $ips[] = (string) $record['ipv6'];
                }
            }
        }

        return \array_values(\array_unique($ips));
    }

    /**
     * @param list<string> $ips
     *
     * @return array{ok: bool, reason: string, host: string, port: int, ips: list<string>}
     */
    private function verdict(bool $ok, string $reason, string $host, int $port, array $ips): array
    {
        return ['ok' => $ok, 'reason' => $ok ? '' : $reason, 'host' => $host, 'port' => $port, 'ips' => $ips];
    }
}
