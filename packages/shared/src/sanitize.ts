/**
 * HTML sanitisation — ONE implementation, used by the API on write and by the web
 * app on render, so the two can never disagree about what is safe.
 *
 * WHY SANITISE ON WRITE AND NOT ONLY ON RENDER: stored XSS is a persistence bug.
 * If a payload reaches the database, every future renderer (the site, an email, an
 * RSS feed, an admin preview, a partner API consumer) has to remember to clean it,
 * and one of them will not. Cleaning at the boundary means the stored value is
 * already inert.
 *
 * THE MODEL is an allowlist, not a blocklist. Blocklists lose: `<scr<script>ipt>`,
 * `<img src=x onerror=…>`, `<a href="java&#115;cript:…">`, namespace tricks like
 * `<svg:script>` and mutation-XSS all defeat string matching. Here a tag survives
 * only if it is on the list, an attribute survives only if it is on the list *for
 * that tag*, and a URL survives only if its scheme is on the list.
 *
 * WHAT THIS IS NOT: a replacement for a Content-Security-Policy. A CSP is the layer
 * that still protects you when a sanitizer has a bug, and both ship together.
 *
 * KNOWN LIMIT, stated so nobody is surprised: attribute values are re-escaped, not
 * re-parsed by a real HTML parser, so exotic encodings inside an *allowed* attribute
 * are normalised rather than interpreted. That is safe in one direction (nothing
 * executes) but means byte-for-byte round-tripping is not guaranteed.
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Tags whose *text* must disappear with them: it is code or metadata, never prose. */
const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'title', 'textarea', 'svg', 'math']);

/** The set an editor's rich text can actually need. Everything else is dropped. */
const SAFE_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture',
  'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'source',
]);

/** Only reachable through `allowScripts`, which the caller must justify. */
const SCRIPT_TAGS = new Set(['script', 'iframe', 'style', 'svg', 'noscript']);

/** Attributes allowed on any permitted tag. `id` is deliberately absent: user-chosen
 *  ids enable DOM clobbering (`window.username`) and break `getElementById` callers.
 *  `style` is absent too — CSS carries `url(javascript:)` and legacy `expression()`. */
const GLOBAL_ATTRS = new Set(['class', 'dir', 'lang', 'title']);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'target', 'hreflang', 'download']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes', 'referrerpolicy']),
  source: new Set(['src', 'srcset', 'type', 'media', 'sizes']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'scope', 'headers']),
  ol: new Set(['start', 'type', 'reversed']),
  li: new Set(['value']),
  time: new Set(['datetime']),
  del: new Set(['datetime']),
  ins: new Set(['datetime']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  script: new Set(['src', 'type', 'async', 'defer', 'crossorigin', 'referrerpolicy', 'nomodule']),
  iframe: new Set(['src', 'width', 'height', 'title', 'loading', 'allowfullscreen', 'frameborder', 'sandbox', 'referrerpolicy']),
  style: new Set(['type', 'media']),
};

const URL_ATTRS = new Set(['href', 'src', 'srcset', 'cite', 'download']);

/** `srcdoc` is a document inside a document, so it can never be sanitised here. */
const ALWAYS_FORBIDDEN_ATTRS = new Set(['srcdoc', 'formaction', 'xlink:href', 'action', 'background', 'dynsrc', 'lowsrc', 'ping']);

