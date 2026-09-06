/**
 * Seed content for a fresh Voltade install.
 *
 * Two audiences, one file:
 *  · a developer who wants a portal that looks alive the first time it boots —
 *    categories, a nested tree, six *playable* demo builds, comments in Arabic
 *    and English, ratings, 30 days of play history rolled up into the dashboard
 *    charts, ads, pages, blog posts, providers with a staged import queue;
 *  · an operator running `npm run db:seed` in production, who gets the settings,
 *    roles, permissions, themes and legal pages — and no fake games, because
 *    `SEED_DEMO_CONTENT=0` skips the demo catalogue.
 *
 * Everything is idempotent: rows are matched on their natural key (slug, key,
 * provider+id) and upserted, so running the seeder twice changes nothing.
 */

import { PERMISSIONS, ROLE_LEVELS, ROLE_PERMISSIONS, slugify } from '@voltade/shared';
import type { Database, ID } from '../ports.js';
import { hashPassword, seedAdminPassword } from '../passwords.js';

export type SeedOptions = {
  /** demo games, comments, plays, blog posts. Default: true unless SEED_DEMO_CONTENT=0 */
  demo?: boolean;
  baseUrl?: string;
  adminEmail?: string;
  adminUsername?: string;
  onLog?: (line: string) => void;
};

const log = (o: SeedOptions, line: string) => o.onLog?.(line);

// ───────────────────────────── the demo catalogue ─────────────────────────────

type DemoGame = {
  slug: string;
  ar: string;
  en: string;
  description: string;
  descriptionEn: string;
  instructions: string;
  categories: string[];
  tags: string[];
  developer: string;
  ageRating: 'everyone' | 'everyone_10' | 'teen';
  width: number;
  height: number;
  kind?: 'iframe' | 'html5_zip';
  sizeKb: number;
  featured?: boolean;
  plays: number;
  rating: number;
};

const DEMO_GAMES: DemoGame[] = [
  {
    slug: 'neon-pong',
    ar: 'بونج نيون',
    en: 'Neon Pong',
    description:
      'كلاسيكية البونج بلمسة نيون: واجه ذكاءً اصطناعيًا يتعلّم من ضرباتك، وكلما طال rally زادت سرعة الكرة. أول من يصل إلى سبع نقاط يفوز.',
    descriptionEn:
      'The arcade classic in neon: an opponent that tracks your shots, a ball that accelerates on every rally, and first to seven wins.',
    instructions: 'حرّك المضرب بمفاتيح W/S أو الأسهم ↑ ↓، أو اسحب إصبعك على الشاشة. اسحب بسرعة لإضافة دوران للكرة.',
    categories: ['arcade', 'classic', 'two-player'],
    tags: ['pong', 'retro', 'neon', 'single-player', 'touch'],
    developer: 'Voltade Studio',
    ageRating: 'everyone',
    width: 960,
    height: 600,
    sizeKb: 14,
    featured: true,
    plays: 18420,
    rating: 4.6,
  },
  {
    slug: 'snake-volt',
    ar: 'الثعبان الكهربائي',
    en: 'Snake Volt',
    description:
      'الثعبان الذي يعرفه الجميع، أسرع كلما أكلت. لوحة من عشرين خانة، أفضل نتيجة محفوظة على جهازك، وتحكم باللمس أو الأسهم.',
    descriptionEn:
      'Everyone\u2019s first game, now faster with every bite. A 20×20 grid, a local best score, and swipe or arrow-key control.',
    instructions: 'استخدم الأسهم أو WASD، أو اسحب إصبعك في الاتجاه المطلوب. على الجوال تظهر أزرار اتجاهات أسفل الشاشة.',
    categories: ['arcade', 'classic', 'mobile'],
    tags: ['snake', 'retro', 'offline', 'touch', 'high-score'],
    developer: 'Voltade Studio',
    ageRating: 'everyone',
    width: 720,
    height: 720,
    sizeKb: 12,
    featured: true,
    plays: 24310,
    rating: 4.8,
  },
  {
    slug: 'brick-blitz',
    ar: 'تحطيم الطوب',
    en: 'Brick Blitz',
    description:
      'حطّم الطوب بموجات لا تنتهي. طوبتان تحتاجان ضربتين، ثلاث أرواح، وزاوية الانعكاس تتغير حسب مكان اصطدام الكرة بالمضرب.',
    descriptionEn:
      'Break bricks across endless waves. Two-hit bricks, three lives, and the bounce angle depends on where the ball meets the paddle.',
    instructions: 'حرّك المضرب بالمؤشر أو ← →، واضغط المسافة أو انقر لإطلاق الكرة.',
    categories: ['arcade', 'action'],
    tags: ['breakout', 'bricks', 'endless', 'mouse', 'touch'],
    developer: 'Voltade Studio',
    ageRating: 'everyone',
    width: 800,
    height: 600,
    sizeKb: 15,
    plays: 12870,
    rating: 4.4,
  },
  {
    slug: 'volt-2048',
    ar: '٢٠٤٨',
    en: 'Volt 2048',
    description:
      'ادمج الأرقام لتصل إلى ٢٠٤٨. لعبة تفكير هادئة بلا مؤقّت، مع حفظ أفضل نتيجة محليًا ودعم كامل للسحب باللمس.',
    descriptionEn:
      'Merge tiles to reach 2048. No timer, no pressure, a local best score, and full swipe support on touch devices.',
    instructions: 'اسحب بإصبعك أو استخدم الأسهم لتحريك كل البلاطات في اتجاه واحد.',
    categories: ['puzzle', 'brain', 'mobile'],
    tags: ['2048', 'numbers', 'relaxing', 'offline', 'swipe'],
    developer: 'Voltade Studio',
    ageRating: 'everyone',
    width: 520,
    height: 720,
    kind: 'html5_zip',
    sizeKb: 9,
    plays: 30120,
    rating: 4.9,
  },
  {
    slug: 'memory-cards',
    ar: 'بطاقات الذاكرة',
    en: 'Memory Cards',
    description:
      'اقلب البطاقات وطابق الأزواج الثمانية بأقل عدد من المحاولات. نقاطك تُحتسب من كفاءتك لا من الحظ.',
    descriptionEn:
      'Flip cards and match eight pairs in as few moves as you can. Your score rewards efficiency, not luck.',
    instructions: 'انقر أو المس أي بطاقتين. إن تطابقتا بقيتا مكشوفتين، وإلا عادتَا بعد لحظة.',
    categories: ['puzzle', 'brain', 'kids'],
    tags: ['memory', 'cards', 'kids', 'casual', 'matching'],
    developer: 'Voltade Studio',
    ageRating: 'everyone',
    width: 520,
    height: 700,
    sizeKb: 8,
    plays: 9640,
    rating: 4.3,
  },
  {
    slug: 'tic-tac-volt',
    ar: 'إكس أو',
    en: 'Tic Tac Volt',
    description:
      'إكس أو ضد خصم بثلاث مستويات: سهل، عادي، وصعب يستخدم خوارزمية minimax ولا يمكن هزيمته — أفضل ما تحققه أمامه التعادل.',
    descriptionEn:
      'Noughts and crosses against three opponents: easy, normal, and an unbeatable minimax player you can only draw with.',
    instructions: 'أنت X وتلعب أولًا. اختر مستوى الخصم من القائمة، ثم انقر أي مربع.',
    categories: ['classic', 'brain', 'two-player'],
    tags: ['tic-tac-toe', 'strategy', 'ai', 'quick', 'offline'],
    developer: 'Voltade Studio',
    ageRating: 'everyone',
    width: 480,
    height: 640,
    sizeKb: 7,
    plays: 7210,
    rating: 4.1,
  },
];

