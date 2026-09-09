/**
 * Locale-aware formatting. Arabic-first: numerals follow the locale by default
 * (١٢٬٣٤٥ for `ar`) because that is what an Arabic reader expects, and every
 * helper takes `numeralSystem: 'latn'` for the places where Latin digits are
 * conventional (scores, prices, version numbers).
 */

export type FmtLocale = string;

const intlLocale = (locale: FmtLocale): string => (locale === 'ar' ? 'ar-EG' : locale || 'en-US');

export function formatNumber(value: number, locale: FmtLocale = 'ar', opts: { numeralSystem?: string } = {}): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(intlLocale(locale), {
    ...(opts.numeralSystem ? { numberingSystem: opts.numeralSystem } : {}),
    maximumFractionDigits: 0,
  } as Intl.NumberFormatOptions).format(value);
}

/** 12.3K / ١٢٫٣ ألف — for play counts on cards where space is tight. */
export function formatCompact(value: number, locale: FmtLocale = 'ar', opts: { numeralSystem?: string } = {}): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(intlLocale(locale), {
    notation: 'compact',
    maximumFractionDigits: 1,
    ...(opts.numeralSystem ? { numberingSystem: opts.numeralSystem } : {}),
  } as Intl.NumberFormatOptions).format(value);
}

export function formatRating(value: number, locale: FmtLocale = 'ar'): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    numberingSystem: 'latn',
  }).format(value);
}

export function formatPrice(cents: number, currency = 'USD', locale: FmtLocale = 'en'): string {
  return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency }).format(cents / 100);
}

export function formatDate(value: string | Date | null | undefined, locale: FmtLocale = 'ar'): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    numberingSystem: 'latn',
  }).format(d);
}

export function formatDateTime(value: string | Date | null | undefined, locale: FmtLocale = 'ar'): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    numberingSystem: 'latn',
  }).format(d);
}

export function formatRelative(value: string | Date | null | undefined, locale: FmtLocale = 'ar', now = Date.now()): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  const diff = d.getTime() - now;
  if (Number.isNaN(d.getTime())) return '';
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  const abs = Math.abs(diff);
  const sign = diff < 0 ? -1 : 1;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return rtf.format(sign * Math.round(abs / 1000), 'second');
  if (abs < hour) return rtf.format(sign * Math.round(abs / minute), 'minute');
  if (abs < day) return rtf.format(sign * Math.round(abs / hour), 'hour');
  if (abs < 30 * day) return rtf.format(sign * Math.round(abs / day), 'day');
  if (abs < 365 * day) return rtf.format(sign * Math.round(abs / (30 * day)), 'month');
  return rtf.format(sign * Math.round(abs / (365 * day)), 'year');
}

export function formatDuration(ms: number | null | undefined, locale: FmtLocale = 'ar'): string {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = h > 0 ? [h, m, sec] : m > 0 ? [m, sec] : [sec];
  return parts
    .map((p) => String(p).padStart(2, '0'))
    .join(':')
    .replace(/[\u0660-\u0669]/g, (c) => c) // keep the caller's numerals
    .concat(locale === 'ar' && h === 0 && m === 0 ? '' : '');
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** UI copy in both languages, so a component never hard-codes a string twice. */
export const UI = {
  ar: {
    play: 'العب الآن',
    playFull: 'ملء الشاشة',
    favorite: 'المفضلة',
    share: 'مشاركة',
    report: 'إبلاغ',
    comments: 'التعليقات',
    writeComment: 'اكتب تعليقًا…',
    send: 'إرسال',
    reply: 'رد',
    like: 'أعجبني',
    dislike: 'لم يعجبني',
    rating: 'التقييم',
    plays: 'مرة لعب',
    related: 'ألعاب مشابهة',
    categories: 'التصنيفات',
    tags: 'الوسوم',
    search: 'ابحث عن لعبة…',
    searchNoResults: 'لا نتائج مطابقة',
    newest: 'الأحدث',
    popular: 'الأكثر لعبًا',
    topRated: 'الأعلى تقييمًا',
    featured: 'مميزة',
    premium: 'حصري للمشتركين',
    loading: 'جارٍ التحميل…',
    offline: 'لا يوجد اتصال بالإنترنت',
    login: 'تسجيل الدخول',
    register: 'إنشاء حساب',
    logout: 'تسجيل الخروج',
    profile: 'الملف الشخصي',
    dashboard: 'لوحة التحكم',
    home: 'الرئيسية',
    blog: 'المدونة',
    viewAll: 'عرض الكل',
    controls: 'طريقة اللعب',
    instructions: 'التعليمات',
    developer: 'المطوّر',
    published: 'تاريخ النشر',
    ageRating: 'التصنيف العمري',
    adLabel: 'إعلان',
  },
  en: {
    play: 'Play now',
    playFull: 'Fullscreen',
    favorite: 'Favorite',
    share: 'Share',
    report: 'Report',
    comments: 'Comments',
    writeComment: 'Write a comment…',
    send: 'Send',
    reply: 'Reply',
    like: 'Like',
    dislike: 'Dislike',
    rating: 'Rating',
    plays: 'plays',
    related: 'Related games',
    categories: 'Categories',
    tags: 'Tags',
    search: 'Search for a game…',
    searchNoResults: 'No matching results',
    newest: 'Newest',
    popular: 'Most played',
    topRated: 'Top rated',
    featured: 'Featured',
    premium: 'Premium only',
    loading: 'Loading…',
    offline: 'You are offline',
    login: 'Sign in',
    register: 'Sign up',
    logout: 'Sign out',
    profile: 'Profile',
    dashboard: 'Dashboard',
    home: 'Home',
    blog: 'Blog',
    viewAll: 'View all',
    controls: 'Controls',
    instructions: 'Instructions',
    developer: 'Developer',
    published: 'Published',
    ageRating: 'Age rating',
    adLabel: 'Advertisement',
  },
} as const;

export type UiKey = keyof typeof UI.ar;
export const t = (locale: FmtLocale, key: UiKey): string =>
  (locale === 'en' ? UI.en[key] : UI.ar[key]) ?? UI.ar[key] ?? String(key);
