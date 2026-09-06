/**
 * SSRF guard — ported (and generalised) from the legacy PHP `UrlGuard`.
 *
 * WHY: the auto-fetch feature asks the server to GET a URL an admin typed. That
 * is a server-side request forgery primitive unless every hop is checked
 * *before* a packet leaves the machine:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/  → cloud keys
 *   http://127.0.0.1:5432/                                             → port scan
 *   http://[::ffff:127.0.0.1]/                                         → same, IPv6 spelling
 *   http://2130706433/                                                 → same, decimal spelling
 *   http://0x7f000001/                                                 → same, hex spelling
 *   http://127.1/                                                      → same, short form
 *   http://metadata.google.internal/                                   → DNS that resolves inward
 *
 * A naive `host === '127.0.0.1'` check passes every one of those. This module
 * normalises all of them to a canonical IP and tests it against the reserved
 * ranges, and then resolves DNS and tests *every* answer (a hostname whose A
 * records include an internal address is blocked even if another record is
 * public — otherwise an attacker just returns both).
 *
 * It is dependency-injected (`resolve`) so it stays isomorphic and testable:
 * the API passes `node:dns` lookups, the tests pass a table.
 */

export type GuardReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'userinfo_not_allowed'
  | 'port_not_allowed'
  | 'host_blocked'
  | 'ip_blocked'
  | 'dns_blocked'
  | 'unresolvable';

export type GuardVerdict =
  | { ok: true; url: string; host: string; port: number; ips: string[] }
  | { ok: false; reason: GuardReason; detail?: string; url: string };

export type Resolver = (hostname: string) => Promise<string[]>;

export type UrlGuardOptions = {
  resolve: Resolver;
  allowedSchemes?: string[];
  allowedPorts?: number[];
  /** extra hostnames to refuse (your own internal service names). */
  blockedHosts?: string[];
  /** dev/test escape hatch. Never true in production — the API refuses to boot with it on. */
  allowPrivate?: boolean;
};

export type UrlGuard = {
  inspect(raw: string): Promise<GuardVerdict>;
  /** Throws a typed error instead of returning a verdict. */
  assert(raw: string): Promise<{ url: string; host: string; port: number; ips: string[] }>;
  /** Pure, synchronous part: no DNS. Useful to reject the obvious cases early. */
  staticInspect(raw: string): { ok: true; url: URL; host: string; port: number } | { ok: false; reason: GuardReason; detail?: string };
};

const DEFAULT_SCHEMES = ['http:', 'https:'];
const DEFAULT_PORTS = [80, 443];

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.intranet',
  '.corp',
  '.home',
  '.private',
];

const BLOCKED_HOSTS = ['localhost', 'metadata', 'metadata.google.internal', 'instance-data'];

/** IPv4 reserved space, as [network, prefixLength]. */
export const RESERVED_IPV4: readonly [number, number][] = [
  [toIpv4Number([0, 0, 0, 0]), 8], // this-network
  [toIpv4Number([10, 0, 0, 0]), 8], // RFC1918
  [toIpv4Number([100, 64, 0, 0]), 10], // CGNAT
  [toIpv4Number([127, 0, 0, 0]), 8], // loopback
  [toIpv4Number([169, 254, 0, 0]), 16], // link-local + cloud metadata
  [toIpv4Number([172, 16, 0, 0]), 12], // RFC1918
  [toIpv4Number([192, 0, 0, 0]), 24], // IETF protocol assignments
  [toIpv4Number([192, 0, 2, 0]), 24], // TEST-NET-1
  [toIpv4Number([192, 88, 99, 0]), 24], // 6to4 relay anycast
  [toIpv4Number([192, 168, 0, 0]), 16], // RFC1918
  [toIpv4Number([198, 18, 0, 0]), 15], // benchmarking
  [toIpv4Number([198, 51, 100, 0]), 24], // TEST-NET-2
  [toIpv4Number([203, 0, 113, 0]), 24], // TEST-NET-3
  [toIpv4Number([224, 0, 0, 0]), 4], // multicast
  [toIpv4Number([240, 0, 0, 0]), 4], // reserved for future use
  [toIpv4Number([255, 255, 255, 255]), 32], // broadcast
];

const RESERVED_IPV6: readonly [bigint, number][] = [
  [0n, 128], // ::
  [1n, 128], // ::1 loopback
  [0xffffn << 96n, 96], // ::ffff:0:0/96 IPv4-mapped (checked again as IPv4)
  [0x64ff9bn << 80n, 96], // 64:ff9b::/96 NAT64
  [0x100n << 120n, 64], // 100::/64 discard-only
  [0x2001n << 112n, 32], // 2001::/32 Teredo
  [0x20010002n << 96n, 48], // 2001:2::/48 benchmarking
  [0x20010db8n << 96n, 32], // 2001:db8::/32 documentation
  [0x2002n << 112n, 16], // 2002::/16 6to4 (embeds IPv4)
  [0xfcn << 124n, 7], // fc00::/7 unique local
  [0xfe8n << 116n, 10], // fe80::/10 link-local
  [0xffn << 120n, 8], // ff00::/8 multicast
];

