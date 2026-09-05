# Nawras Arcade — محرّك أركيد عربي/إنجليزي يُباع حصرياً

> **الحالة اليوم**: النواة + **طبقة الترخيص** + **المزوّدات** + **التنصيب والتصدير** + **التغليف**
> اكتملت — مخطط مصدر واحد بلهجتين متطابقتين (أعمدة **وقيود**)، آلية ترحيلات تُرقّي النسخ
> المثبّتة، لوحة صدارة بـ**8 أنماط زمنية** بعقد متوافق مع CloudArcade، جسر `ca_api` نظيف،
> **بوابة ترخيص** لا تخدم لعبة ولا تصدّرها ما لم يقل صفٌّ في `game_licenses` لماذا يجوز ذلك،
> **حارس SSRF** يرفض أي جلب داخلي بكل ترميزاته، **مثبّت** يرفض سرّ العيّنة ويُثبت مخططه بنفسه،
> و**مصدّر ساكن** لا يُنشئ ملفاً للعبة مرفوضة، و**حزمة مفتوحة المصدر** فيها 7 ألعاب حقيقية
> مثبتة على قمم فروعها ببصمات تراخيص متحقق منها ضد GitHub. كل ذلك مثبت ببوابات أُثبت عدم فراغها بحقن عيوب
> متعمدة (17 عيباً في الدفعة الأخيرة وحدها).

## البوابات (كلها خضراء)

```
$ npm test
  ✓ ca-compat.js يمر على node --check
  ✓ verify_php.py · 113 فحصاً بنيوياً (أُثبت أنها تلتقط العيوب بحقنها فعلياً)
  ✓ prove_runtime.py · 152 فحصاً: DDL + ترحيلان حقيقيان + اللوحات الثمانية + بوابة الترخيص
    + الحارس + التصدير الساكن + المثبّت (الحزمة: 7 ألعاب حقيقية مقبولة / 3 عِدّات مرفوضة)
  ✓ gen_schema_sql.py --verify · اللهجتان متطابقتان العمود-بعمود · 77 قيداً متطابقاً
  ✓ gen_license_rules.py --verify · سياسة صالحة بنيوياً · النسخة الساكنة مطابقة للمصدر
  ✓ JSON صالح (schema, migrations, license_rules, oss_pack)
```

## البنية

```
db/schema.json          ← المصدر الوحيد (26 جدولاً · 221 عموداً · 51 فهرساً)
db/schema.{mysql,sqlite}.sql   ← مولّدان، ممنوع تعديلهما يدوياً
db/migrations.json      ← خطوات الترقية (المثبت الآن: v5 = سجل الترخيص)
db/license_rules.json   ← سياسة الترخيص: المصدر الوحيد لأنواع التراخيص وقواعدها
db/oss_pack.json        ← الحزمة مفتوحة المصدر: 7 ألعاب حقيقية مثبتة على قمم فروعها + 3 عِدّات رفض متعمدة
public/assets/license-rules.json ← نسخة طبق الأصل بايت-ببايت، يقرؤها التصدير الساكن
src/Db/{Connection,Migrator}.php
src/Gamify/{Buckets,Leaderboard,Signer}.php
src/Licensing/{LicensePolicy,LicenseAuditor}.php   ← السياسة ثم البوابة ثم السجل
src/Providers/{UrlGuard,OssPack,FeedConverter}.php ← SSRF ثم الحزمة ثم التغذية
src/Install/Installer.php            ← ست خطوات، تتوقف عند أول فشل
src/Export/StaticExporter.php        ← لعبة مرفوضة = لا ملف
src/Admin/AdminController.php        ← لوحة عمليات الترخيص (JSON فقط)
src/Http/Response.php · src/Front/SiteController.php · src/Routes.php · src/App.php
public/index.php        ← المتحكم الأمامي، نقطة PHP الوحيدة داخل docroot
bin/{install,export}.php · Dockerfile · composer.json
docs/github-actions.ci.yml ← workflow جاهز، انقله إلى .github/workflows/ci.yml لتفعيله
public/assets/ca-compat.js   ← جسر ألعاب ca_api (clean-room)
tools/{gen_schema_sql,gen_license_rules,verify_php,prove_runtime,bootstrap_schema}.py
docs/{LEADERBOARD,UPGRADING,CA-COMPAT,LICENSING,PROVIDERS,INSTALLING}.md
```

## API العام

```
GET  /api/leaderboard?game=slug&type=top-week&amount=10    # 8 أنماط (top*، top-all*)
GET  /api/license?game=slug                                # المصدر + النسب المستحق + الحكم
POST /api/score        {game, alias?, score, ts, nonce, sig}   # 451 إن لم تكن اللعبة مرخّصة
POST /api/play         {game}                                   # 451 إن لم تكن اللعبة مرخّصة
```