const CATEGORIES: { slug: string; ar: string; en: string; icon: string; color: string; children?: { slug: string; ar: string; en: string; icon: string }[] }[] = [
  {
    slug: 'action',
    ar: 'أكشن',
    en: 'Action',
    icon: '⚔️',
    color: '#ff5e6c',
    children: [
      { slug: 'shooting', ar: 'إطلاق نار', en: 'Shooting', icon: '🎯' },
      { slug: 'fighting', ar: 'قتال', en: 'Fighting', icon: '🥊' },
    ],
  },
  {
    slug: 'arcade',
    ar: 'أركيد',
    en: 'Arcade',
    icon: '🕹️',
    color: '#7aa2ff',
    children: [{ slug: 'classic', ar: 'كلاسيكية', en: 'Classic', icon: '👾' }],
  },
  { slug: 'racing', ar: 'سباقات', en: 'Racing', icon: '🏎️', color: '#ffb03a' },
  {
    slug: 'puzzle',
    ar: 'ألغاز',
    en: 'Puzzle',
    icon: '🧩',
    color: '#c98bff',
    children: [{ slug: 'brain', ar: 'ذهنية', en: 'Brain', icon: '🧠' }],
  },
  { slug: 'sports', ar: 'رياضة', en: 'Sports', icon: '⚽', color: '#25e39a' },
  { slug: 'adventure', ar: 'مغامرات', en: 'Adventure', icon: '🗺️', color: '#5ee7ff' },
  { slug: 'kids', ar: 'أطفال', en: 'Kids', icon: '🧸', color: '#ff8fb1' },
  { slug: 'mobile', ar: 'للجوال', en: 'Mobile', icon: '📱', color: '#8ef7c1' },
  { slug: 'two-player', ar: 'لاعبان', en: 'Two player', icon: '👥', color: '#ffd166' },
  { slug: 'io', ar: 'ألعاب io', en: '.io games', icon: '🌐', color: '#9a5cff' },
];

const PROVIDER_QUEUE: { provider: string; id: string; title: string; category: string }[] = [
  { provider: 'gamemonetize', id: 'gm-8841', title: 'Desert Drift Rally', category: 'racing' },
  { provider: 'gamemonetize', id: 'gm-8842', title: 'Pixel Tower Jump', category: 'arcade' },
  { provider: 'gamemonetize', id: 'gm-8843', title: 'Ocean Merge 3', category: 'puzzle' },
  { provider: 'gamedistribution', id: 'gd-55120', title: 'Ninja Blade Rush', category: 'action' },
  { provider: 'gamedistribution', id: 'gd-55121', title: 'Farm Story Idle', category: 'kids' },
  { provider: 'gamedistribution', id: 'gd-55122', title: 'Basket Arcade Pro', category: 'sports' },
  // The same game twice under two provider ids: the hash must catch it.
  { provider: 'gamedistribution', id: 'gd-55123', title: 'Desert Drift Rally', category: 'racing' },
  { provider: 'gamemonetize', id: 'gm-8844', title: 'Gravity Lander', category: 'adventure' },
];

const DEMO_USERS: { username: string; name: string; email: string; role: string; xp: number }[] = [
  { username: 'layla', name: 'ليلى حسن', email: 'layla@example.com', role: 'user', xp: 1240 },
  { username: 'omar', name: 'عمر الشمري', email: 'omar@example.com', role: 'user', xp: 860 },
  { username: 'yousef', name: 'يوسف كنعان', email: 'yousef@example.com', role: 'user', xp: 2410 },
  { username: 'mira', name: 'Mira Haddad', email: 'mira@example.com', role: 'user', xp: 420 },
  { username: 'karim', name: 'كريم عبدو', email: 'karim@example.com', role: 'user', xp: 3120 },
  { username: 'sara', name: 'سارة النجار', email: 'sara@example.com', role: 'user', xp: 175 },
  { username: 'tariq', name: 'طارق فوزي', email: 'tariq@example.com', role: 'user', xp: 1980 },
  { username: 'nour', name: 'نور الدين', email: 'nour@example.com', role: 'user', xp: 640 },
];

const COMMENTS: { game: string; author: number; ar: string; replies?: { author: number; text: string }[] }[] = [
  {
    game: 'snake-volt',
    author: 0,
    ar: 'أفضل نسخة ثعبان لعبتها على الجوال — التحكم بالسحب دقيق جدًا ولا يتأخر. وصلت ٣٤٠ 🔥',
    replies: [
      { author: 2, text: 'كيف وصلتِ لهذا الرقم؟ أنا علقت عند ٢١٠' },
      { author: 0, text: 'السر أن تبدأ من الزاوية وتلفّ بشكل حلزوني، لا تتوسط اللوحة' },
    ],
  },
  {
    game: 'volt-2048',
    author: 4,
    ar: 'لعبة الإدمان الرسمية. وصلت ٢٠٤٨ في المحاولة الثالثة، والآن أحاول ٤٠٩٦.',
    replies: [{ author: 5, text: 'نفس الشيء! أفضل طريقة أن تحصر الصف الكبير في زاوية ثابتة' }],
  },
  { game: 'neon-pong', author: 3, ar: 'The AI actually adapts — spin shots off a fast swipe beat it every time. Great feel.' },
  { game: 'brick-blitz', author: 6, ar: 'الموجة الخامسة صعبة بشكل مفاجئ، الطوب المزدوج يحتاج تركيز على الزوايا.' },
  { game: 'memory-cards', author: 1, ar: 'ألعاب الذاكرة مثالية لأطفالي. أنهيناها بـ ١٤ محاولة فقط 😄' },
  { game: 'tic-tac-volt', author: 7, ar: 'المستوى الصعب مستحيل فعلاً، أفضل نتيجة عندي تعادل. هل أحد هزمه؟' },
  { game: 'neon-pong', author: 2, ar: 'يعمل على جوال قديم بدون أي تقطيع. هذا نادر في ألعاب HTML5.' },
];