const TAG_RE = /<(\/)?\s*([a-zA-Z][a-zA-Z0-9:._-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?\s*>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export type SanitizeOptions = {
  /**
   * Permit `<script>`, `<iframe>`, `<style>` and `<svg>`.
   *
   * This is for admin-authored integration snippets (analytics, AdSense) whose whole
   * purpose is to execute. Callers must already have proven the author holds a
   * management permission — the sanitizer cannot tell an analyst from an attacker.
   */
  allowScripts?: boolean;
  /** Extra tags on top of the safe set. Never widens the script set. */
  allowTags?: readonly string[];
  /** Drop everything after N characters of *output*. Guards against a huge paste. */
  maxLength?: number;
};

export type UnsafeFinding = { pattern: string; reason: string };

/**
 * Clean a fragment of HTML.
 *
 * Text nodes are re-escaped, so a literal `<` in the author's prose survives as
 * `&lt;` instead of opening a tag the browser would try to parse.
 */
export function sanitizeHtml(input: string | null | undefined, options: SanitizeOptions = {}): string {
  if (input === null || input === undefined) return '';
  const allowScripts = options.allowScripts === true;
  const extraTags = new Set((options.allowTags ?? []).map((t) => t.toLowerCase().replace(/^<|>$/g, '')));

  // Comments, CDATA and doctypes carry nothing renderable. Conditional comments
  // (`<!--[if IE]><script>…`) were an execution vector, so they go first.
  let src = String(input)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<![^>]*>/g, ' ');

  const out: string[] = [];
  const open: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(src)) !== null) {
    out.push(escapeText(src.slice(cursor, match.index)));
    cursor = match.index + match[0].length;

    const isClosing = match[1] === '/';
    const rawName = (match[2] ?? '').toLowerCase();
    if (!rawName) continue;
    // Namespace prefixes (`svg:script`, `xlink:href`) are how allowlists get
    // bypassed, so the prefix is stripped and the local name decides.
    const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
    const attrText = match[3] ?? '';
    const allowed = SAFE_TAGS.has(name) || extraTags.has(name) || (allowScripts && SCRIPT_TAGS.has(name));

    if (!allowed) {
      if (!isClosing && DROP_CONTENT_TAGS.has(name)) {
        // Skip the element's text as well: `<script>alert(1)</script>` must not
        // degrade into `alert(1)` rendered as a paragraph.
        const close = new RegExp(`</\\s*${name}[^>]*>`, 'i');
        const rest = src.slice(cursor);
        const found = close.exec(rest);
        if (found) {
          cursor += found.index + found[0].length;
          TAG_RE.lastIndex = cursor;
        }
      }
      continue;
    }

    if (isClosing) {
      if (VOID_TAGS.has(name)) continue;
      const at = open.lastIndexOf(name);
      if (at === -1) continue; // stray closer: dropping it keeps the tree valid
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }

    const attrs = renderAttributes(name, attrText, allowScripts);
    if (VOID_TAGS.has(name) || match[4] === '/') {
      out.push(`<${name}${attrs}>`);
      continue;
    }
    open.push(name);
    out.push(`<${name}${attrs}>`);
  }

  out.push(escapeText(src.slice(cursor)));
  while (open.length > 0) out.push(`</${open.pop()}>`);

  const html = out.join('');
  if (typeof options.maxLength === 'number' && options.maxLength > 0 && html.length > options.maxLength) {
    return truncateHtml(html, options.maxLength);
  }
  return html;
}

/**
 * Cut a *sanitised* fragment to a length budget without breaking it.
 *
 * This is deliberately not a recursive call into `sanitizeHtml`: a slice of
 * `<p>aaa…` is shorter than its re-sanitised form (the auto-closed `</p>` is added
 * back), so re-running the whole pipeline on the slice never converges and blows the
 * stack. One long paste would have been enough to take a request down.
 *
 * The closing tags mean the result can exceed `max` by a few characters. That is the
 * right trade: `max` bounds the author's content, and a balanced document matters
 * more than an exact byte count.
 */
function truncateHtml(html: string, max: number): string {
  let cut = html.slice(0, max);

  // Never end inside a tag: a dangling `<p cla` would be parsed by the browser as
  // the start of something the author did not write.
  const openAngle = cut.lastIndexOf('<');
  const closeAngle = cut.lastIndexOf('>');
  if (openAngle > closeAngle) cut = cut.slice(0, openAngle);

  const open: string[] = [];
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(cut)) !== null) {
    const name = (match[2] ?? '').toLowerCase();
    if (!name || VOID_TAGS.has(name)) continue;
    if (match[1] === '/') {
      const at = open.lastIndexOf(name);
      if (at !== -1) open.splice(at);
    } else {
      open.push(name);
    }
  }
  while (open.length > 0) cut += `</${open.pop()}>`;
  return cut;
}

