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
  9. providers         — the reserved-range lists, the required-field lists and the feed SQL in
                         src/Providers/ are byte-identical to what tools/prove_runtime.py attacks,
                         the cloud-metadata and loopback ranges are present, and no feed can reach
                         the network or the catalogue past UrlGuard + LicensePolicy.
  8. licensing         — db/license_rules.json is the ONLY place a licence type is named (no type
                         string in src/Licensing/ code), LicensePolicy::CODES and the policy's
                         finding_labels are the same set in both directions, the auditor's SQL is
                         literally the SQL tools/prove_runtime.py proves, migration CREATE TABLE
                         blocks match the generated schema column-for-column, and both write
                         endpoints really do pass the licence gate.

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
def strip_php(source: str, keep_strings: bool = False) -> tuple[str, str]:
    """Returns (code_with_strings_blanked, raw_source).

    keep_strings=True still removes comments but preserves string contents — used by the licence
    purity gate, which must see a hardcoded 'type' literal in code while ignoring docblock prose.
    """
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
        # String CONTENT becomes "x", not spaces: blanking it to whitespace made a call whose only
        # argument is a string literal look like a ZERO-argument call, so every arity check on
        # $db->one('SELECT ...') compared 0 against the declared minimum. "x" keeps the length and
        # keeps parentheses inside strings from leaking into the balanced-argument scan.
        if in_single:
            if c == "\\":
                out.append((c + (source[i + 1] if i + 1 < n else " ")) if keep_strings else "xx")
                i += 2
                continue
            closing = c == "'"
            if closing:
                in_single = False
            out.append(c if keep_strings else (" " if closing else "x"))
            i += 1
            continue
        if in_double:
            if c == "\\":
                out.append((c + (source[i + 1] if i + 1 < n else " ")) if keep_strings else "xx")
                i += 2
                continue
            closing = c == '"'
            if closing:
                in_double = False
            out.append(c if keep_strings else (" " if closing else "x"))
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
            out.append(c if keep_strings else " ")
            i += 1
            continue
        if c == '"':
            in_double = True
            out.append(c if keep_strings else " ")
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
        self.ctor_required: int = 0         # ctor params without a default
        self.methods: dict[str, int] = {}   # name -> arg count
        self.min_args: dict[str, int] = {}  # name -> params without a default
        self.props: dict[str, str] = {}     # prop name -> class type


def parse_class(code: str) -> Klass:
    m = re.search(r"(?:final\s+)?class\s+(\w+)", code)
    k = Klass(m.group(1) if m else "?")
    ctor = re.search(r"function\s+__construct\s*\(([^)]*)\)", code)
    if ctor:
        for part in ctor.group(1).split(","):
            part = part.strip()
            pm = re.match(
                r"((?:(?:private|public|protected|readonly)\s+)*)(\??[\w\\|]+)\s+\$(\w+)", part)
            if pm:
                k.ctor_args.append(pm.group(3))
                if "=" not in part:
                    k.ctor_required += 1
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
            # \?? matters: without it every nullable parameter (?int $userId) was invisible, so a
            # method declared with 6 parameters looked like a 2-parameter one and arity checks were
            # comparing against the wrong number.
            if re.match(r"(?:(?:private|public|protected|readonly)\s+)*\??[\w\\|]+\s+\$", part):
                count += 1
        k.methods[name] = count
        k.min_args[name] = sum(1 for part in params.split(",")
                               if part.strip() and "=" not in part
                               and re.match(r"(?:(?:private|public|protected|readonly)\s+)*\??[\w\\|]+\s+\$", part.strip()))
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


def balanced_args(code: str, open_index: int) -> str:
    """Argument list of the call whose "(" sits at open_index, honouring nested parentheses.

    The naive `\(([^)]*)\)` this replaces stopped at the first ")", so `new C($a, $b->f())`
    was read as a 2-argument call — arity checks passed by luck, not by agreement.
    """
    depth = 0
    for i in range(open_index, len(code)):
        if code[i] in "([{":
            depth += 1
        elif code[i] in ")]}":
            depth -= 1
            if depth == 0:
                return code[open_index + 1:i]
    return code[open_index + 1:]


