# التنصيب والتصدير — Installing, exporting, and what each licence tier allows

This package runs on PHP 8.1+ with either MySQL or SQLite. There is no build step, no Node
runtime requirement, and no framework to learn. `php bin/install.php` is the whole installation.

---

## 1. Quick start (SQLite, zero configuration)

```bash
unzip arcade.zip && cd arcade
php bin/install.php --admin-user=admin
php -S 0.0.0.0:8080 -t public
```

Point the browser at `http://localhost:8080`. The installer prints one line per step and stops at
the first failure:

```
  ✓ environment   PHP 8.3.4 · pdo drivers: mysql, sqlite
  ✓ config        config/config.php written with a fresh 32-byte secret
  ✓ migrate       5 migration step(s) applied
  ✓ seed          5 setting(s) upserted · admin "admin" ensured
  ✓ self_check    schema v5 · 26 tables present, none missing
```

## 2. Production (MySQL)

```bash
cp config/config.sample.php config/config.php
#   edit config/config.php: set 'driver' => 'mysql' and fill in the credentials
php bin/install.php
```

`config/config.php` is gitignored. `var/` must be writable by the web server user — the installer
checks this before it writes anything, because a permissions failure halfway through a migration is
the worst place to discover it.

## 3. Docker

```bash
docker build -t arcade .                     # the build fails if any gate fails
docker run --rm -p 8080:8080 -v arcade-var:/app/var arcade
```

The `gates` build stage runs every structural and runtime gate, so an image that cannot prove its
two SQL dialects agree does not build at all.

> The Dockerfile in this repository was written but **not built** — the environment that produced
> it has no Docker daemon. Treat it as reviewed by reading until you run it once yourself.

## 4. What the installer guarantees

| Step | Refuses to continue when |
|---|---|
| `environment` | PHP < 8.1, a required extension is missing, PDO has neither `mysql` nor `sqlite`, or `var/` is not writable |
| `config` | the sample config is missing from the package |
| `secret` | the configured secret is shorter than 32 bytes |
| `migrate` | a migration step fails and is not on the tolerated list |
| `seed` | the admin password is shorter than 8 characters |
| `self_check` | the schema version is not `Migrator::CURRENT`, or any table in `db/schema.json` is missing |

Two decisions worth knowing about:

* **The shipped placeholder secret is never installed.** `config.sample.php` contains
  `change-me-to-32-plus-random-bytes` on purpose. Installing it verbatim would give every buyer the
  same signing key, and a leaderboard token from one site would validate on another.
* **Re-running the installer does not overwrite your settings.** Site settings are seeded with
  `ON CONFLICT(key_name) DO NOTHING`. A setting introduced in a later version is still inserted,
  because it does not exist yet; copy you already edited is left alone.

`php bin/install.php --force` regenerates the secret. Do it after any suspected leak: it invalidates
existing page-tokens, which is the point.

---

## 5. Static export

```bash
php bin/export.php dist --site-name="أركيد نورس"
```

The exporter asks the licence auditor for the catalogue in **export mode** — stricter than serving
mode, because a static bundle leaves your server and you lose the ability to take a game down.

The rule that defines this feature is a negative one:

> **A game the auditor refuses produces no file.** Not a page with a warning, not a page behind a
> flag. A buyer who unzips the bundle cannot ship something the auditor refused, because the thing
> is not there. Every refusal is still listed, with its finding codes, in the manifest.

What lands in `dist/`:

```
dist/
├── index.html                        links only the games that were exported
├── license-manifest.json             every game: verdict, licence type, attribution, refusals
├── assets/license-rules.json         byte-identical copy of the policy the audit ran against
└── game/<slug>/index.html            one page per cleared game, attribution embedded
```

`license-manifest.json` carries two hashes so a static host can re-check itself:

| Key | Meaning |
|---|---|
| `rules_sha256` | sha256 of the decoded policy — proves the content is the audited policy |
| `rules_file_sha256` | sha256 of the bytes in `assets/license-rules.json` — checkable in plain JS |

The exporter refuses to run at all if `db/license_rules.json` is not the policy the audit used, so a
bundle can never ship with rules that differ from the ones that approved it.

An empty catalogue exits `1` and writes no bundle — an accidentally empty publish is a failed
command, not a silent one.

---

## 6. Licence tiers

The tiers below are what we sell. Each one maps onto the same policy file the engine enforces
(`db/license_rules.json`), so the contract and the code cannot disagree:

| | Standard · **$49** | Extended · **$149** | Buyout · **on request** |
|---|---|---|---|
| Sites | 1 | 5 | unlimited |
| Commercial use (ads, paid access) | ✔ | ✔ | ✔ |
| Sublicence to clients | ✘ | ✔ | ✔ |
| Static redistribution of the bundle | ✘ | ✔ | ✔ |
| Source comments + branding intact | required | removable | removable |
| Updates | 6 months | 12 months | 12 months |
| Support | email, 5 business days | email, 2 business days | named contact |

Two clauses that come straight from the engine, not from a lawyer's boilerplate:

* Every install declares `commercial` in `config/config.php`. Work carrying a non-commercial
  licence is refused while that flag is true — the flag is read by the gate, not by a policy page.
* Every game served or exported has a licence row, and every audit writes an append-only ledger
  row (`license_audits`). If a rights holder ever writes to you, that table is your answer, and
  `license-manifest.json` is what you attach.

See `docs/LICENSING.md` for the finding codes and the order they are evaluated in.

---

## 7. Upgrading

`php bin/install.php` is the upgrade path: it applies only the migrations that have not run and
leaves your settings alone. Read `docs/UPGRADING.md` before a major version — migration 4 rebuilds
constraints on SQLite installs and expects a backup first.
