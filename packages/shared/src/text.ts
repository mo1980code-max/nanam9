/**
 * Text helpers — with first-class Arabic.
 *
 * The single most common mistake in an "Arabic-ready" portal is transliterating
 * slugs (`سباق-السيارات` → `sbaq-alsyarat`): it destroys the keyword in the URL,
 * which is the whole point of an Arabic SEO strategy. So `slugify` keeps Arabic
 * letters and digits as-is, strips only what a URL cannot carry (diacritics,
 * tatweel, punctuation, spaces) and normalises Arabic-Indic digits to Latin so
 * that `/game/2024` and `/game/٢٠٢٤` are the same resource.
 */

const ARABIC_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g; // tashkeel + tatweel
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const NOT_ALLOWED = /[^\p{L}\p{N}]+/gu;

const digitToLatin = (ch: string): string => {
  const code = ch.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return ch;
};

export type SlugOptions = {
  /** maximum characters; the slug is cut on a dash boundary below this. */
  max?: number;
  /** separator, default '-' */
  sep?: string;
  /** drop Latin diacritics (é → e). Default true. */
  foldLatin?: boolean;
};

export function slugify(input: string, options: SlugOptions = {}): string {
  const { max = 120, sep = '-', foldLatin = true } = options;
  let s = String(input ?? '').normalize('NFKC');
  s = s.replace(ARABIC_INDIC_DIGITS, digitToLatin);
  s = s.replace(ARABIC_DIACRITICS, '');
  if (foldLatin) {
    // NFD + strip combining marks: the portable way to fold é/ı/ø-ish letters
    // without a transliteration table.
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  s = s.toLowerCase().replace(NOT_ALLOWED, sep);
  s = s.replace(new RegExp(`${escapeRegExp(sep)}{2,}`, 'g'), sep);
  s = s.replace(new RegExp(`^${escapeRegExp(sep)}+|${escapeRegExp(sep)}+$`, 'g'), '');
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf(sep);
    if (cut > Math.floor(max * 0.6)) s = s.slice(0, cut);
    s = s.replace(new RegExp(`${escapeRegExp(sep)}+$`), '');
  }
  return s;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns a taken slug into a free one: `slug`, `slug-2`, `slug-3`, …
 * `isTaken` is async because the check is a database lookup.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  options: { maxTries?: number; max?: number } = {},
): Promise<string> {
  const { maxTries = 100, max = 120 } = options;
  const stem = slugify(base, { max: max - 6 }) || 'item';
  for (let i = 0; i < maxTries; i++) {
    const candidate = i === 0 ? stem : `${stem}-${i + 1}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  // 100 collisions means something is wrong upstream; stay unique anyway.
  return `${stem}-${Date.now().toString(36)}`;
}

/**
 * Search-side Arabic normalisation. Deliberately *not* used for slugs: folding
 * أ→ا and ى→ي makes "العاب" and "الألعاب" findable, which is what a player
 * typing fast expects, but it would merge two different display titles.
 */
export function normalizeArabicForSearch(input: string): string {
  return String(input ?? '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(ARABIC_INDIC_DIGITS, digitToLatin)
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627') // أ إ آ ٱ → ا
    .replace(/\u0649/g, '\u064a') // ى → ي
    .replace(/\u0629/g, '\u0647') // ة → ه
    .replace(/\u0624/g, '\u0648') // ؤ → و
    .replace(/\u0626/g, '\u064a') // ئ → ي
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function truncate(input: string, max: number, ellipsis = '…'): string {
  const s = String(input ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - ellipsis.length));
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > cut.length * 0.6 ? cut.slice(0, lastSpace) : cut}${ellipsis}`;
}

/** Words-per-minute based estimate; Arabic reads a little slower than English. */
export function readingMinutes(body: string, wpm = 200): number {
  const words = String(body ?? '')
    .replace(/[#*_`>\-\[\]()!]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / wpm));
}

/** Strips markdown/html to a plain excerpt for cards, meta descriptions, feeds. */
export function plainExcerpt(body: string, max = 170): string {
  const text = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_~\-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
}

export function initials(name: string, max = 2): string {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}