const BLOG_POSTS: { slug: string; title: string; category: string; tags: string[]; excerpt: string; body: string }[] = [
  {
    slug: 'why-html5-games-win-in-2026',
    title: 'لماذا انتصرت ألعاب HTML5 في ٢٠٢٦',
    category: 'industry',
    tags: ['html5', 'web-games', 'performance'],
    excerpt: 'بدون تثبيت، بدون متجر، وبدون انتظار: كيف غيّرت ألعاب المتصفح اقتصاد التوزيع خلال خمس سنوات.',
    body: `## اللعبة التي لا تحتاج تثبيتًا

في ٢٠٢٠ كان على اللاعب أن يقنع نفسه: حمّل التطبيق، اقبل الأذونات، انتظر ٢٠٠ ميجابايت. اليوم يضغط رابطًا ويلعب خلال ثانيتين.

### ثلاثة أرقام تشرح التحوّل

1. **زمن الوصول**: لعبة HTML5 تُحمَّل في أقل من ثلاث ثوانٍ على اتصال متوسط، مقابل ٤٠ ثانية لتطبيق أصلي بحجم مماثل.
2. **التوزيع**: رابط واحد يعمل في واتساب وتيليجرام وتويتر وQR على ملصق.
3. **التحقيق**: مزادات Header Bidding رفعت سعر الألف ظهور (eCPM) في الألعاب المضمّنة بنسبة تتجاوز ٣٠٪ في أسواقنا.

### ماذا يعني هذا لمشغّل بوابة ألعاب؟

أن القيمة انتقلت من "من يملك اللعبة" إلى "من يملك الاكتشاف". اللعبة نفسها متاحة لعشرين بوابة؛ ما يميّز بوابتك هو التصنيف الذكي، وسرعة الصفحة، وثقة المستخدم في توصياتك.

> الخلاصة: الأداء ميزة، وSEO ميزة، وتصميم صفحة اللعبة ميزة تنافسية — لا تجميل.`,
  },
  {
    slug: 'core-web-vitals-for-game-portals',
    title: 'مقاييس Core Web Vitals لبوابات الألعاب: دليل عملي',
    category: 'technical',
    tags: ['seo', 'performance', 'nextjs'],
    excerpt: 'LCP وCLS وINP في صفحة لعبة: ما الذي يكسرها فعلًا، وكيف أصلحناه في Voltade.',
    body: `## LCP: الصورة المصغرة هي البطل

أكبر عنصر يُرسم في صفحة اللعبة هو الصورة المصغرة أو الـ banner. إن كانت PNG بحجم ٤٠٠ ك.ب فـ LCP لن يقل عن ثانيتين على شبكة 4G.

**الحل**: تحويل تلقائي إلى AVIF/WebP، و\`fetchpriority="high"\` لصورة اللعبة الأولى فقط، و\`loading="lazy"\` لكل ما تحت الطيّة.

## CLS: احجز مساحة الـ iframe

أكبر سبب لاهتزاز الصفحة هو iframe بلا أبعاد. نعطي الحاوية \`aspect-ratio\` من أبعاد اللعبة المخزّنة في قاعدة البيانات (width/height)، فلا يتحرك شيء بعد تحميل اللعبة.

## INP: لا تحجب الخيط الرئيسي

زر "العب الآن" يجب أن يستجيب فورًا. كل ما هو ثقيل — تسجيل اللعب، إرسال XP، تحميل التعليقات — يحدث بعد الاستجابة أو في worker.`,
  },
  {
    slug: 'how-to-import-gamemonetize-feed',
    title: 'كيف تستورد تغذية GameMonetize دون تكرار لعبة واحدة',
    category: 'guides',
    tags: ['providers', 'import', 'gamemonetize'],
    excerpt: 'دليل مشغّل البوابة: من مفتاح API إلى فحص ZIP، ولماذا hash المصدر هو خط الدفاع الأخير.',
    body: `## المشكلة التي يعرفها كل مشغّل

بعد أسبوعين من تشغيل الجلب التلقائي تكتشف أن "Speed Racer" موجودة ثلاث مرات: مرة من GameMonetize، ومرة من GameDistribution، ومرة رفعتها يدويًا.

## الحل في ثلاث طبقات

1. **hash المصدر**: \`sha256(provider|provider_game_id|normalized_url|title)\` مخزّن في عمود فريد. الإدراج المكرر يفشل في قاعدة البيانات قبل أن يفشل في الكود.
2. **جدول تجهيز (staging)**: كل ما تجلبه التغذية يدخل \`provider_items\` أولًا بحالة \`new\`، ثم يُحكم عليه: \`imported\` أو \`duplicate\` أو \`rejected\`.
3. **فحص الحزمة**: ملف ZIP يُفكَّك في مجلد مؤقت، ويُرفض إن لم يحتوِ \`index.html\`، أو إن تجاوز الحجم، أو إن احتوى مسارًا بـ \`../\`.

## الجدولة

كل ساعة: جلب صفحة واحدة من التغذية. كل ليلة: إعادة فهرسة البحث وتجميع الإحصائيات. لا تُشغّل الجلب عند كل طلب — هذا ما يجعل الخادم يخنق نفسه.`,
  },
  {
    slug: 'rtl-first-game-portal-design',
    title: 'تصميم بوابة ألعاب RTL-أولًا: ما الذي يتغير فعلًا',
    category: 'design',
    tags: ['rtl', 'arabic', 'ux'],
    excerpt: 'الاتجاه ليس ترجمة: الشبكات، الأيقونات، الأرقام، ومسار العين — قائمة مراجعة عملية.',
    body: `## \`dir="rtl"\` ليست كافيًا

المتصفح يعكس الاتجاه، لكن التصميم لا يُعكس تلقائيًا:

- **الأرقام**: اترك أرقام النتائج والحسابات لاتينية (\`numberingSystem: 'latn'\`) واكتب النصوص بالأرقام العربية حيث يناسب السياق.
- **الأيقونات الاتجاهية**: سهم "التالي" يجب أن ينقلب، بينما أيقونة الساعة أو التشغيل لا تنقلب.
- **الشبكة**: استخدم \`ms-*\`/\`me-*\` (margin-inline) بدل \`ml-*\`/\`mr-*\` حتى لا تضطر إلى كتابة نسختين.
- **مسار العين**: في RTL يبدأ المسح من اليمين؛ ضع عنصر الحثّ الأساسي (Play) على يمين البطاقة لا يسارها.

## الخط

نظام خطوط النظام (\`system-ui\`) يكفي للعناوين اللاتينية، لكن للعربية اختر خطًا واحدًا جيدًا (Cairo أو Tajawal) واربطه بـ \`font-display: swap\`.`,
  },
];

const ACHIEVEMENTS: { slug: string; ar: string; en: string; tier: string; xp: number; rule: Record<string, unknown> }[] = [
  { slug: 'first-play', ar: 'الخطوة الأولى', en: 'First steps', tier: 'bronze', xp: 10, rule: { type: 'plays', threshold: 1 } },
  { slug: 'player-10', ar: 'لاعب منتظم', en: 'Regular player', tier: 'bronze', xp: 25, rule: { type: 'plays', threshold: 10 } },
  { slug: 'player-50', ar: 'مدمن أركيد', en: 'Arcade addict', tier: 'silver', xp: 80, rule: { type: 'plays', threshold: 50 } },
  { slug: 'player-200', ar: 'أسطورة البوابة', en: 'Portal legend', tier: 'gold', xp: 250, rule: { type: 'plays', threshold: 200 } },
  { slug: 'critic', ar: 'الناقد', en: 'The critic', tier: 'bronze', xp: 20, rule: { type: 'ratings', threshold: 5 } },
  { slug: 'social', ar: 'اجتماعي', en: 'Social butterfly', tier: 'silver', xp: 60, rule: { type: 'comments', threshold: 10 } },
  { slug: 'collector', ar: 'الجامع', en: 'Collector', tier: 'silver', xp: 50, rule: { type: 'favorites', threshold: 20 } },
  { slug: 'curator', ar: 'منسّق القوائم', en: 'Curator', tier: 'gold', xp: 120, rule: { type: 'playlists', threshold: 3 } },
];

