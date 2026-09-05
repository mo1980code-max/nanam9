#!/usr/bin/env python3
"""Live demo server for the Nawras Arcade leaderboard engine.

Runs the REAL proof-harness logic (tools/prove_runtime.py Board — the same SQL the PHP
class executes) on a seeded SQLite database, exposes the same HTTP contract as
SiteController (/api/leaderboard with the eight period types), serves the rendered docs,
and reports the live gate output. Zero dependencies.

    python3 demo/serve_demo.py            # http://0.0.0.0:8090
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from prove_runtime import Board, bucket_key  # noqa: E402  (same SQL as Gamify\Leaderboard)

PORT = int(__import__("os").environ.get("PORT", "8090"))
NOW = "2026-09-05 12:00:00"
DOCS = ["LEADERBOARD", "UPGRADING", "CA-COMPAT", "README"]

GAMES = [
    (1, "neon-worm", "نيون وورم", "casual"),
    (2, "echo-cards", "إيكو كاردز", "cards"),
    (3, "bubble-nova", "فقاعة نوفا", "puzzle"),
    (4, "maze-runner", "عدّاء المتاهة", "action"),
]

# (game_id, score, alias, timestamp) — spread across today / this week / month / older
SEED = [
    (1, 700, "سارة", "2026-09-05 13:00:00"), (1, 500, "سارة", "2026-09-05 12:00:00"),
    (1, 1000, "عمر", "2026-09-05 09:00:00"), (1, 300, "لينا", "2026-09-01 08:00:00"),
    (1, 4000, "زياد", "2026-08-20 08:00:00"), (1, 900, "نور", "2026-07-15 10:00:00"),
    (2, 850, "سارة", "2026-09-05 10:00:00"), (2, 620, "خالد", "2026-09-04 16:00:00"),
    (2, 1200, "نور", "2026-09-03 11:00:00"), (2, 450, "لينا", "2026-08-25 09:00:00"),
    (3, 340, "عمر", "2026-09-05 08:30:00"), (3, 780, "زياد", "2026-09-04 19:00:00"),
    (3, 910, "سارة", "2026-08-30 14:00:00"),
    (4, 1500, "خالد", "2026-09-05 11:00:00"), (4, 1320, "نور", "2026-09-02 18:00:00"),
    (4, 990, "عمر", "2026-08-18 12:00:00"), (4, 2400, "لينا", "2026-07-20 09:30:00"),
]

TYPES = {
    "top": ("all", True), "top-day": ("day", True), "top-week": ("week", True),
    "top-month": ("month", True), "top-all": ("all", False), "top-all-day": ("day", False),
    "top-all-week": ("week", False), "top-all-month": ("month", False),
}

GATES_OUT = ""


def build_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript((ROOT / "db" / "schema.sqlite.sql").read_text(encoding="utf-8"))
    for gid, slug, title, cat in GAMES:
        conn.execute(
            "INSERT INTO games (id, slug, title_ar, title_en, category_id, created_at, updated_at) "
            "VALUES (?,?,?,?,NULL,'2026-08-01 00:00:00','2026-08-01 00:00:00')",
            (gid, slug, title, slug))
        conn.execute(
            "INSERT INTO categories (id, slug, name_ar, name_en, created_at) "
            "VALUES (?,?,?,?,'2026-08-01 00:00:00')", (gid, slug, title, cat))
        conn.execute("UPDATE games SET category_id = ? WHERE id = ?", (gid, gid))
    board = Board(conn)
    for gid, score, alias, at in SEED:
        board.submit(gid, score, alias, at)
    return conn


# ------------------------------------------------------------------ markdown (small)
def md_to_html(md: str) -> str:
    out, in_code, in_table = [], False, False
    lines = md.splitlines()

    def inline(s: str) -> str:
        s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
        return s

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            if in_code:
                out.append("</pre>")
                in_code = False
            else:
                out.append("<pre class='code'>")
                in_code = True
            i += 1
            continue
        if in_code:
            out.append(line.replace("&", "&amp;").replace("<", "&lt;"))
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|?$", lines[i + 1]):
            out.append("<table><thead><tr>" + "".join(f"<th>{inline(c.strip())}</th>" for c in line.strip("|").split("|")) + "</tr></thead><tbody>")
            in_table = True
            i += 2
            continue
        if in_table and line.startswith("|"):
            out.append("<tr>" + "".join(f"<td>{inline(c.strip())}</td>" for c in line.strip("|").split("|")) + "</tr>")
            i += 1
            continue
        if in_table:
            out.append("</tbody></table>")
            in_table = False
        if line.startswith("### "):
            out.append(f"<h3>{inline(line[4:])}</h3>")
        elif line.startswith("## "):
            out.append(f"<h2>{inline(line[3:])}</h2>")
        elif line.startswith("# "):
            out.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("> "):
            out.append(f"<blockquote>{inline(line[2:])}</blockquote>")
        elif re.match(r"^\s*[-*] ", line):
            text = re.sub(r"^\s*[-*] ", "", line)
            out.append(f"<li>{inline(text)}</li>")
        elif line.strip().startswith("$ ") or line.strip() and lines[max(0, i - 1)].strip().startswith("$"):
            out.append(f"<div class='term'>{inline(line.strip())}</div>")
        elif line.strip():
            out.append(f"<p>{inline(line.strip())}</p>")
        i += 1
    if in_table:
        out.append("</tbody></table>")
    return "\n".join(out)


# ------------------------------------------------------------------ handler
DB_LOCK = threading.Lock()


def ensure_zip() -> Path:
    """The download bundle: arcade/ alone at the zip root, rebuilt from HEAD if missing."""
    zp = ROOT.parent.parent / "nawras-arcade.zip"  # outside the repo, downloads dir of the sandbox
    if zp.is_file() and zp.stat().st_size > 1000:
        return zp
    import subprocess as sp
    import tarfile
    import tempfile
    import zipfile as zf
    with tempfile.TemporaryDirectory() as td:
        tar_p = Path(td) / "pkg.tar"
        with open(tar_p, "wb") as fh:
            sp.run(["git", "archive", "--format=tar", "HEAD", "arcade"],
                   cwd=str(ROOT.parent), stdout=fh, check=True)
        with tarfile.open(tar_p) as tf:
            tf.extractall(td)
        src = Path(td) / "arcade"
        with zf.ZipFile(zp, "w", zf.ZIP_DEFLATED) as z:
            for f in sorted(src.rglob("*")):
                if f.is_file():
                    z.write(f, f.relative_to(src))
    return zp


class Handler(BaseHTTPRequestHandler):
    conn: sqlite3.Connection = None  # type: ignore[assignment]
    gates: str = ""

    def log_message(self, *a):  # quieter logs
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, html, status=200):
        body = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/api/leaderboard":
            type_ = (q.get("type") or ["top-week"])[0]
            if type_ not in TYPES:
                self._json({"ok": False, "error": f"Unknown type '{type_}'. Valid: " + ", ".join(TYPES)}, 422)
                return
            period, per_game = TYPES[type_]
            amount = max(1, min(100, int((q.get("amount") or ["10"])[0] or 10)))
            slug = (q.get("game") or [""])[0].strip()
            game = None
            if slug:
                with DB_LOCK:
                    game = self.conn.execute("SELECT id, slug FROM games WHERE slug = ?", (slug,)).fetchone()
                if game is None:
                    self._json({"ok": False, "error": f"game '{slug}' not found"}, 404)
                    return
            if per_game and game is None:
                self._json({"ok": False, "error": "this type needs ?game=slug"}, 422)
                return
            with DB_LOCK:
                board = Board(self.conn)
                rows = board.for_type(game[0] if game else None, type_, amount)
            self._json({
                "ok": True, "type": type_,
                "game": game[1] if game else None,
                "period_key": bucket_key(period, NOW),
                "amount": amount,
                "rows": [
                    {"rank": n, "game_id": r[0], "game_slug": r[1], "alias": r[2],
                     "score": r[3], "submitted_at": r[4]}
                    for n, r in enumerate(rows, 1)
                ],
            })
            return

        if u.path == "/api/gates":
            self._json({"ok": True, "output": self.gates})
            return

        if u.path == "/download":
            try:
                zp = ensure_zip()
            except Exception as e:  # git absent or repo moved — say so, don't half-serve
                self._json({"ok": False, "error": f"bundle unavailable: {e}"}, 500)
                return
            body = zp.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", "attachment; filename=\"nawras-arcade.zip\"")
            self.end_headers()
            self.wfile.write(body)
            return

        if u.path == "/" or u.path == "/demo":
            self._html((ROOT / "demo" / "demo.html").read_text(encoding="utf-8"))
            return

        m = re.match(r"^/docs/([\w-]+)\.html$", u.path)
        if m and m.group(1) in DOCS:
            name = m.group(1)
            md = (ROOT / "docs" / f"{name}.md").read_text(encoding="utf-8")
            if name == "README":
                md = (ROOT / "README.md").read_text(encoding="utf-8")
            self._html(WRAP.replace("{{TITLE}}", name).replace("{{BODY}}", md_to_html(md)))
            return

        self._json({"ok": False, "error": "not found"}, 404)


WRAP = """<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}} · أركيد نورس</title>
<style>
 body{background:#0e1220;color:#e8eaf6;font-family:'Segoe UI',Tahoma,sans-serif;margin:0;padding:2rem;line-height:1.9}
 main{max-width:880px;margin:auto} a{color:#8ab4ff} h1,h2,h3{color:#c3b8ff}
 pre.code,.term{background:#161b2e;border:1px solid #2a3150;border-radius:10px;padding:.9rem 1.1rem;overflow-x:auto;direction:ltr;text-align:left}
 .term{color:#9ff2b8} code{background:#1d2440;border-radius:6px;padding:.1rem .4rem;direction:ltr;display:inline-block}
 table{border-collapse:collapse;width:100%;margin:1rem 0} th,td{border:1px solid #2a3150;padding:.5rem .8rem;text-align:right}
 th{background:#1a2140;color:#c3b8ff} blockquote{border-right:4px solid #7c5cff;margin:0;padding-right:1rem;color:#b8c0e8}
</style></head><body><main>{{BODY}}</main></body></html>"""


def main() -> int:
    global GATES_OUT
    Handler.conn = build_db()
    try:
        GATES_OUT = subprocess.run(
            ["npm", "test"], cwd=str(ROOT), capture_output=True, text=True, timeout=120
        ).stdout
    except Exception as e:  # npm absent in some environments — show tools individually
        parts = []
        for tool in ["tools/verify_php.py", "tools/prove_runtime.py", "tools/gen_schema_sql.py"]:
            r = subprocess.run([sys.executable, tool], cwd=str(ROOT), capture_output=True, text=True, timeout=120)
            parts.append(r.stdout.strip() + ("  exit=0" if r.returncode == 0 else f"  exit={r.returncode}"))
        GATES_OUT = "\n".join(parts) + f"\n(npm fallback: {e})"

    Handler.gates = GATES_OUT
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Nawras Arcade demo → http://0.0.0.0:{PORT}  (Ctrl+C لإيقاف)")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
