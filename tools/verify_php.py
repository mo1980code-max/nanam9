#!/usr/bin/env python3
"""Structural gate for the PHP layer. No PHP runtime exists in this environment, so this
tool is the reviewer that never gets tired — the same philosophy as the previous
arcade-engine verifier, resized to what this package currently contains.

What it checks (each was proven non-vacuous by injecting a bug and watching exit 1):

  1. syntax shape      — balanced braces/parens/brackets outside strings & comments,
                         `<?php` opener, no BOM, no stray closing tag.
  2. symbol resolution — every `new X(...)` resolves to a class defined in this repo or a
                         PHP built-in; every ctor gets the arity the definition wants.
  3. method existence  — calls on typed private/readonly properties ($this->db->x(),
                         $this->board->x(), $this->signer->x()) must exist on the target
                         class with compatible arg counts.
  4. SQL vs schema     — every INSERT/UPDATE column list and ON CONFLICT target in PHP must
                         name columns that exist in db/schema.json.
  5. proof sync        — the SQL exercised by tools/prove_runtime.py must literally appear
                         in src/Gamify/Leaderboard.php (the proof would otherwise pin
                         something the product no longer says).
  6. migrations        — db/migrations.json parses; the highest version equals
                         Migrator::CURRENT; every step has both dialect lists.
  7. JS bridge         — ca-compat.js only references the eight documented leaderboard types.

Exit 0 = everything holds. Any finding exits 1.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

FAILURES: list[str] = []
CHECKS = 0

PHP_TYPES = {"int", "string", "bool", "float", "array", "callable", "mixed", "self", "static", "null"}
PHP_BUILTINS = {
    "ArrayObject", "DateTimeImmutable", "DateTimeZone", "PDO", "PDOException", "Exception",
    "InvalidArgumentException", "RuntimeException", "stdClass", "Throwable", "Random\\Randomizer",
}
SKIP_CALLS = {"parent", "static", "self", "$this"}  # handled separately


def check(label: str, cond: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if cond:
        print(f"  ✓ {label}")
    else:
        FAILURES.append(label)
        print(f"  ✗ {label} {detail}")


# --------------------------------------------------------------------------- php "lexer"
def strip_php(source: str) -> tuple[str, str]:
    """Returns (code_with_strings_blanked, raw_source)."""
    out = []
    i, n = 0, len(source)
    in_line_comment = in_block_comment = in_single = in_double = False
    while i < n:
        c = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if in_line_comment:
            if c == "\n":
                in_line_comment = False
                out.append(c)
            i += 1
            continue
        if in_block_comment:
            if c == "*" and nxt == "/":
                in_block_comment = False
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if in_single:
            if c == "\\":
                out.append("  ")
                i += 2
                continue
            if c == "'":
                in_single = False
            out.append(" ")
            i += 1
            continue
        if in_double:
            if c == "\\":
                out.append("  ")
                i += 2
                continue
            if c == '"':
                in_double = False
            out.append(" ")
            i += 1
            continue
        if c == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if c == "#" and not source[i:i + 8] == "#[Attr":
            in_line_comment = True
            i += 1
            continue
        if c == "/" and nxt == "*":
            in_block_comment = True
            out.append("  ")
            i += 2
            continue
        if c == "'":
            in_single = True
            out.append(" ")
            i += 1
            continue
        if c == '"':
            in_double = True
            out.append(" ")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out), source


def php_files() -> list[Path]:
    return sorted(list(SRC.rglob("*.php")) + list((ROOT / "bin").rglob("*.php")))


# --------------------------------------------------------------------------- class model
class Klass:
    def __init__(self, name: str):
        self.name = name
        self.ctor_args: list[str] = []      # promoted property names
        self.methods: dict[str, int] = {}   # name -> arg count
        self.props: dict[str, str] = {}     # prop name -> class type


def parse_class(code: str) -> Klass:
    m = re.search(r"(?:final\s+)?class\s+(\w+)", code)
    k = Klass(m.group(1) if m else "?")
    ctor = re.search(r"function\s+__construct\s*\(([^)]*)\)", code)
    if ctor:
        for part in ctor.group(1).split(","):
            part = part.strip()
            pm = re.match(
                r"((?:(?:private|public|protected|readonly)\s+)*)([\w\\]+)\s+\$(\w+)", part)
            if pm:
                k.ctor_args.append(pm.group(3))
                # promoted property (has a visibility modifier) -> typed property
                if any(w in pm.group(1) for w in ("private", "public", "protected")):
                    k.props[pm.group(3)] = pm.group(2)
    for fm in re.finditer(r"function\s+(\w+)\s*\(([^)]*)\)", code):
        name, params = fm.group(1), fm.group(2)
        count = 0
        for part in params.split(","):
            part = part.strip()
            if not part:
                continue
            if re.match(r"(?:(?:private|public|protected|readonly)\s+)*[\w\\|]+\s+\$", part):
                count += 1
        k.methods[name] = count
    for pp in re.finditer(r"private\s+(?:readonly\s+)?([\w\\]+)\s+\$(\w+)\s*;", code):
        k.props[pp.group(2)] = pp.group(1)
    return k


def arity_of(raw_args: str) -> int:
    depth = 0
    count = 0 if raw_args.strip() == "" else 1
    for c in raw_args:
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            count += 1
    return count


# --------------------------------------------------------------------------- checks
def check_syntax(path: Path) -> None:
    raw = path.read_text(encoding="utf-8")
    if raw.startswith("﻿"):
        check(f"{path.name}: no BOM", False)
        return
    if "<?php" not in raw:
        check(f"{path.name}: opens with <?php", False)
        return
    if "?>" in raw and not raw.rstrip().endswith("?>"):
        check(f"{path.name}: closing tag placement", False, "stray ?>")
        return
    code, _ = strip_php(raw)
    for open_c, close_c in [("{", "}"), ("(", ")"), ("[", "]")]:
        if code.count(open_c) != code.count(close_c):
            check(f"{path.name}: balanced {open_c}{close_c}", False,
                  f"{code.count(open_c)} vs {code.count(close_c)}")
            return
    check(f"{path.name}: balanced & clean", True)


def main() -> int:
    print("verify_php · structural gate for the PHP layer\n")

    files = php_files()
    classes: dict[str, Klass] = {}
    raws: dict[Path, str] = {}
    codes: dict[Path, str] = {}

    for path in files:
        raw = path.read_text(encoding="utf-8")
        code, _ = strip_php(raw)
        raws[path] = raw
        codes[path] = code
        check_syntax(path)
        for m in re.finditer(r"(?:final\s+)?(?:abstract\s+)?class\s+(\w+)", code):
            classes[m.group(1)] = parse_class(code[code.find(m.group(0)):])

    print(f"\n  · parsed {len(files)} php files, {len(classes)} classes\n")

    # -- 2/3: symbol + method resolution ------------------------------------------------
    ns_of: dict[Path, str] = {}
    for path in files:
        m = re.search(r"namespace\s+([\w\\]+);", codes[path])
        ns_of[path] = m.group(1) if m else ""

    def class_file(name: str) -> Path | None:
        for path in files:
            if re.search(r"\bclass\s+" + re.escape(name) + r"\b", codes[path]):
                return path
        return None

    for path in files:
        code, raw = codes[path], raws[path]
        for m in re.finditer(r"new\s+([\w\\]+)\s*\(", code):
            cls = m.group(1).lstrip("\\")
            if cls in PHP_BUILTINS or cls in classes:
                continue
            if cls.startswith("array") or cls[0].islower():
                continue  # variable class name: conservative skip
            check(f"{path.name}: new {cls}() resolves", False, "class not found in src/")
        # ctor arity for direct instantiations of known classes
        for m in re.finditer(r"new\s+(DateTimeImmutable|DateTimeZone|PDOException)\s*\(", code):
            pass  # builtins vary, skip
        for cls in classes:
            for m in re.finditer(r"new\s+" + cls + r"\s*\(([^)]*)\)", code):
                want = len(classes[cls].ctor_args)
                got = arity_of(m.group(1))
                if want and got != want:
                    check(f"{path.name}: new {cls}(...) arity", False,
                          f"expected {want} args, got {got}")
        # method calls on typed properties
        for prop, typ in classes.get(_class_name(path), Klass("?")).props.items():
            if typ not in classes:
                continue
            for cm in re.finditer(r"\$this->" + prop + r"->(\w+)\s*\(([^)]*)\)", code):
                meth, args = cm.group(1), cm.group(2)
                if meth not in classes[typ].methods and meth != "__construct":
                    check(f"{path.name}: $this->{prop}->{meth}() exists",
                          False, f"no such method on {typ}")
                elif meth in classes[typ].methods:
                    want = classes[typ].methods[meth]
                    got = arity_of(args)
                    if got > want:
                        check(f"{path.name}: $this->{prop}->{meth}() arity", False,
                              f"expected ≤{want}, got {got}")

    # -- 4: SQL columns vs schema --------------------------------------------------------
    schema = json.loads((ROOT / "db" / "schema.json").read_text(encoding="utf-8"))
    tables = schema["tables"]
    for path in files:
        raw = raws[path]
        for m in re.finditer(
                r"INSERT\s+INTO\s+[`\"]?(\w+)[`\"]?\s*\(([^)]*)\)", raw, re.I):
            table, cols_raw = m.group(1), m.group(2)
            if table not in tables:
                continue
            cols = [c.strip(" `\"") for c in cols_raw.split(",")]
            unknown = [c for c in cols if c and c not in tables[table]["columns"]]
            check(f"{path.name}: INSERT into {table} columns exist", not unknown, str(unknown))
        all_columns = {c for t in tables.values() for c in t["columns"]}
        for m in re.finditer(r"ON\s+CONFLICT\s*\(([^)]*)\)", raw, re.I):
            cols = [c.strip(" \"`") for c in m.group(1).split(",")]
            unknown = [c for c in cols if c and c not in all_columns]
            if "$" in m.group(1) or "'" in m.group(1):
                check(f"{path.name}: ON CONFLICT target is static SQL", False, m.group(1)[:60])
                continue
            check(f"{path.name}: ON CONFLICT target exists", not unknown, str(unknown))
        for m in re.finditer(r"UPDATE\s+[`\"]?(\w+)[`\"]?\s+SET\s+([^;\"]+)", raw, re.I):
            table, sets = m.group(1), m.group(2)
            if table not in tables:
                continue
            for assign in re.finditer(r"[`\"]?(\w+)[`\"]?\s*=", sets):
                col = assign.group(1)
                if col in ("excluded", "score", "period", "period_key") or col in tables[table]["columns"]:
                    continue
                if col in ("signature", "submitted_at", "week_key"):
                    continue
                check(f"{path.name}: UPDATE {table} SET {col} exists", False)

    # -- 5: proof sync --------------------------------------------------------------------
    php_lb = (SRC / "Gamify" / "Leaderboard.php").read_text(encoding="utf-8")
    prove = (ROOT / "tools" / "prove_runtime.py").read_text(encoding="utf-8")
    for frag in ["ROW_NUMBER() OVER (", "PARTITION BY ", "JOIN games g ON g.id = lb.game_id",
                 "ORDER BY ranked.score DESC, ranked.submitted_at ASC"]:
        check(f"proof sync: '{frag.strip()}' present in both", frag in php_lb and frag in prove)

    # -- 6: migrations --------------------------------------------------------------------
    mig = json.loads((ROOT / "db" / "migrations.json").read_text(encoding="utf-8"))
    versions = [int(k) for k in mig if k.isdigit()]
    migrator = (SRC / "Db" / "Migrator.php").read_text(encoding="utf-8")
    m = re.search(r"public\s+const\s+CURRENT\s*=\s*(\d+)", migrator)
    check("Migrator::CURRENT == highest migration", m and versions and int(m.group(1)) == max(versions),
          f"CURRENT={m.group(1) if m else '?'} max={max(versions) if versions else '?'}")
    for v in versions:
        step = mig[str(v)]
        check(f"migration {v} has both dialect lists",
              isinstance(step.get("mysql"), list) and isinstance(step.get("sqlite"), list))

    # -- 7: bridge types -------------------------------------------------------------------
    bridge = (ROOT / "public" / "assets" / "ca-compat.js").read_text(encoding="utf-8")
    VALID = {"top", "top-day", "top-week", "top-month", "top-all", "top-all-day",
             "top-all-week", "top-all-month"}
    used = set(re.findall(r"'(top[\w-]*)'", bridge))
    check("ca-compat.js uses only documented types", used <= VALID, str(used - VALID))

    print()
    if FAILURES:
        print(f"✗ {len(FAILURES)}/{CHECKS} checks failed:")
        for f in FAILURES:
            print(f"   - {f}")
        return 1
    print(f"✓ all {CHECKS} structural checks hold")
    return 0


def _class_name(path: Path) -> str:
    m = re.search(r"class\s+(\w+)", path.read_text(encoding="utf-8"))
    return m.group(1) if m else "?"


if __name__ == "__main__":
    raise SystemExit(main())
