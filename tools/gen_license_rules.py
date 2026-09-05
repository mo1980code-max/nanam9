#!/usr/bin/env python3
"""Generates public/assets/license-rules.json from db/license_rules.json.

    python3 tools/gen_license_rules.py            # write the static copy
    python3 tools/gen_license_rules.py --verify   # CI: fail if it is stale or malformed

The static copy is BYTE-IDENTICAL to the source: the PHP runtime (Nawras\\Licensing\\LicensePolicy)
and the exported static site read the same file, so "what the dynamic site allowed" and "what the
static bundle allows" cannot disagree — the same guarantee tools/gen_schema_sql.py buys for the two
SQL dialects, applied to licence policy.

It also validates the rules document itself, because a typo in a policy file is worse than a typo
in code: a misspelt `needs` key silently stops demanding evidence.

  * every type carries the same flag keys (no type quietly missing `forbidden`);
  * every `needs` key is a known evidence field (no misspelt `comit_sha`);
  * every status declares servable + blocking;
  * every type referenced in docs/LICENSING.md exists (the doc cannot drift from the policy).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "db" / "license_rules.json"
OUT = ROOT / "public" / "assets" / "license-rules.json"
DOC = ROOT / "docs" / "LICENSING.md"

FLAG_KEYS = {
    "label_ar", "label_en", "note_en",
    "attribution_required", "share_alike", "copyleft",
    "commercial_ok", "redistribution_ok", "forbidden", "needs",
}


def validate(doc: dict) -> list[str]:
    problems: list[str] = []
    types = doc.get("types")
    if not isinstance(types, dict) or not types:
        return ["types must be a non-empty object"]

    evidence = set(doc.get("evidence", []))
    for name, spec in types.items():
        keys = set(spec)
        if keys != FLAG_KEYS:
            missing, extra = FLAG_KEYS - keys, keys - FLAG_KEYS
            problems.append(
                f"type '{name}' keys differ"
                + (f" · missing {sorted(missing)}" if missing else "")
                + (f" · unexpected {sorted(extra)}" if extra else "")
            )
        needs = spec.get("needs", {})
        if set(needs) != evidence:
            problems.append(
                f"type '{name}' needs must list exactly the evidence fields "
                f"{sorted(evidence)} (got {sorted(needs)})"
            )
        for flag in ("attribution_required", "share_alike", "copyleft",
                     "commercial_ok", "redistribution_ok", "forbidden"):
            if not isinstance(spec.get(flag), bool):
                problems.append(f"type '{name}' flag '{flag}' must be a boolean")
        for field, wanted in needs.items():
            if not isinstance(wanted, bool):
                problems.append(f"type '{name}' needs.{field} must be a boolean")
        if spec.get("forbidden") and spec.get("redistribution_ok"):
            problems.append(f"type '{name}' is forbidden but claims redistribution_ok")

    statuses = doc.get("statuses", {})
    if "active" not in statuses:
        problems.append("statuses must include 'active'")
    for name, spec in statuses.items():
        if not isinstance(spec.get("servable"), bool) or not isinstance(spec.get("blocking"), bool):
            problems.append(f"status '{name}' needs boolean servable + blocking")
        if spec.get("servable") and name != "active":
            problems.append(f"status '{name}' is servable but only 'active' may be")

    for mode in doc.get("modes", []):
        if mode not in ("dynamic", "export"):
            problems.append(f"unknown mode '{mode}'")

    labels = set(doc.get("finding_labels", {}))
    for name, spec in doc.get("formats", {}).items():
        if name not in evidence:
            problems.append(f"formats.{name} is not an evidence field")

    if DOC.is_file():
        schema = json.loads((ROOT / "db" / "schema.json").read_text(encoding="utf-8"))
        columns = {c for t in schema["tables"].values() for c in t["columns"]}
        tables = set(schema["tables"])
        doc_text = DOC.read_text(encoding="utf-8")
        for name in types:
            if name not in doc_text:
                problems.append(f"docs/LICENSING.md never mentions licence type '{name}'")
        for code in re.findall(r"`(missing_\w+|bad_\w+|no_\w+|type_forbidden|work_disputed|"
                               r"license_\w+|unknown_license_type|wildcard_origin|not_commercial_ok|"
                               r"no_redistribution|copyleft_review|unpinned_upstream|provider_mismatch|"
                               r"expires_soon|too_many_origins)`", doc_text):
            if code not in labels and code not in types and code not in statuses \
                    and code not in columns and code not in tables:
                problems.append(f"docs/LICENSING.md cites finding code '{code}' which the policy does not label")

    return problems


def main() -> int:
    if not SRC.is_file():
        print("db/license_rules.json missing")
        return 2
    raw = SRC.read_text(encoding="utf-8")
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"✗ db/license_rules.json is not valid JSON: {e}")
        return 1

    problems = validate(doc)
    if problems:
        print(f"✗ licence policy has {len(problems)} structural problem(s):")
        for p in problems:
            print(f"   - {p}")
        return 1

    if "--verify" in sys.argv:
        if not OUT.is_file():
            print(f"✗ {OUT.relative_to(ROOT)} missing — run: python3 tools/gen_license_rules.py")
            return 1
        if OUT.read_text(encoding="utf-8") != raw:
            print(f"✗ {OUT.relative_to(ROOT)} differs from db/license_rules.json")
            print("  fix: python3 tools/gen_license_rules.py")
            return 1
        print(f"✓ licence policy v{doc['version']} · {len(doc['types'])} types · "
              f"{len(doc['statuses'])} statuses · static copy identical")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(raw, encoding="utf-8")
    print(f"✓ wrote public/assets/license-rules.json · policy v{doc['version']} · "
          f"{len(doc['types'])} types · byte-identical to db/license_rules.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