def php_method(src: str, name: str) -> str:
    """Body of one PHP method, brace-matched. Empty string when the method does not exist."""
    m = re.search(r"function\s+" + re.escape(name) + r"\s*\([^)]*\)[^{]*\{", src)
    if not m:
        return ""
    depth, i = 0, m.end() - 1
    while i < len(src):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[m.end():i]
        i += 1
    return ""


def ddl_columns(statement: str) -> list:
    """Column names of a CREATE TABLE statement, in declaration order."""
    cols = []
    for line in statement.splitlines()[1:]:
        m = re.match(r'^\s*[`"](\w+)[`"]\s', line)
        if m:
            cols.append(m.group(1))
    return cols


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text)


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
            for m in re.finditer(r"new\s+" + cls + r"\s*\(", code):
                want, need = len(classes[cls].ctor_args), classes[cls].ctor_required
                got = arity_of(balanced_args(code, m.end() - 1))
                if want and not need <= got <= want:
                    check(f"{path.name}: new {cls}(...) arity", False,
                          f"expected {need}..{want} args, got {got}")
        # method calls on typed properties
        for prop, typ in classes.get(_class_name(path), Klass("?")).props.items():
            if typ not in classes:
                continue
            for cm in re.finditer(r"\$this->" + prop + r"->(\w+)\s*\(", code):
                meth = cm.group(1)
                args = balanced_args(code, cm.end() - 1)
                if meth not in classes[typ].methods and meth != "__construct":
                    check(f"{path.name}: $this->{prop}->{meth}() exists",
                          False, f"no such method on {typ}")
                elif meth in classes[typ].methods:
                    want = classes[typ].methods[meth]
                    need = classes[typ].min_args.get(meth, want)
                    got = arity_of(args)
                    if not need <= got <= want:
                        check(f"{path.name}: $this->{prop}->{meth}() arity", False,
                              f"expected {need}..{want}, got {got}")

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


    # -- 8: licensing --------------------------------------------------------------------
    licensing = sorted((SRC / "Licensing").glob("*.php"))
    policy_path = ROOT / "db" / "license_rules.json"
    if not licensing or not policy_path.is_file():
        check("licensing layer present", False, "db/license_rules.json / src/Licensing/ missing")
    else:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        sources = {f: f.read_text(encoding="utf-8") for f in licensing}
        code_only = {f: strip_php(raw, keep_strings=True)[0] for f, raw in sources.items()}
        all_src = "\n".join(sources.values())

        # 8a · the policy file is the only place a licence type is named
        for name in policy["types"]:
            hits = [f.name for f in licensing
                    if f"'{name}'" in code_only[f] or f'"{name}"' in code_only[f]]
            check(f"licence type '{name}' is not hardcoded in src/Licensing/", hits == [], str(hits))

        # 8b · one finding vocabulary on both sides
        php_policy = (SRC / "Licensing" / "LicensePolicy.php").read_text(encoding="utf-8")
        block = re.search(r"const\s+CODES\s*=\s*\[(.*?)\];", php_policy, re.S)
        codes = re.findall(r"'([a-z0-9_]+)'", block.group(1)) if block else []
        labels = set(policy.get("finding_labels", {}))
        check("LicensePolicy::CODES parsed", bool(codes), "const CODES not found")
        check("every CODES entry is labelled in the policy", set(codes) <= labels,
              str(sorted(set(codes) - labels)))
        check("every policy label is used by LicensePolicy", labels <= set(codes),
              str(sorted(labels - set(codes))))
        unreachable = [c for c in codes
                       if f"'{c}'" not in all_src
                       and not (c.startswith(("missing_", "bad_"))
                                and "'" + c.split("_")[0] + "_' ." in all_src)]
        check("every finding code is actually emitted", unreachable == [], str(unreachable))

        # 8c · the SQL the auditor runs is the SQL the runtime proof exercises
        auditor = (SRC / "Licensing" / "LicenseAuditor.php").read_text(encoding="utf-8")
        for frag in ["FROM game_licenses WHERE game_id = ? ORDER BY id ASC",
                     "LEFT JOIN game_licenses gl ON gl.game_id = g.id",
                     "AND NOT EXISTS (SELECT 1 FROM game_licenses gl WHERE gl.game_id = g.id"
                     " AND gl.status = ?)",
                     "INSERT INTO license_audits (game_id, license_id, verdict, mode, rules_version,"
                     " reasons, details, audited_at)"]:
            check(f"licence proof sync: '{frag.strip()[:52]}...' in both",
                  squash(frag) in squash(auditor) and squash(frag) in squash(prove))

        # 8d · a migration that creates a table must create it exactly as the baseline does
        for v in versions:
            for dialect in ("mysql", "sqlite"):
                for stmt in mig[str(v)][dialect]:
                    m = re.search(r"CREATE TABLE IF NOT EXISTS [`\"](\w+)[`\"]", stmt)
                    if not m:
                        continue
                    table = m.group(1)
                    want = list(tables[table]["columns"]) if table in tables else []
                    got = ddl_columns(stmt)
                    check(f"migration {v} ({dialect}) {table} columns match the baseline",
                          got == want, f"got {got}")

        # 8e · the rules version stamped by the newest migration is the version the policy declares
        newest = mig.get(str(max(versions)), {}) if versions else {}
        stamped = re.findall(r"""license\.rules_version['`"]?,\s*'int',\s*'(\d+)'""",
                             "\n".join(newest.get("mysql", []) + newest.get("sqlite", [])))
        check("migration stamps the current rules version",
              bool(stamped) and all(int(s) == int(policy.get("version", -1)) for s in stamped),
              f"stamped={stamped} policy v{policy.get('version')}")

        # 8f · the write endpoints really do pass the gate
        site_src = (SRC / "Front" / "SiteController.php").read_text(encoding="utf-8")
        check("submitScore() passes the licence gate", "$this->gate(" in php_method(site_src, "submitScore"))
        check("play() passes the licence gate", "$this->gate(" in php_method(site_src, "play"))
        check("gate() consults LicenseAuditor",
              "$this->licenses->canServe(" in php_method(site_src, "gate"))

    # -- 9: providers --------------------------------------------------------------------
    guard_path = SRC / "Providers" / "UrlGuard.php"
    if not guard_path.is_file():
        check("providers layer present", False, "src/Providers/ missing")
    else:
        guard_src = guard_path.read_text(encoding="utf-8")
        converter_src = (SRC / "Providers" / "FeedConverter.php").read_text(encoding="utf-8")
        pack_src = (SRC / "Providers" / "OssPack.php").read_text(encoding="utf-8")

        def php_list(src: str, name: str) -> list:
            m = re.search(name + r"\s*=\s*\[(.*?)\];", src, re.S)
            return re.findall(r"'([^']+)'", m.group(1)) if m else []

        def py_list(src: str, name: str) -> list:
            m = re.search(r"^" + name + r"\s*=\s*\[(.*?)\]", src, re.S | re.M)
            return re.findall(r'"([^"]+)"', m.group(1)) if m else []

        # 9a · the reserved ranges the PHP blocks are exactly the ranges the proof attacks
        for name in ("BLOCKED_V4", "BLOCKED_V6", "BLOCKED_HOSTS", "BLOCKED_SUFFIXES"):
            php_ranges, py_ranges = php_list(guard_src, name), py_list(prove, name)
            check(f"{name} is identical in UrlGuard and the proof", php_ranges == py_ranges,
                  f"php={php_ranges} proof={py_ranges}")
            if name.startswith("BLOCKED_V"):
                check(f"{name} is not empty", len(php_ranges) > 0)
        check("169.254.0.0/16 (cloud metadata) is blocked", "169.254.0.0/16" in php_list(guard_src, "BLOCKED_V4"))
        check("127.0.0.0/8 (loopback) is blocked", "127.0.0.0/8" in php_list(guard_src, "BLOCKED_V4"))

        # 9b · the required-field lists match their mirrors
        for php_name, py_name, src in [
            ("REQUIRED", "PACK_REQUIRED", pack_src),
            ("REQUIRED_ITEM", "FEED_REQUIRED_ITEM", converter_src),
        ]:
            php_fields, py_fields = php_list(src, php_name), py_list(prove, py_name)
            check(f"{php_name} matches the proof", php_fields == py_fields,
                  f"php={php_fields} proof={py_fields}")

        # 9c · the feed SQL the proof runs is the SQL FeedConverter runs
        for frag in ["SELECT id FROM provider_games WHERE provider = ? AND external_id = ?",
                     "INSERT INTO provider_games (provider, external_id, payload, fetched_at)",
                     "UPDATE provider_games SET payload = ?, fetched_at = ? WHERE id = ?",
                     "INSERT INTO provider_runs (provider, status, rows_seen, rows_new, rows_rejected,"
                     " started_at)",
                     "UPDATE provider_runs SET status = ?, rows_seen = ?, rows_new = ?, rows_rejected"
                     " = ?, detail = ?, finished_at = ? WHERE id = ?"]:
            check(f"provider proof sync: '{frag.strip()[:48]}...'",
                  squash(frag) in squash(converter_src) and squash(frag) in squash(prove))

        # 9d · every refusal the proof exercises is actually implemented in the PHP. Without this
        # the range-list parity above only proves the two LISTS agree; deleting the userinfo branch
        # from UrlGuard would leave the list intact and open a real hole.
        hostile = re.search(r"HOSTILE_URLS\s*=\s*\[(.*?)\n\]", prove, re.S)
        expected_reasons = re.findall(r'\("([^"]+)",\s*"([a-z_]+)"\)', hostile.group(1)) if hostile else []
        reasons = sorted({r for _, r in expected_reasons if r})
        check("the proof declares a hostile-URL table", bool(reasons))
        missing = [r for r in reasons if f"'{r}'" not in guard_src]
        check("every refusal reason the proof attacks exists in UrlGuard.php", missing == [], str(missing))
        check("the proof attacks more than a token number of URLs", len(expected_reasons) >= 20,
              f"{len(expected_reasons)} cases")

        # 9e · a feed cannot be ingested past the guard, and the pack cannot be judged past the policy
        check("FeedConverter::ingest consults UrlGuard",
              "$this->guard->inspect(" in php_method(converter_src, "ingest"))
        check("FeedConverter::ingest consults LicensePolicy",
              "$this->policy->decide(" in php_method(converter_src, "ingest"))
        check("OssPack::verifyEntry consults LicensePolicy in export mode",
              "LicensePolicy::MODE_EXPORT" in php_method(pack_src, "verifyEntry"))

        # 9f · the shipped pack parses and its slugs are unique
        pack_file = ROOT / "db" / "oss_pack.json"
        pack_doc = json.loads(pack_file.read_text(encoding="utf-8")) if pack_file.is_file() else {}
        slugs = [e.get("slug") for e in pack_doc.get("entries", [])]
        check("db/oss_pack.json has entries with unique slugs",
              bool(slugs) and len(slugs) == len(set(slugs)), str(slugs))
        check("every pack entry names an upstream repo",
              all(str(e.get("upstream_repo") or "").startswith(("http://", "https://"))
                  for e in pack_doc.get("entries", []) if e.get("upstream_repo")))


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