export function toIpv4Number(octets: [number, number, number, number] | number[]): number {
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return ((a * 256 + b) * 256 + c) * 256 + d;
}

export function ipv4ToString(value: number): string {
  const v = Math.trunc(value);
  return [Math.floor(v / 2 ** 24) % 256, Math.floor(v / 2 ** 16) % 256, Math.floor(v / 2 ** 8) % 256, v % 256].join('.');
}

function parseNumericPart(part: string): number | null {
  if (!/^[0-9a-fx]+$/i.test(part)) return null;
  try {
    if (/^0x/i.test(part)) return Number.parseInt(part.slice(2), 16);
    if (/^0\d+$/.test(part)) return Number.parseInt(part.slice(1), 8); // leading zero = octal
    if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
  } catch {
    return null;
  }
  return null;
}

/**
 * Parses every IPv4 spelling a browser/curl accepts.
 *
 * The last part carries all remaining bytes, so `127.1` is 127.0.0.1 and
 * `2130706433` is 127.0.0.1. The composition is done with multiplication by
 * 256^(bytes-in-last-part) — a shift-based version of this line (`8 * (4 - n + i)`)
 * put the last part in the *high* bytes and turned 127.1 into 1.0.127.0, which
 * is a public address: an open loopback hole. The unit tests pin all spellings.
 */
export function parseIpv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseNumericPart(p);
    if (n === null || !Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i]! > 255) return null;
  const last = nums.length - 1;
  const bytesInLast = 5 - nums.length; // 4 parts → 1 byte, 1 part → 4 bytes
  const span = 256 ** bytesInLast;
  if (nums[last]! >= span) return null;
  let value = 0;
  for (let i = 0; i < last; i++) value = value * 256 + nums[i]!;
  return value * span + nums[last]!;
}

/** True when the host is a literal IPv4 in any accepted spelling (127.1, 0x7f.1, …). */
export function isIpv4Literal(host: string): boolean {
  return /^[0-9a-fx.]+$/i.test(host) && parseIpv4(host) !== null;
}