function renderAttributes(tag: string, attrText: string, allowScripts: boolean): string {
  const permitted = TAG_ATTRS[tag] ?? new Set<string>();
  const parts: string[] = [];
  let target = '';
  let hasRel = false;
  let relValue = '';

  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText)) !== null) {
    const attr = (m[1] ?? '').toLowerCase();
    if (!attr) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';

    // Event handlers are refused even with allowScripts: an integration snippet has
    // no business binding `onerror`, and it is the single most common stored-XSS
    // attribute in the wild.
    if (attr.startsWith('on')) continue;
    if (ALWAYS_FORBIDDEN_ATTRS.has(attr)) continue;
    if (attr.startsWith('data-') && !(allowScripts && (tag === 'script' || tag === 'iframe'))) continue;
    if (!GLOBAL_ATTRS.has(attr) && !permitted.has(attr)) continue;

    let finalValue: string | null = decodeEntities(value);
    if (URL_ATTRS.has(attr)) {
      finalValue = safeUrl(finalValue, tag, attr);
      if (finalValue === null) continue;
    }
    if (attr === 'target') {
      target = finalValue === '_blank' ? '_blank' : '_self';
      parts.push(`target="${escapeAttr(target)}"`);
      continue;
    }
    if (attr === 'rel') {
      hasRel = true;
      relValue = finalValue;
      continue; // emitted last, once we know whether target=_blank was present
    }
    parts.push(`${attr}="${escapeAttr(finalValue)}"`);
  }

  if (tag === 'a') {
    const rel = new Set(relValue.split(/\s+/).filter(Boolean));
    // A link that opens a new tab hands the destination `window.opener`, which can
    // navigate this page (tab-nabbing). This is not optional.
    if (target === '_blank') {
      rel.add('noopener');
      rel.add('noreferrer');
    }
    if (rel.size > 0 || hasRel) parts.push(`rel="${escapeAttr([...rel].join(' '))}"`);
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * URL schemes: http(s), mailto, tel, in-page anchors, relative paths, and
 * `data:image/*` on `<img src>` only.
 */
export function safeUrl(value: string, tag = 'a', attr = 'href'): string | null {
  // Control characters and internal whitespace are how `java\nscript:` sneaks past a
  // naive prefix check — browsers ignore them, so we remove them before deciding.
  const stripped = value.replace(/[\u0000-\u0020\u007f]/g, '');
  const probe = stripped.toLowerCase();

  if (/^(javascript|vbscript|livescript|moz-binding|file):/.test(probe)) return null;
  if (probe.startsWith('data:')) {
    const inlineImage = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
    return tag === 'img' && attr === 'src' && inlineImage.test(stripped) ? stripped : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(probe) && !/^(https?|mailto|tel|sms|ftp|irc|news):/.test(probe)) return null;
  return stripped;
}

const ENTITY_RE = /&(#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,10});/g;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value: string): string {
  return value.replace(ENTITY_RE, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? whole;
  });
}

function escapeText(value: string): string {
  return value
    .replace(/&(?!(?:#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,10});)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Report what a fragment was trying to do, without cleaning it.
 *
 * Used for two things: telling an editor *why* their paste changed, and flagging a
 * comment for human review instead of silently rewriting it (a silently edited
 * comment is how a moderator misses a real attack).
 */
export function findUnsafeHtml(input: string | null | undefined): UnsafeFinding[] {
  if (!input) return [];
  const text = String(input);
  const probes: { pattern: RegExp; reason: string }[] = [
    { pattern: /<\s*script[\s>]/i, reason: 'script tag' },
    { pattern: /<\s*iframe[\s>]/i, reason: 'iframe' },
    { pattern: /<\s*(object|embed|applet)[\s>]/i, reason: 'plugin embed' },
    { pattern: /<\s*(svg|math)[\s>]/i, reason: 'svg/math markup' },
    { pattern: /<\s*style[\s>]/i, reason: 'style tag' },
    { pattern: /<\s*(link|meta|base)[\s>]/i, reason: 'document head tag' },
    { pattern: /<\s*form[\s>]/i, reason: 'form' },
    { pattern: /\son[a-z]+\s*=/i, reason: 'inline event handler' },
    { pattern: /(?:href|src|action)\s*=\s*["']?\s*(?:java|vb|live)script:/i, reason: 'script URL' },
    { pattern: /(?:href|src)\s*=\s*["']?\s*data:(?!image\/)/i, reason: 'non-image data URL' },
    { pattern: /<!--[\s\S]*?-->/, reason: 'HTML comment' },
    { pattern: /<!\[CDATA\[/i, reason: 'CDATA section' },
    { pattern: /expression\s*\(/i, reason: 'CSS expression' },
    { pattern: /document\s*\.\s*(cookie|write|location)/i, reason: 'DOM access' },
  ];
  return probes.filter((p) => p.pattern.test(text)).map((p) => ({ pattern: p.reason, reason: p.reason }));
}

/** True when sanitising would change the fragment — i.e. it contained something unsafe. */
export function isUnsafeHtml(input: string | null | undefined): boolean {
  return findUnsafeHtml(input).length > 0;
}

/** Escape for a text node when building HTML by hand (the web app's fallbacks). */
export function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
