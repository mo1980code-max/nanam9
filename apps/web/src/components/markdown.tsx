/**
 * A dependency-free Markdown renderer that produces React elements.
 *
 * WHY NOT `marked` + `dangerouslySetInnerHTML`: that pipeline turns stored Markdown
 * into an HTML *string* and hands it to the browser's parser, so every defence lives in
 * the sanitizer's rule list — and sanitizer rule lists are how XSS advisories get
 * written. Rendering to React elements means the only HTML that ever exists is the
 * markup these functions emit, and every text node is escaped by React itself. There is
 * no string that could carry a `<script>`, so there is nothing to sanitize.
 *
 * It covers what a blog post actually uses (headings, lists, quotes, code, tables,
 * links, images, emphasis) and deliberately nothing more.
 *
 * URLs still go through `safeUrl` from @voltade/shared: escaping stops script execution,
 * but `[اضغط هنا](javascript:alert(1))` is a working link, and that is a phishing vector
 * rather than an XSS one.
 */

import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { safeUrl } from '@voltade/shared';

/** External links get rel=noopener + noreferrer and open in a new tab; internal ones
 *  stay in-app so client-side navigation keeps working. */
function Anchor({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeUrl(href);
  if (!safe) return <span className="text-muted line-through">{children}</span>;
  const external = /^(https?:)?\/\//i.test(safe);
  if (external) {
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  }
  return <Link href={safe}>{children}</Link>;
}

/** Inline pass: code, images, links, bold, italic — in that order, so a `**` inside a
 *  link label still renders and a `]` inside code stays literal. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(`[^`]+`)|(!\[[^\]]*\]\([^)]*\))|(\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(__[^_]+__)|(_[^_]+_)/g;
  const out: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  const push = (node: ReactNode) => {
    out.push(<Fragment key={`${keyPrefix}-${index}`}>{node}</Fragment>);
    index += 1;
  };

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) push(text.slice(cursor, match.index));
    const token = match[0];

    if (token.startsWith('`')) {
      push(<code>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('![')) {
      const alt = token.slice(2, token.indexOf(']'));
      const src = token.slice(token.indexOf('(') + 1, token.lastIndexOf(')'));
      const safe = safeUrl(src);
      push(
        safe ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={safe} alt={alt} loading="lazy" className="max-w-full rounded-xl" />
        ) : (
          <span className="text-muted">[صورة محجوبة]</span>
        ),
      );
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('(') + 1, token.lastIndexOf(')'));
      push(<Anchor href={href}>{label}</Anchor>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      push(<strong>{token.slice(2, -2)}</strong>);
    } else {
      push(<em>{token.slice(1, -1)}</em>);
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) push(text.slice(cursor));
  return out;
}

const isRule = (line: string): boolean => /^ {0,3}([-*_])\s*(\1\s*){2,}$/.test(line);
const isTableDivider = (line: string): boolean => /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(line) && line.includes('-');
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

export function Markdown({ source, className = 'prose-ar' }: { source: string; className?: string }) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={`p${key++}`}>{inline(paragraph.join(' '), `p${key}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={`l${key++}`}>
        {list.items.map((item, itemIndex) => (
          <li key={itemIndex}>{inline(item, `l${key}-${itemIndex}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(<blockquote key={`q${key++}`}>{inline(quote.join(' '), `q${key}`)}</blockquote>);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Fenced code: consume until the closing fence, verbatim.
    if (trimmed.startsWith('```')) {
      flushAll();
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push(
        <pre key={`c${key++}`} data-language={language || undefined}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (!trimmed) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      const content = inline(heading[2]!, `h${key}`);
      blocks.push(
        level === 1 ? (
          <h1 key={`h${key++}`}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={`h${key++}`}>{content}</h2>
        ) : (
          <h3 key={`h${key++}`}>{content}</h3>
        ),
      );
      continue;
    }

    if (isRule(trimmed)) {
      flushAll();
      blocks.push(<hr key={`r${key++}`} />);
      continue;
    }

    // A pipe table: a header row, a divider row, then body rows.
    if (trimmed.includes('|') && isTableDivider(lines[i + 1] ?? '')) {
      flushAll();
      const header = cells(trimmed);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) {
        body.push(cells(lines[i] ?? ''));
        i += 1;
      }
      i -= 1;
      blocks.push(
        <table key={`t${key++}`}>
          <thead>
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={cellIndex} scope="col">{inline(cell, `th${key}-${cellIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{inline(cell, `td${key}-${rowIndex}-${cellIndex}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet?.[1] ?? numbered?.[1] ?? '').trim());
      continue;
    }

    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      quote.push(trimmed.replace(/^>\s?/, ''));
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }
  flushAll();

  return <div className={className}>{blocks}</div>;
}