/** Expands an IPv6 literal to its 128-bit value, or null if malformed. */
export function parseIpv6(input: string): bigint | null {
  let host = input;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host.includes(':')) return null;

  // Embedded IPv4 in the last 32 bits (::ffff:127.0.0.1, ::1.2.3.4)
  const lastColon = host.lastIndexOf(':');
  const tail = host.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    host = `${host.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const [leftRaw, rightRaw] = host.split('::');
  if (host.split('::').length > 2) return null;
  const parseGroups = (s: string | undefined): number[] | null => {
    if (s === undefined || s === '') return [];
    const parts = s.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/i.test(p)) return null;
      out.push(Number.parseInt(p, 16));
    }
    return out;
  };
  const left = parseGroups(leftRaw);
  const right = parseGroups(rightRaw);
  if (left === null || right === null) return null;

  let groups: number[];
  if (host.includes('::')) {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array<number>(missing).fill(0), ...right];
  } else {
    if (left.length !== 8) return null;
    groups = left;
  }
  let value = 0n;
  for (const g of groups) value = (value << 16n) | BigInt(g);
  return value;
}

export function ipv6ToString(value: bigint): string {
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.unshift(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  return groups.join(':');
}

export type IpInfo =
  | { version: 4; value: number; canonical: string }
  | { version: 6; value: bigint; canonical: string; embeddedIpv4?: number };

export function classifyIp(input: string): IpInfo | null {
  const host = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  if (host.includes(':')) {
    const value = parseIpv6(host);
    if (value === null) return null;
    const info: IpInfo = { version: 6, value, canonical: ipv6ToString(value) };
    // IPv4-mapped (::ffff:a.b.c.d), 6to4 (2002:a.b.c.d::) and NAT64 (64:ff9b::a.b.c.d)
    // all smuggle an IPv4 address inside an IPv6 literal — extract and check it.
    if ((value >> 96n) === 0xffffn) {
      info.embeddedIpv4 = Number(value & 0xffffffffn);
    } else if ((value >> 112n) === 0x2002n) {
      info.embeddedIpv4 = Number((value >> 80n) & 0xffffffffn);
    } else if ((value >> 96n) === 0x64ff9bn) {
      info.embeddedIpv4 = Number(value & 0xffffffffn);
    }
    return info;
  }
  const v4 = parseIpv4(host);
  if (v4 === null) return null;
  return { version: 4, value: v4, canonical: ipv4ToString(v4) };
}

export function isReservedIp(ip: IpInfo): boolean {
  if (ip.version === 4) return isReservedIpv4(ip.value);
  if (ip.embeddedIpv4 !== undefined && isReservedIpv4(ip.embeddedIpv4)) return true;
  for (const [network, prefix] of RESERVED_IPV6) {
    const shift = BigInt(128 - prefix);
    if ((ip.value >> shift) === (network >> shift)) return true;
  }
  return false;
}

export function isReservedIpv4(value: number): boolean {
  for (const [network, prefix] of RESERVED_IPV4) {
    const shift = 32 - prefix;
    if (Math.floor(value / 2 ** shift) === Math.floor(network / 2 ** shift)) return true;
  }
  return false;
}

function defaultPortFor(scheme: string): number {
  return scheme === 'https:' ? 443 : 80;
}

export function isBlockedHost(hostname: string, extra: string[] = []): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTS.includes(host)) return true;
  if (extra.some((e) => host === e.toLowerCase() || host.endsWith(`.${e.toLowerCase()}`))) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function createUrlGuard(options: UrlGuardOptions): UrlGuard {
  const schemes = options.allowedSchemes ?? DEFAULT_SCHEMES;
  const ports = options.allowedPorts ?? DEFAULT_PORTS;
  const blockedHosts = options.blockedHosts ?? [];

  const staticInspect: UrlGuard['staticInspect'] = (raw) => {
    let url: URL;
    try {
      url = new URL(String(raw ?? '').trim());
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
    if (!schemes.includes(url.protocol)) return { ok: false, reason: 'scheme_not_allowed', detail: url.protocol };
    if (url.username || url.password) return { ok: false, reason: 'userinfo_not_allowed' };
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) return { ok: false, reason: 'invalid_url' };
    const port = url.port ? Number(url.port) : defaultPortFor(url.protocol);
    if (!Number.isInteger(port) || !ports.includes(port)) {
      return { ok: false, reason: 'port_not_allowed', detail: String(port) };
    }
    // A literal IP in the URL is checked immediately; a hostname needs DNS.
    const literal = classifyIp(host);
    if (literal && !options.allowPrivate && isReservedIp(literal)) {
      return { ok: false, reason: 'ip_blocked', detail: literal.canonical };
    }
    if (!literal && isBlockedHost(host, blockedHosts)) {
      return { ok: false, reason: 'host_blocked', detail: host };
    }
    return { ok: true, url, host, port };
  };

  const inspect = async (raw: string): Promise<GuardVerdict> => {
    const pre = staticInspect(raw);
    if (!pre.ok) return { ok: false, reason: pre.reason, detail: pre.detail, url: String(raw ?? '') };

    const { url, host, port } = pre;
    const literal = classifyIp(host);
    if (literal) {
      return { ok: true, url: url.toString(), host: literal.canonical, port, ips: [literal.canonical] };
    }

    let ips: string[];
    try {
      ips = await options.resolve(host);
    } catch {
      return { ok: false, reason: 'unresolvable', detail: host, url: url.toString() };
    }
    if (!ips || ips.length === 0) return { ok: false, reason: 'unresolvable', detail: host, url: url.toString() };

    const canonical: string[] = [];
    for (const answer of ips) {
      const info = classifyIp(answer);
      if (!info) return { ok: false, reason: 'dns_blocked', detail: answer, url: url.toString() };
      if (!options.allowPrivate && isReservedIp(info)) {
        return { ok: false, reason: 'dns_blocked', detail: `${host} → ${info.canonical}`, url: url.toString() };
      }
      canonical.push(info.canonical);
    }
    return { ok: true, url: url.toString(), host, port, ips: canonical };
  };

  const assert: UrlGuard['assert'] = async (raw) => {
    const verdict = await inspect(raw);
    if (!verdict.ok) {
      const err = new Error(`refusing to fetch ${raw}: ${verdict.reason}${verdict.detail ? ` (${verdict.detail})` : ''}`);
      (err as Error & { code?: string }).code = `ssrf_${verdict.reason}`;
      throw err;
    }
    return { url: verdict.url, host: verdict.host, port: verdict.port, ips: verdict.ips };
  };

  return { inspect, assert, staticInspect };
}

/**
 * `fetch` that refuses to follow a redirect into a private range.
 *
 * Following redirects blindly is the bypass that defeats every URL allowlist:
 * the attacker's public URL answers `302 Location: http://169.254.169.254/…`.
 * So redirects are manual and each hop is re-inspected, up to `maxRedirects`.
 */
export async function guardedFetch(
  guard: UrlGuard,
  input: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const { maxRedirects = 5, timeoutMs = 15_000 } = opts;
  let target = input;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await guard.assert(target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(target, { ...init, redirect: 'manual', signal: controller.signal });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, target).toString();
        continue;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`too many redirects while fetching ${input}`);
}