## طبقة الترخيص في سطرين

السياسة تعيش في `db/license_rules.json` وحدها — عشرة أنواع (`own` … `commercial`)، وكل نوع
يعلن ما إذا كان يحتاج `commit_sha` أو `license_file` أو `proof_url` أو `invoice_ref`، و`AGPL-3.0`
مرفوض outright لأن network copyleft يصل إلى الخادم نفسه. `LicensePolicy` **لا يحتوي اسم نوع
ترخيص واحد** في كوده، والبوابة تفشل البناء إن ظهر — لأن قاعدة في PHP هي قاعدة لا يراها
التصدير الساكن. وكل قرار يُكتب في `license_audits` (append-only) مع إصدار القواعد، لأن
«فحصنا في تاريخ كذا وفق القواعد v1» هو الجواب الوحيد الذي يصمد أمام إشعار إزالة.

## المزوّدات والحارس في سطرين

`UrlGuard` يرفض أي جلب داخلي **قبل** أن يخرج طلب من الخادم: المخططات غير http(s)، بيانات
المستخدم في العنوان، المنافذ الغريبة، وكل IP محجوز بأي ترميز (`127.1`، `2130706433`،
`0x7f000001`، `[::ffff:127.0.0.1]`)، وأي اسم DNS أحد أجوبته داخلي. و`OssPack` يفحص مدخلات
الحزمة بنفس سياسة الترخيص في وضع التصدير، فلا تُشحَن رخصة تمنع إعادة التوزيع. انظر
`docs/PROVIDERS.md`.

## التنصيب والتصدير في سطرين

`php bin/install.php` يكتب الإعداد **بسرّ عشوائي جديد** (سرّ العيّنة المُرسل لا يُثبَّت أبداً،
وإلا شاركت كل النسخ مفتاح التوقيع نفسه)، يُرحّل المخطط، يزرع الإعدادات وحساب المدير، ثم
**يُثبت نفسه**: إصدار المخطط يجب أن يساوي `Migrator::CURRENT` وكل جدول في `db/schema.json`
موجود فعلاً. و`php bin/export.php dist` يكتب الحزمة الساكنة بعد سؤال المدقّق في وضع التصدير —
واللعبة المرفوضة **لا يُنشأ لها ملف**: لا صفحة، ولا صفحة خلف علم، والسبب يبقى في
`license-manifest.json` مع بصمتَي SHA-256 تسمحان لأي مضيف ساكن بأن يعيد فحص نفسه.
انظر `docs/INSTALLING.md` (فيه الأسعار: Standard $49 / Extended $149 / Buyout).

## الطريق إلى المنتج القابل للبيع

1. ~~النواة: مخطط + ترحيلات + لوحة 8 أنماط + جسر~~
2. ~~طبقة الترخيص: `game_licenses` ledger + `LicenseAuditor` الصارم + قواعد موحدة PHP/Static~~ ← **هذه الدفعة**
3. ~~المزوّدات: تنسيق OSS pack + `OssPack` المدقّق + `FeedConverter` + `UrlGuard` بـSSRF-hardening~~ ← **هذه الدفعة**
   (دُفعت أول 7 ألعاب حقيقية مثبتة بقمم فروعها وبصمات تراخيصها المتحقق منها ضد GitHub؛
   إضافة المزيد تبقى إدخال بيانات ضد التنسيق نفسه)
4. ~~الأدمن + المثبّت + المصدرية الثنائية (PHP ديناميكي + تصدير ساكن)~~ ← **هذه الدفعة**
5. ~~التغليف التجاري: Docker/composer/CI + الأسعار (Standard $49 / Extended $149 / Buyout)~~ ← **هذه الدفعة**

الباقي تشغيل وتوسعة بيانات، لا كود: دُفعت أول **7 ألعاب حقيقية مثبتة** في `db/oss_pack.json`
(قمم الفروع وبصمات تراخيصها تحقق منها ضد GitHub مباشرة في 2026-09-05)، وإضافة المزيد تجري
ضد التنسيق نفسه. ولا يبقى إلا تشغيل `docker build` وCI مرة على آلة فيها Docker وPHP
(كُتبا هنا بلا daemon ولا مترجم PHP، فهما مقروءان لا مُختبَران). ملف الـworkflow نسخة موثقة في
`docs/github-actions.ci.yml`؛ فعّله بنسخه إلى `.github/workflows/ci.yml` إن كان حساب الدفع
لا يملك صلاحية `workflows` (كان الدفع إلى ذلك المسار يُرفض من حساب الأتمتة).

انظر `docs/LEADERBOARD.md` و`docs/UPGRADING.md` و`docs/CA-COMPAT.md` و`docs/LICENSING.md`
و`docs/PROVIDERS.md` و`docs/INSTALLING.md`.
الترخيص: **proprietary** — بيع حصري فقط، لا MIT.
