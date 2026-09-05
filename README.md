# Nawras Arcade — محرّك أركيد عربي/إنجليزي يُباع حصرياً

> **الحالة اليوم**: النواة + **طبقة الترخيص** + **المزوّدات** اكتملت — مخطط مصدر واحد بلهجتين
> متطابقتين (أعمدة **وقيود**)، آلية ترحيلات تُرقّي النسخ المثبّتة، لوحة صدارة بـ**8 أنماط
> زمنية** بعقد متوافق مع CloudArcade، جسر `ca_api` نظيف، **بوابة ترخيص** لا تخدم لعبة ولا
> تصدّرها ما لم يقل صفٌّ في `game_licenses` لماذا يجوز ذلك، و**حارس SSRF** يرفض أي جلب داخلي
> بكل ترميزاته. كل ذلك مثبت ببوابات أُثبت عدم فراغها بحقن عيوب متعمدة.

## البوابات (كلها خضراء)

```
$ npm test
  ✓ ca-compat.js يمر على node --check
  ✓ verify_php.py · 77 فحصاً بنيوياً (أُثبت أنها تلتقط العيوب بحقنها فعلياً)
  ✓ prove_runtime.py · 104 فحوص: DDL + ترحيلان حقيقيان + اللوحات الثمانية + بوابة الترخيص + الحارس
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
db/oss_pack.json        ← الحزمة مفتوحة المصدر، كل مدخلة مثبّتة على commit
public/assets/license-rules.json ← نسخة طبق الأصل بايت-ببايت، يقرؤها التصدير الساكن
src/Db/{Connection,Migrator}.php
src/Gamify/{Buckets,Leaderboard,Signer}.php
src/Licensing/{LicensePolicy,LicenseAuditor}.php   ← السياسة ثم البوابة ثم السجل
src/Providers/{UrlGuard,OssPack,FeedConverter}.php ← SSRF ثم الحزمة ثم التغذية
src/Http/Response.php · src/Front/SiteController.php · src/Routes.php · src/App.php
public/assets/ca-compat.js   ← جسر ألعاب ca_api (clean-room)
tools/{gen_schema_sql,gen_license_rules,verify_php,prove_runtime,bootstrap_schema}.py
docs/{LEADERBOARD,UPGRADING,CA-COMPAT,LICENSING,PROVIDERS}.md
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

## الطريق إلى المنتج القابل للبيع (الباقي على الدفعات القادمة)

1. ~~النواة: مخطط + ترحيلات + لوحة 8 أنماط + جسر~~
2. ~~طبقة الترخيص: `game_licenses` ledger + `LicenseAuditor` الصارم + قواعد موحدة PHP/Static~~ ← **هذه الدفعة**
3. ~~المزوّدات: تنسيق OSS pack + `OssPack` المدقّق + `FeedConverter` + `UrlGuard` بـSSRF-hardening~~ ← **هذه الدفعة**
   (الباقي هنا إدخال بيانات: انتقاء الـ50 لعبة الحقيقية بأدلتها المثبتة — التنسيق والمدقّق جاهزان)
4. الأدمن + المثبّت + المصدرية الثنائية (PHP ديناميكي + تصدير ساكن)
5. التغليف التجاري: Docker/composer/CI + الأسعار (Standard $49 / Extended $149 / Buyout)

انظر `docs/LEADERBOARD.md` و`docs/UPGRADING.md` و`docs/CA-COMPAT.md` و`docs/LICENSING.md` و`docs/PROVIDERS.md`.
الترخيص: **proprietary** — بيع حصري فقط، لا MIT.
