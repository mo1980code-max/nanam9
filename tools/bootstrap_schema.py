#!/usr/bin/env python3
"""Writes db/schema.json — the single source of truth for both SQL dialects.

Why a generator instead of two .sql files: every marketplace script I am competing with
ships a MySQL dump and an optional SQLite one, and they drift within two releases. Here a
column can only exist if it is in this file, and tools/gen_schema_sql.py refuses to emit
unless both dialects agree on the *order* of every column.

Run:  python3 tools/bootstrap_schema.py
"""
from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "db" / "schema.json"

C = lambda **kw: kw  # noqa: E731 - readability for the table below


def tables() -> "OrderedDict[str, dict]":
    T: "OrderedDict[str, dict]" = OrderedDict()

    T["settings"] = {
        "columns": {
            "key_name": C(type="slug"),
            "value_type": C(type="string", size=16, default="string"),
            "value_text": C(type="text", null=True),
            "updated_at": C(type="datetime"),
        },
        "pk": "key_name",
        "no_id": True,
        "note": "key/value site settings so the admin can change copy without a deploy",
    }
    T["users"] = {
        "columns": {
            "id": C(type="pk"),
            "username": C(type="slug"),
            "email": C(type="string", size=190, null=True),
            "password_hash": C(type="string", size=255),
            "display_name": C(type="string", size=64, null=True),
            "role": C(type="string", size=16, default="admin"),
            "locale": C(type="string", size=5, default="ar"),
            "xp": C(type="int", default=0),
            "disabled_at": C(type="datetime", null=True),
            "created_at": C(type="datetime"),
            "updated_at": C(type="datetime", null=True),
        },
        "uniques": [["username"], ["email"]],
    }
    T["sessions"] = {
        "columns": {
            "id": C(type="pk"),
            "user_id": C(type="int", null=True, fk="users.id"),
            "token_hash": C(type="string", size=64),
            "ip": C(type="string", size=45, null=True),
            "data_json": C(type="longtext", null=True),
            "last_seen_at": C(type="datetime"),
            "expires_at": C(type="datetime"),
        },
        "uniques": [["token_hash"]],
        "indexes": [["expires_at"]],
        "note": "admin sessions are ours, not PHP's, so a shared host cannot leak them via /tmp",
    }
    T["categories"] = {
        "columns": {
            "id": C(type="pk"),
            "slug": C(type="slug"),
            "name_ar": C(type="string", size=96),
            "name_en": C(type="string", size=96),
            "color": C(type="string", size=16, default="#7c5cff"),
            "parent_id": C(type="int", null=True, fk="categories.id"),
            "position": C(type="int", default=0),
            "created_at": C(type="datetime"),
        },
        "uniques": [["slug"]],
        "indexes": [["position"], ["parent_id"]],
    }
    T["games"] = {
        "columns": {
            "id": C(type="pk"),
            "slug": C(type="slug"),
            "slug_ar": C(type="string", size=80, null=True),
            "title_ar": C(type="string", size=120),
            "title_en": C(type="string", size=120),
            "desc_ar": C(type="text", null=True),
            "desc_en": C(type="text", null=True),
            "howto_ar": C(type="text", null=True),
            "howto_en": C(type="text", null=True),
            "category_id": C(type="int", null=True, fk="categories.id"),
            "kind": C(type="string", size=12, default="feed"),
            "provider": C(type="string", size=32, default="own"),
            "external_id": C(type="string", size=64, null=True),
            "embed_url": C(type="string", size=255, default=""),
            "local_path": C(type="string", size=190, default=""),
            "runtime_module": C(type="string", size=64, default=""),
            "poster_path": C(type="string", size=190, default=""),
            "aspect": C(type="string", size=8, default="16/9"),
            "devices": C(type="string", size=48, default="desktop,mobile,tablet"),
            "controls": C(type="string", size=48, default="pointer"),
            "players": C(type="string", size=12, default="solo"),
            "age_rating": C(type="string", size=12, default="all"),
            "kid_friendly": C(type="bool", default=1),
            "featured": C(type="bool", default=0),
            "status": C(type="string", size=16, default="draft"),
            "plays_count": C(type="int", default=0),
            "plays_7d": C(type="int", default=0),
            "likes_count": C(type="int", default=0),
            "rating_sum": C(type="int", default=0),
            "rating_count": C(type="int", default=0),
            "published_at": C(type="datetime", null=True),
            "created_at": C(type="datetime"),
            "updated_at": C(type="datetime"),
        },
        "uniques": [["slug"], ["provider", "external_id"]],
        "indexes": [["status"], ["category_id"], ["featured", "plays_count"], ["kind"], ["plays_7d"]],
        "fulltext": ["title_ar", "title_en", "desc_ar", "desc_en"],
        "note": "provider+external_id is the idempotency key every feed sync relies on. "
                "external_id is NULLABLE on purpose: own/uploaded rows have no external id, and a "
                "unique index never collides on NULL. A NOT NULL DEFAULT '' here would allow "
                "exactly ONE own game per install (bug caught by tools/prove_runtime.py proof C)",
    }
    T["game_licenses"] = {
        "columns": {
            "id": C(type="pk"),
            "game_id": C(type="int", fk="games.id"),
            "provider": C(type="string", size=32, default="own"),
            "external_id": C(type="string", size=64, null=True),
            "license_type": C(type="string", size=16),
            "license_ref": C(type="string", size=48),
            "upstream_repo": C(type="string", size=190, default=""),
            "commit_sha": C(type="string", size=40, default=""),
            "license_path": C(type="string", size=190, default=""),
            "license_file": C(type="string", size=190, default=""),
            "license_sha256": C(type="string", size=64, default=""),
            "proof_url": C(type="string", size=255, default=""),
            "invoice_ref": C(type="string", size=64, default=""),
            "allow_origins": C(type="string", size=255, default=""),
            "attribution_required": C(type="bool", default=0),
            "attribution_html": C(type="text", null=True),
            "captured_at": C(type="date", null=True),
            "expires_at": C(type="date", null=True),
            "status": C(type="string", size=16, default="active"),
            "notes": C(type="text", null=True),
            "created_at": C(type="datetime"),
            "updated_at": C(type="datetime"),
        },
        "uniques": [["game_id", "provider", "external_id"]],
        "indexes": [["status"], ["license_type"], ["expires_at"]],
        "note": "the product's core table: no game is visible unless a row here says why",
    }
    T["takedowns"] = {
        "columns": {
            "id": C(type="pk"),
            "game_id": C(type="int", null=True, fk="games.id"),
            "slug_claim": C(type="string", size=80, default=""),
            "reporter_name": C(type="string", size=120),
            "reporter_email": C(type="string", size=190),
            "reporter_org": C(type="string", size=120, null=True),
            "work_title": C(type="string", size=190),
            "work_url": C(type="string", size=255, null=True),
            "our_url": C(type="string", size=255),
            "basis": C(type="string", size=16, default="copyright"),
            "statement_good_faith": C(type="bool", default=0),
            "statement_under_penalty": C(type="bool", default=0),
            "signature": C(type="string", size=190, null=True),
            "status": C(type="string", size=16, default="open"),
            "counter_notice": C(type="text", null=True),
            "action_taken": C(type="string", size=190, null=True),
            "received_at": C(type="datetime"),
            "resolved_at": C(type="datetime", null=True),
            "handled_by": C(type="int", null=True, fk="users.id"),
        },
        "indexes": [["status", "received_at"], ["game_id"]],
    }
    T["takedown_notices"] = {
        "columns": {
            "id": C(type="pk"),
            "takedown_id": C(type="int", fk="takedowns.id"),
            "channel": C(type="string", size=16, default="email"),
            "recipient": C(type="string", size=190),
            "subject": C(type="string", size=190),
            "body": C(type="text"),
            "sent_at": C(type="datetime", null=True),
            "created_at": C(type="datetime"),
        },
        "indexes": [["takedown_id"]],
    }
    T["audit_log"] = {
        "columns": {
            "id": C(type="pk"),
            "actor_label": C(type="string", size=64, default="system"),
            "action": C(type="string", size=48),
            "entity": C(type="string", size=32),
            "entity_id": C(type="int", null=True),
            "payload": C(type="longtext", null=True),
            "ip": C(type="string", size=45, null=True),
            "created_at": C(type="datetime"),
        },
        "indexes": [["entity", "entity_id"], ["action"], ["created_at"]],
    }
    T["tags"] = {
        "columns": {
            "id": C(type="pk"),
            "slug": C(type="slug"),
            "name_ar": C(type="string", size=64),
            "name_en": C(type="string", size=64),
        },
        "uniques": [["slug"]],
    }
    T["game_tag"] = {
        "columns": {"game_id": C(type="int", fk="games.id"), "tag_id": C(type="int", fk="tags.id")},
        "pk": "game_id,tag_id",
        "no_id": True,
        "indexes": [["tag_id"]],
    }
    T["collections"] = {
        "columns": {
            "id": C(type="pk"),
            "slug": C(type="slug"),
            "title_ar": C(type="string", size=120),
            "title_en": C(type="string", size=120),
            "blurb_ar": C(type="text", null=True),
            "blurb_en": C(type="text", null=True),
            "auto_rule": C(type="string", size=190, null=True),
            "is_auto": C(type="bool", default=0),
            "position": C(type="int", default=0),
        },
        "uniques": [["slug"]],
    }
    T["collection_game"] = {
        "columns": {
            "collection_id": C(type="int", fk="collections.id"),
            "game_id": C(type="int", fk="games.id"),
            "position": C(type="int", default=0),
        },
        "pk": "collection_id,game_id",
        "no_id": True,
        "indexes": [["game_id"]],
    }
    T["favorites"] = {
        "columns": {
            "id": C(type="pk"),
            "user_id": C(type="int", null=True, fk="users.id"),
            "device_key": C(type="string", size=64, null=True),
            "game_id": C(type="int", fk="games.id"),
            "created_at": C(type="datetime"),
        },
        "uniques": [["user_id", "game_id"], ["device_key", "game_id"]],
    }
    T["play_events"] = {
        "columns": {
            "id": C(type="pk"),
            "game_id": C(type="int", fk="games.id"),
            "device_key": C(type="string", size=64, null=True),
            "source": C(type="string", size=16, default="site"),
            "seconds": C(type="int", default=0),
            "completed": C(type="bool", default=0),
            "played_at": C(type="datetime"),
        },
        "indexes": [["game_id", "played_at"], ["played_at"]],
    }
    T["leaderboard"] = {
        "columns": {
            "id": C(type="pk"),
            "game_id": C(type="int", fk="games.id"),
            "user_id": C(type="int", null=True, fk="users.id"),
            "alias": C(type="string", size=48, null=True),
            "score": C(type="int"),
            "period": C(type="string", size=8, default="all"),
            "period_key": C(type="string", size=12, default="all"),
            "week_key": C(type="string", size=12, default=""),
            "signature": C(type="string", size=64, null=True),
            "submitted_at": C(type="datetime"),
        },
        "uniques": [["game_id", "user_id", "period", "period_key"],
                    ["game_id", "alias", "period", "period_key"]],
        "indexes": [["game_id", "period", "period_key", "score"], ["period", "period_key", "score"]],
        "note": "one row per (game, player, time bucket). week_key stays for compatibility with "
                "installs predating buckets and mirrors period_key when period='week'",
    }
    T["provider_games"] = {
        "columns": {
            "id": C(type="pk"),
            "provider": C(type="string", size=32),
            "external_id": C(type="string", size=64),
            "payload": C(type="longtext"),
            "fetched_at": C(type="datetime"),
        },
        "uniques": [["provider", "external_id"]],
        "indexes": [["fetched_at"]],
    }
    T["provider_runs"] = {
        "columns": {
            "id": C(type="pk"),
            "provider": C(type="string", size=32),
            "status": C(type="string", size=16, default="ok"),
            "rows_seen": C(type="int", default=0),
            "rows_new": C(type="int", default=0),
            "rows_rejected": C(type="int", default=0),
            "detail": C(type="text", null=True),
            "started_at": C(type="datetime"),
            "finished_at": C(type="datetime", null=True),
        },
        "indexes": [["provider", "started_at"]],
    }
    T["ads_slots"] = {
        "columns": {
            "id": C(type="pk"),
            "slot_key": C(type="string", size=32),
            "client": C(type="string", size=32),
            "slot_id": C(type="string", size=32),
            "format": C(type="string", size=16, default="responsive"),
            "enabled": C(type="bool", default=1),
        },
        "uniques": [["slot_key"]],
    }
    T["ad_impressions"] = {
        "columns": {
            "id": C(type="pk"),
            "slot_key": C(type="string", size=32),
            "game_id": C(type="int", null=True, fk="games.id"),
            "day": C(type="date"),
            "views": C(type="int", default=0),
            "clicks": C(type="int", default=0),
        },
        "uniques": [["slot_key", "game_id", "day"]],
        "indexes": [["day"]],
    }
    T["xp_events"] = {
        "columns": {
            "id": C(type="pk"),
            "device_key": C(type="string", size=64),
            "game_id": C(type="int", null=True, fk="games.id"),
            "amount": C(type="int"),
            "reason": C(type="string", size=24),
            "created_at": C(type="datetime"),
        },
        "indexes": [["device_key", "created_at"]],
    }
    T["badges"] = {
        "columns": {
            "id": C(type="pk"),
            "slug": C(type="slug"),
            "name_ar": C(type="string", size=64),
            "name_en": C(type="string", size=64),
            "rule_json": C(type="text", null=True),
        },
        "uniques": [["slug"]],
    }
    T["user_badges"] = {
        "columns": {
            "id": C(type="pk"),
            "device_key": C(type="string", size=64),
            "badge_id": C(type="int", fk="badges.id"),
            "awarded_at": C(type="datetime"),
        },
        "uniques": [["device_key", "badge_id"]],
    }
    T["i18n_overrides"] = {
        "columns": {
            "id": C(type="pk"),
            "locale": C(type="string", size=5),
            "string_key": C(type="string", size=96),
            "value": C(type="text"),
            "updated_at": C(type="datetime"),
        },
        "uniques": [["locale", "string_key"]],
    }
    T["schema_version"] = {
        "columns": {
            "id": C(type="pk"),
            "version": C(type="int"),
            "note": C(type="string", size=190, default=""),
            "applied_at": C(type="datetime"),
        },
        "uniques": [["version"]],
        "note": "the table that makes an installed copy upgradable instead of reinstallable",
    }
    return T


def main() -> int:
    T = tables()
    doc = OrderedDict(
        _note="Canonical schema. db/schema.{mysql,sqlite}.sql are GENERATED from this file by "
              "tools/gen_schema_sql.py and must never be hand-edited. Upgrades for existing installs "
              "live in db/migrations.json and are applied by Nawras\\Db\\Migrator through schema_version.",
        dialects=OrderedDict(
            mysql="InnoDB + utf8mb4_unicode_ci; FULLTEXT on games search columns; "
                  "upserts use ON DUPLICATE KEY UPDATE",
            sqlite="single file at var/arcade.sqlite; LIKE search; upserts use ON CONFLICT DO UPDATE",
        ),
        tables=T,
    )
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    cols = sum(len(t["columns"]) for t in T.values())
    idx = sum(len(t.get("indexes", [])) + len(t.get("uniques", [])) for t in T.values())
    print(f"✓ db/schema.json written · {len(T)} tables · {cols} columns · {idx} indexes/uniques")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
