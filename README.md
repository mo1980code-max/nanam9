# Nawras Arcade — محرّك أركيد عربي/إنجليزي يُباع حصرياً

> **الحالة اليوم**: النواة القابلة للتنفيذ اكتملت — مخطط مصدر واحد بلهجتين متطابقتين،
> **آلية ترحيلات** تجعل النسخ المثبّتة قابلة للترقية، ولوحة صدارة بـ**8 أنماط زمنية**
> بعقد متوافق مع CloudArcade، وجسر `ca_api` نظيف، وكلها مثبتة ببوابات مُثبتة عدم-فراغها.

## البوابات (كلها خضراء)

```
$ npm test
  ✓ ca-compat.js يمر على node --check
  ✓ verify_php.py · 26 فحصاً بنيوياً (أُثبت أنها تلتقط العيوب بحقنها فعلياً)
  ✓ prove_runtime.py · 19 فحصاً: DDL كامل + ترحيل حقيقي v2→v3 + اللوحات الثمانية
  ✓ gen_schema_sql.py --verify · اللهجتان متطابقتان العمود-بعمود
  ✓ JSON صالح (schema.json, migrations.json)
```

## البنية

```
db/schema.json          ← المصدر الوحيد (25 جدولاً · 210 أعمدة · 47 فهرساً)
db/schema.{mysql,sqlite}.sql   ← مولّدان، ممنوع تعديلهما يدوياً
db/migrations.json      ← خطوات الترقية لكل إصدار (المثبت الآن: v3 = سلال لوحة الصدارة)
src/Db/{Connection,Migrator}.php
src/Gamify/{Buckets,Leaderboard,Signer}.php
src/Http/Response.php · src/Front/SiteController.php · src/Routes.php · src/App.php
public/assets/ca-compat.js   ← جسر ألعاب ca_api (clean-room)
tools/{gen_schema_sql,verify_php,prove_runtime,bootstrap_schema}.py
docs/{LEADERBOARD,UPGRADING,CA-COMPAT}.md
```

## API العام

```
GET  /api/leaderboard?game=slug&type=top-week&amount=10    # 8 أنماط (top*، top-all*)
POST /api/score        {game, alias?, score, ts, nonce, sig}
POST /api/play         {game}
```

## الطريق إلى المنتج القابل للبيع (الباقي على الدفعات القادمة)

1. ~~النواة: مخطط + ترحيلات + لوحة 8 أنماط + جسر~~ ← **هذه الدفعة**
2. طبقة الترخيص: `game_licenses` ledger + `LicenseAuditor` الصارم + قواعد موحدة PHP/Static
3. المزوّدات: OSS pack (50 لعبة pinned على commit) + محوّلات feed بـSSRF-hardening
4. الأدمن + المثبّت + المصدرية الثنائية (PHP ديناميكي + تصدير ساكن)
5. التغليف التجاري: Docker/composer/CI + الأسعار (Standard $49 / Extended $149 / Buyout)

انظر `docs/LEADERBOARD.md` و`docs/UPGRADING.md` و`docs/CA-COMPAT.md` للتفاصيل.
الترخيص: **proprietary** — بيع حصري فقط، لا MIT.
