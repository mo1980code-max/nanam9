#!/usr/bin/env python3
"""Generates db/schema.mysql.sql and db/schema.sqlite.sql from db/schema.json.

    python3 tools/gen_schema_sql.py            # write both files
    python3 tools/gen_schema_sql.py --verify   # CI: fail if they are stale

The guarantee this buys: a column cannot exist in one dialect and not the other, because both
files are emitted from one ordered dict — and the script asserts the emitted column order is
identical across dialects. Marketplace arcade scripts ship two hand-written dumps; that is how
buyers end up with "works on MySQL, explodes on SQLite".
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "db" / "schema.json"
OUT = {"mysql": ROOT / "db" / "schema.mysql.sql", "sqlite": ROOT / "db" / "schema.sqlite.sql"}

MYSQL_TYPE = {
    "pk": "INT UNSIGNED NOT NULL AUTO_INCREMENT",
    "int": "INT",
    "bool": "TINYINT(1)",
    "string": "VARCHAR({size})",
    "slug": "VARCHAR(80)",
    "text": "TEXT",
    "longtext": "LONGTEXT",
    "datetime": "DATETIME",
    "date": "DATE",
}
SQLITE_TYPE = {
    "pk": "INTEGER PRIMARY KEY AUTOINCREMENT",
    "int": "INTEGER",
    "bool": "INTEGER",
    "string": "TEXT",
    "slug": "TEXT",
    "text": "TEXT",
    "longtext": "TEXT",
    "datetime": "TEXT",
    "date": "TEXT",
}

# child/junction tables whose FK columns are NOT NULL: the row dies with its parent
CASCADE_TABLES = {"game_tag", "collection_game", "game_licenses", "takedown_notices", "user_badges"}


def q(name: str, dialect: str) -> str:
    return f"`{name}`" if dialect == "mysql" else f'"{name}"'


def default_literal(value) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def render_column(dialect: str, spec: dict) -> str:
    t = spec["type"]
    out = (MYSQL_TYPE if dialect == "mysql" else SQLITE_TYPE)[t]
    out = out.format(size=spec.get("size", 190)) if "{size}" in out else out
    if t == "pk":
        return out
    out += " NULL" if spec.get("null") else " NOT NULL"
    if "default" in spec:
        out += " DEFAULT " + default_literal(spec["default"])
    return out


def on_delete(table: str, spec: dict) -> str:
    if table in CASCADE_TABLES and not spec.get("null"):
        return "CASCADE"
    if spec.get("null"):
        return "SET NULL"
    return "CASCADE"


def index_name(prefix: str, table: str, cols: list) -> str:
    return f"{prefix}_{table}_" + "_".join(cols)


def emit_table(dialect: str, name: str, spec: dict) -> str:
    lines = []
    pk_single = None
    pk_composite = spec.get("pk") if spec.get("pk") and "," in spec["pk"] else None
    if not spec.get("no_id") and spec["columns"].get("id", {}).get("type") == "pk":
        pk_single = "id"

    for cname, cspec in spec["columns"].items():
        line = f"  {q(cname, dialect)} {render_column(dialect, cspec)}"
        if dialect == "sqlite" and cspec.get("fk"):
            tbl, col = cspec["fk"].split(".")
            line += f' REFERENCES {q(tbl, dialect)} ({q(col, dialect)}) ON DELETE {on_delete(name, cspec)}'
        lines.append(line)

    if dialect == "mysql":
        for cname, cspec in spec["columns"].items():
            if cspec.get("fk"):
                tbl, col = cspec["fk"].split(".")
                lines.append(
                    f"  CONSTRAINT {q(index_name('fk', name, [cname]), dialect)} "
                    f"FOREIGN KEY ({q(cname, dialect)}) REFERENCES {q(tbl, dialect)} ({q(col, dialect)}) "
                    f"ON DELETE {on_delete(name, cspec)}"
                )
        if pk_single:
            lines.append(f"  PRIMARY KEY ({q(pk_single, dialect)})")
        if pk_composite:
            cols = ", ".join(q(c, dialect) for c in pk_composite.split(","))
            lines.append(f"  PRIMARY KEY ({cols})")
        for u in spec.get("uniques", []):
            cols = ", ".join(q(c, dialect) for c in u)
            lines.append(f"  UNIQUE KEY {q(index_name('uq', name, u), dialect)} ({cols})")
        for ix in spec.get("indexes", []):
            cols = ", ".join(q(c, dialect) for c in ix)
            lines.append(f"  KEY {q(index_name('idx', name, ix), dialect)} ({cols})")
        if spec.get("fulltext"):
            cols = ", ".join(q(c, dialect) for c in spec["fulltext"])
            lines.append(f"  FULLTEXT KEY {q('ft_' + name, dialect)} ({cols})")

    body = ",\n".join(lines)
    if dialect == "mysql":
        out = (f"CREATE TABLE IF NOT EXISTS {q(name, dialect)} (\n{body}\n) "
               f"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;")
    else:
        out = f"CREATE TABLE IF NOT EXISTS {q(name, dialect)} (\n{body}\n);"
        for u in spec.get("uniques", []):
            cols = ", ".join(q(c, dialect) for c in u)
            out += f"\nCREATE UNIQUE INDEX IF NOT EXISTS {index_name('uq', name, u)} ON {q(name, dialect)} ({cols});"
        for ix in spec.get("indexes", []):
            cols = ", ".join(q(c, dialect) for c in ix)
            out += f"\nCREATE INDEX IF NOT EXISTS {index_name('idx', name, ix)} ON {q(name, dialect)} ({cols});"
    return out


def emit(dialect: str, tables: dict) -> str:
    parts = [
        "-- GENERATED by tools/gen_schema_sql.py from db/schema.json — do not hand-edit.\n"
        f"-- dialect: {dialect}\n",
    ]
    if dialect == "mysql":
        parts.append("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n")
    else:
        parts.append("-- Nawras\\Db\\Connection opens SQLite with PRAGMA foreign_keys = ON.\n")
    for name, spec in tables.items():
        parts.append(emit_table(dialect, name, spec) + "\n")
    if dialect == "mysql":
        parts.append("SET FOREIGN_KEY_CHECKS = 1;\n")
    return "\n".join(parts)


def column_orders(tables: dict) -> list:
    return [list(spec["columns"].keys()) for spec in tables.values()]


def parse_orders(sql_text: str) -> dict:
    """Extracts {table: [columns]} from generated DDL — used to prove the two FILES agree."""
    out: dict = {}
    current = None
    for line in sql_text.splitlines():
        m = re.match(r"CREATE TABLE IF NOT EXISTS `[?]?(\w+)`|CREATE TABLE IF NOT EXISTS \"(\w+)\"", line)
        if m:
            current = m.group(1) or m.group(2)
            out[current] = []
            continue
        if current:
            m = re.match(r"\s+[`\"](\w+)[`\"]\s", line)
            if m and line.lstrip().startswith(("`", '"')):
                out[current].append(m.group(1))
            if line.strip() in (");", ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;"):
                current = None
    return out


def main() -> int:
    if not SCHEMA.is_file():
        print("db/schema.json missing — run tools/bootstrap_schema.py first")
        return 2
    doc = json.loads(SCHEMA.read_text(encoding="utf-8"))
    tables = doc["tables"]

    rendered = {d: emit(d, tables) for d in OUT}
    parsed = {d: parse_orders(rendered[d]) for d in OUT}
    if parsed["mysql"] != parsed["sqlite"]:
        diff = [t for t in set(parsed["mysql"]) | set(parsed["sqlite"])
                if parsed["mysql"].get(t) != parsed["sqlite"].get(t)]
        print(f"✗ column order differs between dialect files: {', '.join(sorted(diff))}")
        return 1

    cols = sum(len(spec["columns"]) for spec in tables.values())
    idx = sum(len(spec.get("indexes", [])) + len(spec.get("uniques", [])) for spec in tables.values())

    if "--verify" in sys.argv:
        stale = []
        for d, path in OUT.items():
            have = path.read_text(encoding="utf-8") if path.is_file() else ""
            if have.strip() != rendered[d].strip():
                stale.append(str(path.relative_to(ROOT)))
        if stale:
            print(f"✗ generated SQL is stale: {', '.join(stale)}")
            print("  fix: python3 tools/gen_schema_sql.py")
            return 1
        print(f"✓ both dialects current · {len(tables)} tables · {cols} columns · {idx} indexes/uniques")
        return 0

    for d, path in OUT.items():
        path.write_text(rendered[d], encoding="utf-8")
    print(f"✓ wrote schema.mysql.sql + schema.sqlite.sql · {len(tables)} tables · "
          f"{cols} columns · {idx} indexes/uniques · identical column order")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
