/**
 * Sanitiser tests — the payloads here are the ones that actually appear in the wild.
 *
 * These are regression tests for a security control, so they assert on *behaviour*
 * ("no script survives", "the href is gone") rather than on exact output strings
 * wherever possible: an exact-match test breaks the moment the serialiser changes
 * whitespace, and a broken security test gets "fixed" by weakening the assertion.
 */

import { describe, expect, it } from 'vitest';
import { escapeHtml, findUnsafeHtml, isUnsafeHtml, safeUrl, sanitizeHtml } from '../src/sanitize.js';

describe('sanitizeHtml — script execution', () => {
  it('removes a script tag together with its content', () => {
    const out = sanitizeHtml('<script>alert(1)</script>');
    expect(out).toBe('');
    expect(out).not.toContain('alert');
  });

  it('removes a namespaced script tag (the allowlist bypass)', () => {
    const out = sanitizeHtml('<svg:script>alert(1)</svg:script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('<');
  });

  it('survives the classic split-tag payload', () => {
    const out = sanitizeHtml('<scr<script>ipt>alert(1)</script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('<i');
  });

  it('drops inline event handlers but keeps the element', () => {
    expect(sanitizeHtml('<img src=x onerror=alert(1)>')).toBe('<img src="x">');
    expect(sanitizeHtml('<p onclick="steal()">hi</p>')).toBe('<p>hi</p>');
  });

  it('drops event handlers even when scripts are explicitly allowed', () => {
    const out = sanitizeHtml('<img src="/a.png" onerror="alert(1)">', { allowScripts: true });
    expect(out).toContain('src="/a.png"');
    expect(out.toLowerCase()).not.toContain('onerror');
  });

  it('rejects javascript: URLs, including entity- and whitespace-obfuscated ones', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('drops style attributes (CSS can carry a script URL)', () => {
    expect(sanitizeHtml('<div style="background:url(javascript:alert(1))">x</div>')).toBe('<div>x</div>');
  });

  it('drops iframe, object and embed unless scripts are allowed', () => {
    expect(sanitizeHtml('<iframe src="//evil.test"></iframe>')).toBe('');
    expect(sanitizeHtml('<object data="x.swf"></object>')).toBe('');
    const withScripts = sanitizeHtml('<iframe src="//cdn.test/v"></iframe>', { allowScripts: true });
    expect(withScripts).toContain('<iframe');
    expect(withScripts).toContain('src="//cdn.test/v"');
  });

  it('never allows srcdoc, which is a document inside a document', () => {
    const out = sanitizeHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>', { allowScripts: true });
    expect(out.toLowerCase()).not.toContain('srcdoc');
  });

  it('removes comments, including IE conditional comments', () => {
    expect(sanitizeHtml('<!-- secret --><p>x</p>')).not.toContain('secret');
    expect(sanitizeHtml('<!--[if IE]><script>alert(1)</script><![endif]-->')).not.toContain('alert');
  });

  it('keeps integration snippets when the caller asks for scripts', () => {
    const out = sanitizeHtml('<script src="https://cdn.test/a.js" defer></script>', { allowScripts: true });
    expect(out).toContain('<script');
    expect(out).toContain('src="https://cdn.test/a.js"');
  });
});

describe('sanitizeHtml — structure and escaping', () => {
  it('escapes prose so a literal < cannot open a tag', () => {
    expect(sanitizeHtml('5 < 6 & 7 > 3')).toBe('5 &lt; 6 &amp; 7 &gt; 3');
  });

  it('closes tags the author left open, in order', () => {
    expect(sanitizeHtml('<div><p>x</div>')).toBe('<div><p>x</p></div>');
    expect(sanitizeHtml('<b>bold')).toBe('<b>bold</b>');
  });

  it('drops a stray closer instead of unbalancing the tree', () => {
    expect(sanitizeHtml('</div>text')).toBe('text');
  });

  it('keeps table structure and its span attributes', () => {
    const out = sanitizeHtml('<table><tr><td colspan="2">x</td></tr></table>');
    expect(out).toContain('colspan="2"');
    expect(out).toContain('<table>');
  });

  it('drops an id (DOM clobbering) but keeps class, dir and lang', () => {
    const out = sanitizeHtml('<p id="username" class="lead" dir="rtl" lang="ar">نص</p>');
    expect(out).not.toContain('id=');
    expect(out).toContain('class="lead"');
    expect(out).toContain('dir="rtl"');
    expect(out).toContain('نص');
  });

  it('forces noopener on a link that opens a new tab', () => {
    const out = sanitizeHtml('<a href="/game/x" target="_blank">y</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('noopener');
    expect(out).toContain('noreferrer');
  });

  it('normalises an unknown target to _self', () => {
    expect(sanitizeHtml('<a href="/x" target="evil">y</a>')).toContain('target="_self"');
  });

  it('honours maxLength without emitting a broken tag', () => {
    const out = sanitizeHtml(`<p>${'a'.repeat(500)}</p>`, { maxLength: 20 });
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.startsWith('<p>')).toBe(true);
    expect(out.endsWith('</p>')).toBe(true);
  });

  it('accepts extra tags from the caller but never widens the script set', () => {
    expect(sanitizeHtml('<marquee>x</marquee>', { allowTags: ['marquee'] })).toBe('<marquee>x</marquee>');
    expect(sanitizeHtml('<script>x()</script>', { allowTags: ['marquee'] })).toBe('');
  });

  it('is idempotent — sanitising twice changes nothing', () => {
    const once = sanitizeHtml('<p class="a">نص <b>عريض</b> <script>bad()</script></p>');
    expect(sanitizeHtml(once)).toBe(once);
  });
});

describe('sanitizeHtml — data URLs', () => {
  it('allows an inline image on <img src>', () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain('data:image/png;base64,');
  });

  it('refuses a data: document', () => {
    expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe('<a>x</a>');
  });
});

describe('safeUrl', () => {
  it('accepts relative paths, http(s), mailto and tel', () => {
    expect(safeUrl('/game/x')).toBe('/game/x');
    expect(safeUrl('https://example.test/a')).toBe('https://example.test/a');
    expect(safeUrl('mailto:hi@example.test')).toBe('mailto:hi@example.test');
    expect(safeUrl('tel:+962700000000')).toBe('tel:+962700000000');
  });

  it('refuses script schemes and unknown protocols', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('vbscript:x')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('chrome-extension://abc')).toBeNull();
  });

  it('refuses a data URL outside an image src', () => {
    expect(safeUrl('data:image/png;base64,AAA', 'a', 'href')).toBeNull();
    expect(safeUrl('data:image/png;base64,AAA', 'img', 'src')).not.toBeNull();
  });
});

describe('findUnsafeHtml / isUnsafeHtml', () => {
  it('names what a fragment was trying to do', () => {
    const findings = findUnsafeHtml('<p onclick="x()">hi</p><script>y()</script>');
    const reasons = findings.map((f) => f.reason);
    expect(reasons).toContain('inline event handler');
    expect(reasons).toContain('script tag');
  });

  it('reports clean rich text as safe', () => {
    expect(isUnsafeHtml('<p>مرحبًا <b>بالعالم</b></p>')).toBe(false);
    expect(isUnsafeHtml('')).toBe(false);
    expect(isUnsafeHtml(null)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that can leave a text node or an attribute', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    expect(escapeHtml(null)).toBe('');
  });
});