// ─────────────────────────────── the seeder ───────────────────────────────

export async function seedDatabase(db: Database, options: SeedOptions = {}): Promise<{ adminPassword?: string }> {
  const demo = options.demo ?? process.env.SEED_DEMO_CONTENT !== '0';
  const baseUrl = (options.baseUrl ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const adminEmail = options.adminEmail ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@voltade.test';
  const adminUsername = options.adminUsername ?? 'admin';

  // 1. RBAC — the catalogue lives in @voltade/shared so the API guards and the
  //    database can never disagree about what a permission is called.
  const permissions = PERMISSIONS.map((slug) => {
    const [module, action] = slug.split('.') as [string, string];
    return { slug, module, action: action ?? 'any' };
  });
  const roles = (Object.keys(ROLE_LEVELS) as (keyof typeof ROLE_LEVELS)[]).map((slug) => ({
    slug,
    name: { 'super-admin': 'Super Admin', admin: 'Admin', editor: 'Editor', moderator: 'Moderator', user: 'User' }[slug] ?? slug,
    level: ROLE_LEVELS[slug],
    permissions: ROLE_PERMISSIONS[slug] as unknown as string[],
  }));
  await db.identity.syncRbac({ permissions, roles });
  log(options, `rbac: ${permissions.length} permissions · ${roles.length} roles`);

  const roleOf = async (slug: string): Promise<ID> => {
    const role = await db.identity.findRoleBySlug(slug);
    if (!role) throw new Error(`seed: role ${slug} missing after syncRbac`);
    return role.id;
  };
  const [superAdminRole, adminRole, editorRole, moderatorRole, userRole] = await Promise.all([
    roleOf('super-admin'),
    roleOf('admin'),
    roleOf('editor'),
    roleOf('moderator'),
    roleOf('user'),
  ]);

  // 2. Settings — one JSON row per key, `is_public` decides what the web may see.
  const settings: [string, unknown, string, boolean, string?][] = [
    ['site.name', 'Voltade', 'general', true, 'اسم الموقع'],
    ['site.nameEn', 'Voltade', 'general', true],
    ['site.tagline', 'بوابة ألعاب HTML5 — العب فورًا بدون تحميل', 'general', true, 'الوصف المختصر'],
    ['site.taglineEn', 'Play instantly. No downloads.', 'general', true],
    ['site.baseUrl', baseUrl, 'general', false, 'الرابط الأساسي (يُستخدم في sitemap و JSON-LD)'],
    ['site.locale', 'ar', 'general', true],
    ['site.logoUrl', '/brand/logo.svg', 'general', true],
    ['site.ogImageUrl', '/brand/og-default.svg', 'general', true],
    ['games.perPage', 24, 'games', true],
    ['games.commentsPerPage', 20, 'games', true],
    ['games.guestComments', true, 'games', true, 'السماح للزوار بالتعليق'],
    ['games.commentModeration', 'guests', 'games', false, 'off | guests | all'],
    ['games.autoPublishImports', false, 'games', false, 'نشر الألعاب المستوردة تلقائيًا أم وضعها في قائمة المراجعة'],
    ['games.interstitialEvery', 4, 'ads', false, 'عدد الجولات بين إعلان بيني وآخر'],
    ['users.registrationEnabled', true, 'users', true],
    ['users.oauth.google', false, 'users', false],
    ['users.oauth.facebook', false, 'users', false],
    ['users.oauth.discord', false, 'users', false],
    ['seo.defaultTitle', 'Voltade — العب ألعاب HTML5 مجانًا', 'seo', true],
    ['seo.titleTemplate', '%s · Voltade', 'seo', true],
    ['seo.defaultDescription', 'آلاف ألعاب HTML5 المجانية تعمل مباشرة في المتصفح: أكشن، سباقات، ألغاز، رياضة وألعاب أطفال — بدون تحميل أو تثبيت.', 'seo', true],
    ['seo.keywords', 'العاب html5, العاب فلاش, العاب مجانية, العاب اونلاين, arcade games, html5 games', 'seo', true],
    ['theme.slug', 'voltade-neon', 'design', true],
    ['theme.mode', 'system', 'design', true, 'light | dark | system'],
    ['theme.customCursor', false, 'design', true],
    ['ads.enabled', true, 'ads', true],
    ['ads.adsenseClient', '', 'ads', false, 'ca-pub-XXXXXXXXXXXXXXXX'],
    ['ads.prebidEnabled', false, 'ads', false],
    ['analytics.ga4', '', 'analytics', true, 'G-XXXXXXXXXX'],
    ['analytics.cloudflareToken', '', 'analytics', false],
    ['pwa.enabled', true, 'pwa', true],
    ['import.cronEnabled', false, 'import', false],
  ];
  for (const [key, value, group, isPublic, description] of settings) {
    const existing = await db.operations.getSetting(key);
    // Never overwrite a value an operator has already changed.
    if (existing) continue;
    await db.operations.setSetting({
      key,
      value,
      group,
      isPublic,
      description,
      type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
    });
  }
  log(options, `settings: ${settings.length} keys`);

  // 3. Themes + homepage sections (the drag & drop builder's starting layout).
  const themes = [
    { slug: 'voltade-neon', name: 'Voltade Neon', isDefault: true, config: { accent: '#7aa2ff', accent2: '#c98bff', radius: 16, card: 'glass', cursor: false } },
    { slug: 'voltade-midnight', name: 'Voltade Midnight', config: { accent: '#25e39a', accent2: '#5ee7ff', radius: 10, card: 'solid', cursor: false } },
    { slug: 'voltade-sunset', name: 'Voltade Sunset', config: { accent: '#ffb03a', accent2: '#ff5ea8', radius: 20, card: 'glass', cursor: true } },
  ];
  for (const t of themes) await db.operations.upsertTheme(t);

  const sections = [
    { page: 'home', kind: 'hero', title: 'العب فورًا', titleEn: 'Play instantly', subtitle: 'بدون تحميل، بدون تسجيل، بدون انتظار', config: { source: 'featured', limit: 5 }, sortOrder: 0 },
    { page: 'home', kind: 'carousel', title: 'مميزة هذا الأسبوع', titleEn: 'Featured this week', config: { source: 'featured', limit: 12 }, sortOrder: 1 },
    { page: 'home', kind: 'category_grid', title: 'تصفح التصنيفات', titleEn: 'Browse categories', config: { limit: 10, withCount: true }, sortOrder: 2 },
    { page: 'home', kind: 'popular', title: 'الأكثر لعبًا', titleEn: 'Most played', config: { limit: 12, sort: 'popular' }, sortOrder: 3 },
    { page: 'home', kind: 'banner', title: '', config: { placement: 'in_feed' }, sortOrder: 4 },
    { page: 'home', kind: 'recent', title: 'أحدث الإضافات', titleEn: 'New arrivals', config: { limit: 12, sort: 'newest' }, sortOrder: 5 },
  ];
  for (const s of sections) {
    const existing = (await db.operations.listSections('home')).find((x) => x.kind === s.kind && x.sortOrder === s.sortOrder);
    if (!existing) await db.operations.upsertSection(s);
  }
  log(options, `themes: ${themes.length} · sections: ${sections.length}`);

  // 4. Users. The admin password is generated unless SEED_ADMIN_PASSWORD is set,
  //    and is printed once by the CLI.
  const { password: adminPassword, generated } = seedAdminPassword();
  const adminHash = await hashPassword(adminPassword);
  const playerHash = await hashPassword('Player!2345');

  const existingAdmin = await db.identity.findUserByUsername(adminUsername);
  const admin = existingAdmin ?? (await db.identity.createUser({
    username: adminUsername,
    email: adminEmail,
    displayName: 'مدير المنصة',
    passwordHash: adminHash,
    roleId: superAdminRole,
    locale: 'ar',
    status: 'active',
    emailVerifiedAt: new Date(),
    xp: 0,
    level: 1,
  }));

  const staff = [
    { username: 'sara.admin', name: 'سارة (مديرة)', email: 'sara.admin@voltade.test', role: adminRole, hash: adminHash },
    { username: 'khalid.editor', name: 'خالد (محرر)', email: 'khalid@voltade.test', role: editorRole, hash: playerHash },
    { username: 'dana.mod', name: 'دانة (مشرفة)', email: 'dana@voltade.test', role: moderatorRole, hash: playerHash },
  ];
  const staffIds: ID[] = [admin.id];
  for (const s of staff) {
    const existing = await db.identity.findUserByUsername(s.username);
    const u = existing ?? (await db.identity.createUser({
      username: s.username,
      email: s.email,
      displayName: s.name,
      passwordHash: s.hash,
      roleId: s.role,
      locale: 'ar',
      status: 'active',
      emailVerifiedAt: new Date(),
    }));
    staffIds.push(u.id);
  }

  const userIds: ID[] = [];
  /** Players created by *this* run — XP ledger rows and the welcome
   *  notification are append-only, so they are gated on "brand new user" to
   *  keep a re-seed from inflating anyone's score. */
  const createdUserIds: ID[] = [];
  if (demo) {
    for (const u of DEMO_USERS) {
      const existing = await db.identity.findUserByUsername(u.username);
      const row = existing ?? (await db.identity.createUser({
        username: u.username,
        email: u.email,
        displayName: u.name,
        passwordHash: playerHash,
        roleId: userRole,
        locale: 'ar',
        status: 'active',
        emailVerifiedAt: new Date(),
        xp: u.xp,
      }));
      userIds.push(row.id);
      if (!existing) createdUserIds.push(row.id);
    }
  }
  log(options, `users: ${1 + staff.length}${demo ? ` + ${DEMO_USERS.length} players` : ''}`);

  // 5. Categories (nested) + tags.
  const categoryIds = new Map<string, ID>();
  for (const [i, c] of CATEGORIES.entries()) {
    const existing = await db.catalog.findCategoryBySlug(c.slug);
    const row = existing ?? (await db.catalog.createCategory({
      slug: c.slug,
      name: c.ar,
      nameEn: c.en,
      icon: c.icon,
      color: c.color,
      sortOrder: i,
      isVisible: true,
      description: `${c.ar} — ${c.en}`,
      seoTitle: `ألعاب ${c.ar} مجانية أونلاين | Voltade`,
      seoDescription: `العب أفضل ألعاب ${c.ar} مباشرة في المتصفح بدون تحميل. ألعاب ${c.ar} جديدة أسبوعيًا على Voltade.`,
    }));
    categoryIds.set(c.slug, row.id);
    for (const [j, child] of (c.children ?? []).entries()) {
      const existingChild = await db.catalog.findCategoryBySlug(child.slug);
      if (existingChild) {
        categoryIds.set(child.slug, existingChild.id);
        continue;
      }
      const created = await db.catalog.createCategory({
        slug: child.slug,
        name: child.ar,
        nameEn: child.en,
        icon: child.icon,
        color: c.color,
        parentId: row.id,
        sortOrder: j,
        isVisible: true,
      });
      categoryIds.set(child.slug, created.id);
    }
  }
  log(options, `categories: ${categoryIds.size}`);

  // 6. Games.
  const gameIds = new Map<string, ID>();
  if (demo) {
    for (const g of DEMO_GAMES) {
      const existing = await db.catalog.findGameBySlug(g.slug);
      if (existing) {
        gameIds.set(g.slug, existing.id);
        continue;
      }
      const publishedAt = new Date(Date.now() - Math.floor(Math.random() * 60 + 5) * 86_400_000);
      const created = await db.catalog.createGame({
        slug: g.slug,
        title: g.ar,
        titleEn: g.en,
        description: g.description,
        descriptionEn: g.descriptionEn,
        instructions: g.instructions,
        developer: g.developer,
        kind: g.kind ?? 'iframe',
        url: `/games/${g.slug}/index.html`,
        width: g.width,
        height: g.height,
        orientation: g.width > g.height ? 'landscape' : 'portrait',
        sizeKb: g.sizeKb,
        thumbnailUrl: `/games/${g.slug}/thumb.svg`,
        bannerUrl: `/games/${g.slug}/banner.svg`,
        status: 'published',
        publishedAt,
        featured: g.featured ?? false,
        premium: false,
        ageRating: g.ageRating,
        providerSlug: 'voltade-demo',
        providerGameId: g.slug,
        sourceHash: demoHash('voltade-demo', g.slug, g.en),
        seoTitle: `لعبة ${g.ar} (${g.en}) مجانًا أونلاين | Voltade`,
        seoDescription: g.description.slice(0, 158),
        seoKeywords: [g.en, ...g.tags].join(', '),
        meta: { demo: true, engine: 'canvas', languages: ['ar', 'en'] },
      });
      gameIds.set(g.slug, created.id);

      await db.catalog.setGameCategories(
        created.id,
        g.categories.map((c) => categoryIds.get(c)).filter((x): x is ID => Boolean(x)),
      );
      await db.catalog.setGameTags(created.id, g.tags);

      // Seed the counters and the ratings/comments they come from so the public
      // numbers and the underlying rows agree (the nightly job would fix drift,
      // but a demo should not start drifted).
      await db.catalog.incrementGame(created.id, 'plays', g.plays);
      const stars = Math.round(g.rating);
      for (const [i, uid] of userIds.slice(0, 5).entries()) {
        await db.social.rate({ userId: uid, gameId: created.id, stars: Math.max(1, Math.min(5, stars - (i % 2))), review: null });
      }
    }
    log(options, `games: ${gameIds.size} playable demo builds`);
  }

  // 7. Provider import queue (staged, judged by hash) — this is the data the
  //    admin "Auto-fetch" screen shows, including one deliberate duplicate.
  const providers = [
    { slug: 'gamemonetize', name: 'GameMonetize', kind: 'gamemonetize', baseUrl: 'https://gamemonetize.com', feedUrl: 'https://gamemonetize.com/rss.php', isActive: true },
    { slug: 'gamedistribution', name: 'GameDistribution', kind: 'gamedistribution', baseUrl: 'https://gamedistribution.com', isActive: true },
    { slug: 'voltade-demo', name: 'Voltade Demo Pack', kind: 'json', isActive: true },
  ];
  const providerIds = new Map<string, ID>();
  for (const p of providers) {
    const row = await db.operations.upsertProvider(p);
    providerIds.set(p.slug, row.id);
  }

  if (demo) {
    // Staging is skipped when the provider already has items: the point of the
    // seed is a realistic review queue, not 8 more rows on every run. The real
    // cron path (providers/import.service.ts) always stages and relies on
    // source_hash uniqueness to deduplicate.
    const alreadyStaged = await db.operations.listProviderItems({ providerId: providerIds.get('gamemonetize')!, page: { page: 1, perPage: 1, offset: 0 } });
    if (alreadyStaged.total > 0) {
      log(options, `providers: ${providers.length} · ${alreadyStaged.total} items already staged — queue left untouched`);
    } else {
    const job = await db.operations.createImportJob({ providerId: providerIds.get('gamemonetize')!, triggeredBy: 'cron' });
    let fetched = 0;
    let duplicates = 0;
    for (const item of PROVIDER_QUEUE) {
      const pid = providerIds.get(item.provider)!;
      const hash = demoHash(item.provider, item.id, item.title);
      const staged = await db.operations.stageProviderItem({
        providerId: pid,
        providerGameId: item.id,
        sourceHash: hash,
        title: item.title,
        payload: { title: item.title, category: item.category, provider: item.provider },
      });
      fetched++;
      if (staged.existed) {
        duplicates++;
        await db.operations.markProviderItem(staged.id, 'duplicate');
        continue;
      }
      // The second "Desert Drift Rally" arrives from a *different* provider with a
      // different provider id, so the id hash cannot see it. The title hash is
      // deliberately provider-independent: same game, two distributors, one
      // catalogue entry. (The real importer hashes the normalised feed URL too.)
      const titleHash = demoHash('title', '', item.title);
      const titleTwin = await db.operations.stageProviderItem({
        providerId: pid,
        providerGameId: `${item.id}-title`,
        sourceHash: titleHash,
        title: item.title,
        payload: { title: item.title },
      });
      await db.operations.markProviderItem(titleTwin.id, titleTwin.existed ? 'duplicate' : 'new');
      if (titleTwin.existed) duplicates++;
      await db.operations.markProviderItem(staged.id, 'new');
    }
    await db.operations.updateImportJob(job.id, {
      status: 'partial',
      fetchedCount: fetched,
      importedCount: 0,
      duplicateCount: duplicates,
      failedCount: 0,
      finishedAt: new Date(),
      error: 'auto-publish is off — items are waiting for review',
    });
    log(options, `providers: ${providers.length} · staged ${fetched} items (${duplicates} duplicates caught)`);
    }

    // 8. Play history over 30 days → rolled up into daily_stats for the dashboard.
    const devices = ['desktop', 'mobile', 'mobile', 'tablet', 'desktop'];
    const sources = [null, 'https://www.google.com/', 'https://t.co/', 'https://www.facebook.com/', null, 'https://discord.com/'];
    const countries = ['SA', 'EG', 'AE', 'MA', 'US', 'JO', 'DZ', 'IQ'];
    const slugs = [...gameIds.keys()];
    let playRows = 0;
    const existingPlays = await db.engagement.countPlays();
    if (existingPlays > 0) {
      log(options, `plays: ${existingPlays} sessions already recorded — history left untouched`);
    } else {
    // A deterministic-ish pseudo random stream: `Math.random` would make two
    // seeds of the same database disagree, which makes demo screenshots
    // irreproducible. Mulberry32 over a fixed seed is 5 lines and enough here.
    let s32 = 0x2f6e2b1;
    const rnd = () => {
      s32 |= 0; s32 = (s32 + 0x6d2b79f5) | 0;
      let t = Math.imul(s32 ^ (s32 >>> 15), 1 | s32);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let day = 29; day >= 0; day--) {
      const midnight = new Date();
      midnight.setUTCHours(0, 0, 0, 0);
      const when = midnight.getTime() - day * 86_400_000;
      // Weekends (Fri/Sat) and the last week are busier — the dashboard chart
      // should have a shape, not a flat line.
      const dow = new Date(when).getUTCDay();
      const volume = 9 + ((dow === 5 || dow === 6) ? 11 : 0) + (day < 7 ? 9 : 0) + ((rnd() * 6) | 0);
      for (let i = 0; i < volume; i++) {
        const slug = slugs[(rnd() * slugs.length) | 0];
        const gameId = slug ? gameIds.get(slug) : undefined;
        if (!gameId) continue;
        await db.engagement.recordPlay({
          gameId,
          userId: userIds.length ? userIds[(rnd() * userIds.length) | 0] ?? null : null,
          sessionId: `sess-${(rnd() * 40) | 0}`,
          device: devices[(rnd() * devices.length) | 0] ?? 'desktop',
          country: countries[(rnd() * countries.length) | 0] ?? null,
          referrer: sources[(rnd() * sources.length) | 0] ?? null,
          utmSource: rnd() > 0.88 ? 'newsletter' : null,
          at: new Date(when + ((rnd() * 86_400_000) | 0)),
          durationMs: 45_000 + ((rnd() * 420_000) | 0),
        });
        playRows++;
      }
    }
    log(options, `plays: ${playRows} sessions written across 30 days`);
    }
    // rollupDailyStats is per-day (that is how the nightly cron calls it), so the
    // seed replays the month — the same statements the cron would run. It is an
    // upsert, so re-running after a partial seed repairs the charts.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    for (let day = 29; day >= 0; day--) {
      await db.engagement.rollupDailyStats(new Date(midnight.getTime() - day * 86_400_000));
    }
    log(options, `daily_stats: 30 days rolled up (site / game / source / device / country)`);

    // 9. Comments (nested), likes, favourites, a playlist.
    //    Every write here is guarded by a read first, because a re-seed must be
    //    a no-op: comments would double, `toggleFavorite` would *un*favourite,
    //    and a playlist slug collides with its own unique index.
    const alreadyCommented = new Set<string>();
    for (const c of COMMENTS) {
      const gameId = gameIds.get(c.game);
      if (!gameId) continue;
      if (alreadyCommented.has(c.game)) continue;
      const prior = await db.social.listComments({ gameId, page: { page: 1, perPage: 1, offset: 0 }, tree: false });
      if (prior.total > 0) {
        alreadyCommented.add(c.game);
        continue;
      }
      const authorId = userIds[c.author % Math.max(userIds.length, 1)] ?? null;
      const root = await db.social.createComment({
        gameId,
        userId: authorId,
        authorName: authorId ? undefined : 'زائر',
        body: c.ar,
        status: 'visible',
      });
      let previous = root.id;
      for (const r of c.replies ?? []) {
        const rid = userIds[r.author % Math.max(userIds.length, 1)] ?? null;
        const child = await db.social.createComment({ gameId, userId: rid, parentId: previous, body: r.text, status: 'visible' });
        previous = child.id;
      }
      alreadyCommented.add(c.game);
    }
    // One comment awaiting moderation, so the queue is not empty on day one.
    const firstGameId = [...gameIds.values()][0];
    if (firstGameId) {
      const pending = await db.social.listComments({ gameId: firstGameId, status: 'pending', page: { page: 1, perPage: 1, offset: 0 }, tree: false });
      if (pending.total > 0) {
        // already seeded
      } else await db.social.createComment({
        gameId: firstGameId,
        userId: null,
        authorName: 'زائر مجهول',
        authorEmail: 'guest@example.com',
        body: 'تعليق بانتظار المراجعة — هذه رسالة تجريبية تظهر في طابور الإشراف.',
        status: 'pending',
      });
    }
    if (userIds.length > 1 && gameIds.size > 0) {
      const [u1, u2] = userIds as [ID, ID, ...ID[]];
      const slugs = [...gameIds.keys()];
      for (const slug of slugs) {
        const gid = gameIds.get(slug)!;
        await db.social.vote({ userId: u1, targetKind: 'game', targetId: gid, value: 1 }); // upsert: idempotent
        if (slug === slugs[0]) await db.social.vote({ userId: u2, targetKind: 'game', targetId: gid, value: -1 });
        if (!(await db.social.isFavorite(u1, gid))) await db.social.toggleFavorite(u1, gid);
      }
      const existingPlaylist = await db.social.findPlaylist('evening-session', u1);
      const playlist =
        existingPlaylist ??
        (await db.social.createPlaylist({
          userId: u1,
          name: 'جلسة المساء',
          slug: 'evening-session',
          description: 'ألعاب سريعة قبل النوم',
          visibility: 'public',
        }));
      for (const slug of slugs.slice(0, 4)) await db.social.addGameToPlaylist(playlist.id, gameIds.get(slug)!);
    }
    log(options, `comments: ${COMMENTS.length} threads · playlist + votes + favourites`);

    // 10. Achievements, a couple of unlocks and XP ledger rows — so the profile
    //     page (badges, level, progress bars) has something real to render.
    for (const a of ACHIEVEMENTS) {
      const row = await db.engagement.upsertAchievement({
        slug: a.slug,
        name: a.ar,
        description: a.en,
        tier: a.tier as 'bronze' | 'silver' | 'gold' | 'platinum',
        xp: a.xp,
        rule: a.rule,
        icon: a.tier === 'gold' ? '🏆' : a.tier === 'silver' ? '🥈' : '🎖️',
      });
      // The top two players already have history: give them their earned badges.
      for (const [i, uid] of userIds.slice(0, 2).entries()) {
        if (i === 0 || a.slug !== 'player-200') await db.engagement.unlockAchievement(uid, row.id);
      }
    }
    if (createdUserIds.length > 0) {
      // unlockAchievement() already credits each badge's XP to xp_events, so the
      // only extra ledger rows here are plain gameplay ones — and only for users
      // this run actually created.
      const first = createdUserIds[0]!;
      const second = createdUserIds[1];
      await db.engagement.awardXp({ userId: first, amount: 5, reason: 'game.play', targetKind: 'user', targetId: first });
      if (second) await db.engagement.awardXp({ userId: second, amount: 5, reason: 'game.play', targetKind: 'user', targetId: second });
      await db.engagement.notify({
        userId: first,
        kind: 'achievement',
        title: 'شارة جديدة: لاعب منتظم',
        body: 'لعبت ١٠ ألعاب هذا الأسبوع — تابع لتفتح شارة أسطورة البوابة.',
        link: '/me',
      });
    }
    log(options, `achievements: ${ACHIEVEMENTS.length} (+ unlocks, XP, notification)`);
  }

  // 11. Blog + static pages.
  const blogCategories = [
    { slug: 'industry', name: 'صناعة الألعاب', en: 'Industry' },
    { slug: 'technical', name: 'تقني', en: 'Technical' },
    { slug: 'guides', name: 'أدلة المشغّل', en: 'Operator guides' },
    { slug: 'design', name: 'تصميم', en: 'Design' },
  ];
  const blogCategoryIds = new Map<string, ID>();
  for (const [i, bc] of blogCategories.entries()) {
    const all = await db.content.listBlogCategories();
    const existing = all.find((c) => c.slug === bc.slug);
    const row = existing ?? (await db.content.createBlogCategory({ slug: bc.slug, name: bc.name, sortOrder: i }));
    blogCategoryIds.set(bc.slug, row.id);
  }
  if (demo) {
    for (const [i, post] of BLOG_POSTS.entries()) {
      const existing = await db.content.findPostBySlug(post.slug);
      if (existing) continue;
      const created = await db.content.createPost({
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        body: post.body,
        authorId: staffIds[i % staffIds.length] ?? admin.id,
        categoryId: blogCategoryIds.get(post.category) ?? null,
        status: 'published',
        publishedAt: new Date(Date.now() - (i + 2) * 86_400_000 * 3),
        readingMinutes: Math.max(2, Math.round(post.body.split(/\s+/).length / 200)),
        seoTitle: post.title,
        seoDescription: post.excerpt,
        coverImage: `/brand/blog-${i + 1}.svg`,
      });
      await db.content.setPostTags(created.id, post.tags);
    }
    log(options, `blog: ${BLOG_POSTS.length} posts · ${blogCategories.length} categories`);
  }

  const pages = [
    {
      slug: 'about',
      title: 'من نحن',
      titleEn: 'About',
      body: 'Voltade بوابة ألعاب HTML5: نختار الألعاب، نفحصها، وننشرها لتعمل فورًا في متصفحك.',
      blocks: [
        { type: 'hero', props: { title: 'من نحن', subtitle: 'بوابة ألعاب HTML5 تعمل فورًا' } },
        { type: 'rich_text', props: { markdown: 'Voltade مشروع مستقل يركّز على ثلاثة أشياء: **الاختيار** (لا ننشر كل ما يصلنا)، **الأداء** (صفحة لعبة تُرسم في أقل من ثانية)، و**الاحترام** (لا إعلانات بينية مزعجة ولا تتبّع خفي).' } },
        { type: 'stat_row', props: { stats: [{ label: 'لعبة', value: '6+' }, { label: 'تصنيف', value: '14' }, { label: 'زمن تحميل', value: '<1s' }] } },
      ],
      status: 'published',
      isIndexed: true,
    },
    {
      slug: 'privacy',
      title: 'سياسة الخصوصية',
      titleEn: 'Privacy',
      body: 'ما نجمعه، لماذا نجمعه، وكيف تحذفه.',
      blocks: [
        { type: 'hero', props: { title: 'سياسة الخصوصية' } },
        {
          type: 'rich_text',
          props: {
            markdown: [
              '## ما نجمعه',
              '- **حساب**: اسم مستخدم، بريد إلكتروني (اختياري عند اللعب كضيف)، كلمة مرور مخزّنة بـ Argon2id.',
              '- **لعب**: معرّف جلسة مجهول، اسم اللعبة، الوقت، الجهاز، مصدر الزيارة. لا نبيع هذه البيانات.',
              '- **تعليقات**: نص التعليق وبصمة (hash) لعنوان IP لأغراض منع الإغراق فقط.',
              '',
              '## ما لا نجمعه',
              'لا نتتبع موقعك الجغرافي الدقيق، ولا نقرأ جهات اتصالك، ولا نشغّل ملفات تعريف ارتباط إعلانية دون موافقة صريحة.',
              '',
              '## حذف بياناتك',
              'من صفحة ملفك الشخصي → "حذف الحساب". يُحذف الحساب وتعليقاتك خلال ٣٠ يومًا، وتبقى الإحصائيات المجمّعة (بدون معرّفات).',
            ].join('\n'),
          },
        },
      ],
      status: 'published',
      isIndexed: true,
    },
    {
      slug: 'terms',
      title: 'شروط الاستخدام',
      titleEn: 'Terms',
      body: 'باستخدامك Voltade فإنك توافق على الشروط التالية.',
      blocks: [
        { type: 'hero', props: { title: 'شروط الاستخدام' } },
        { type: 'rich_text', props: { markdown: '## الاستخدام المقبول\nلا تُسيء استخدام المنصة: لا تنشر محتوى مسيء، ولا تحاول اختراق الخدمة، ولا تعيد نشر الألعاب التي نملك حقوق توزيعها.\n\n## الألعاب التابعة لأطراف ثالثة\nبعض الألعاب مستوردة من موزّعين (GameMonetize / GameDistribution) وتخضع لشروطهم. نعرض مصدر كل لعبة في صفحتها.\n\n## الاشتراك\nيمكن إلغاء الاشتراك في أي وقت من صفحة الحساب، ويسري الإلغاء في نهاية الفترة المدفوعة.' } },
      ],
      status: 'published',
      isIndexed: true,
    },
    {
      slug: 'contact',
      title: 'اتصل بنا',
      titleEn: 'Contact',
      body: 'للاقتراحات أو الإبلاغ عن لعبة معطّلة.',
      blocks: [
        { type: 'hero', props: { title: 'اتصل بنا' } },
        { type: 'rich_text', props: { markdown: 'راسلنا على **hello@voltade.test** أو عبر نموذج الإبلاغ داخل صفحة أي لعبة.' } },
      ],
      status: 'published',
      isIndexed: true,
    },
  ];
  for (const [i, p] of pages.entries()) {
    const existing = await db.content.findPageBySlug(p.slug);
    if (existing) continue;
    await db.content.createPage({ ...p, sortOrder: i, template: 'default' });
  }
  log(options, `pages: ${pages.length}`);

  // 12. Ads — a labelled placeholder for every placement, so the layout can be
  //     reviewed before a real network is connected. No third-party code runs.
  const adSlots = [
    { placement: 'header', name: 'Header banner (728×90)', type: 'html', priority: 10 },
    { placement: 'in_feed', name: 'In-feed native', type: 'html', priority: 10 },
    { placement: 'game_side', name: 'Game page sidebar (300×250)', type: 'html', priority: 10 },
    { placement: 'interstitial', name: 'Interstitial between games', type: 'html', priority: 20, status: 'paused' },
    { placement: 'footer', name: 'Footer banner', type: 'html', priority: 5 },
  ];
  for (const slot of adSlots) {
    const existing = (await db.commerce.listAds({ placement: slot.placement }))[0];
    if (existing) continue;
    await db.commerce.createAd({
      name: slot.name,
      placement: slot.placement,
      type: slot.type as 'html',
      status: (slot.status ?? 'active') as 'active',
      priority: slot.priority,
      code: `<div class="ad-placeholder" data-placement="${slot.placement}">مساحة إعلانية — ${slot.name}<br/><small>اربط AdSense / GAM / Prebid من لوحة التحكم</small></div>`,
      targeting: { loggedOutOnly: false, categories: [], countries: [] },
    });
  }
  log(options, `ads: ${adSlots.length} placements`);

  // 13. Plans + one demo subscription (so the premium path is testable).
  const plans = [
    { slug: 'premium-month', name: 'بريميوم شهري', description: 'بدون إعلانات + ألعاب حصرية', priceCents: 399, currency: 'usd', interval: 'month', features: ['بدون إعلانات', 'ألعاب حصرية', 'شارة بريميوم'], stripePriceId: 'price_demo_month' },
    { slug: 'premium-year', name: 'بريميوم سنوي', description: 'شهران مجانًا', priceCents: 3990, currency: 'usd', interval: 'year', features: ['بدون إعلانات', 'ألعاب حصرية', 'شهران مجانًا'], stripePriceId: 'price_demo_year', sortOrder: 1 },
    { slug: 'supporter', name: 'داعم', description: 'دفعة واحدة لدعم المشروع', priceCents: 1500, currency: 'usd', interval: 'lifetime', removesAds: true, features: ['بدون إعلانات للأبد', 'شارة الداعم'], sortOrder: 2 },
  ];
  for (const [i, p] of plans.entries()) {
    const existing = await db.commerce.findPlanBySlug(p.slug);
    if (existing) continue;
    await db.commerce.createPlan({
      slug: p.slug,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: p.currency,
      interval: p.interval,
      isActive: true,
      removesAds: p.removesAds ?? true,
      features: p.features,
      stripePriceId: p.stripePriceId ?? null,
      paypalPlanId: null,
      sortOrder: p.sortOrder ?? i,
    });
  }
  if (demo && userIds.length > 2) {
    const yearPlan = await db.commerce.findPlanBySlug('premium-year');
    if (yearPlan) {
      await db.commerce.upsertSubscription({
        userId: userIds[2]!,
        planId: yearPlan.id,
        status: 'active',
        provider: 'stripe',
        providerSubscriptionId: 'sub_demo_0001',
        currentPeriodStart: new Date(Date.now() - 10 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 355 * 86_400_000),
      });
      await db.commerce.recordPayment({
        userId: userIds[2]!,
        subscriptionId: null,
        provider: 'stripe',
        providerPaymentId: 'pi_demo_0001',
        amountCents: 3990,
        currency: 'usd',
        status: 'succeeded',
        meta: { demo: true },
      });
    }
  }
  log(options, `plans: ${plans.length}`);

  // 14. Redirects, releases, backups — the operational furniture.
  await db.operations.upsertRedirect({ sourcePath: '/games/snake', targetPath: '/game/snake-volt', statusCode: 301 });
  await db.operations.upsertRedirect({ sourcePath: '/category/arcade-games', targetPath: '/category/arcade', statusCode: 301 });

  const existingReleases = await db.operations.listReleases('stable');
  if (existingReleases.length === 0) {
    await db.operations.upsertRelease({
      version: '1.0.0',
      channel: 'stable',
      notes: 'الإصدار الأول: بوابة الألعاب، لوحة التحكم، الجلب التلقائي، الاشتراكات.',
      packageUrl: null,
      checksumSha256: null,
      isMandatory: false,
      releasedAt: new Date(),
    });
  }

  // 15. Audit trail. This is the ONE row a re-seed adds on purpose: an audit log
  //     that hides repeated seeds would be lying about what happened.
  await db.operations.logActivity({
    actorId: admin.id,
    actorLabel: admin.username,
    action: generated ? 'system.seed.generated_admin_password' : 'system.seed',
    targetKind: 'user',
    targetId: admin.id,
    after: { demo, games: gameIds.size, categories: categoryIds.size },
  });

  return { adminPassword: generated ? adminPassword : undefined };
}

/** Deterministic content hash used for the demo rows. The real one lives in
 *  @voltade/api (providers/dedupe.ts) and hashes the normalised feed URL too. */
export function demoHash(provider: string, providerId: string, title: string): string {
  const input = [provider, providerId, slugify(title)].join('|');
  // FNV-1a over the input, hex-padded to 64 chars so it fits the column and is
  // obviously not a real sha256 in the database.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) * (i + 7), 2246822519) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4).slice(0, 64);
}
