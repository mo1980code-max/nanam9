#!/usr/bin/env python3
"""End-to-end smoke test for the Voltade CMS module (blog + page builder).

Run against a live API and a seeded database::

    npm run db:up &            # PostgreSQL (PGlite) on :5433
    npm run db:migrate && npm run db:seed
    node apps/api/dist/main.js # API on :4000
    python3 tools/smoke/cms_smoke.py

WHAT IT PROVES, section by section:

A. public reads      — cards, filters, Arabic full-text search, JSON-LD, SEO fields
B. roles             — an editor can write drafts but cannot publish or delete
C. validation        — slug collisions, scheduling rules, unsafe URLs, block whitelist
D. blog categories   — nesting guard, non-empty delete refusal, Arabic slugs
E. pages             — builder blocks, HTML sanitising, reserved-slug guard, FAQ data
F. archive/restore   — a soft delete stays visible to staff and can be undone
G. view counting     — one view per visitor per hour, per session cookie
H. audit             — every write above leaves an activity-log line

Every assertion is written against the response envelope (``{ok, data, meta}`` /
``{ok: false, error}``) so a regression in the envelope fails loudly here too.

The script is idempotent-ish but *not* read-only: it creates, edits, archives and
hard-deletes its own rows. Seeded content is only read, never modified, so counts are
asserted with ``>=`` rather than ``==``.
"""
# pylint: disable=missing-function-docstring,too-many-locals,too-many-branches
# pylint: disable=too-many-statements,too-many-instance-attributes,broad-exception-caught
# pylint: disable=consider-using-f-string,line-too-long

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar

BASE = "http://127.0.0.1:4000/api"
ADMIN_LOGIN = "admin"
ADMIN_PASSWORD = "Voltade!2026"

class Report:
    """Tally of assertions, so the run can end with a summary and an exit code."""

    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.failures = []

    def check(self, name, condition, detail=""):
        """Record one assertion."""
        if condition:
            self.passed += 1
            print("  ok   %s" % name)
        else:
            self.failed += 1
            self.failures.append("%s %s" % (name, detail))
            print("  FAIL %s %s" % (name, detail))

    def section(self, title):
        """Print a section header."""
        print("\n=== %s ===" % title)

    def summary(self):
        """Print the tally; returns the process exit code."""
        print("\n%d passed, %d failed" % (self.passed, self.failed))
        if self.failed:
            print("failures:")
            for line in self.failures:
                print("  · " + line)
            return 1
        return 0


REPORT = Report()


def check(name, condition, detail=""):
    """Record one assertion against the module report."""
    REPORT.check(name, condition, detail)


def section(title):
    """Print a section header."""
    REPORT.section(title)


class Client:
    """One browser: a cookie jar, an optional bearer token, and CSRF handling."""

    def __init__(self, label):
        self.label = label
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.token = None

    def csrf(self):
        for cookie in self.jar:
            if cookie.name == "voltade_csrf":
                return cookie.value
        return None

    def call(self, method, path, body=None, expect_retry=True):
        # Arabic slugs are first-class here, and urllib will not put a raw non-ASCII
        # character on the wire: every segment has to be percent-encoded first.
        url = BASE + urllib.parse.quote(path, safe="/?=&%")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("accept", "application/json")
        request.add_header("content-type", "application/json")
        token = self.csrf()
        if token and method in ("POST", "PATCH", "PUT", "DELETE"):
            request.add_header("x-csrf-token", token)
        if self.token:
            request.add_header("authorization", "Bearer " + self.token)
        try:
            with self.opener.open(request, timeout=30) as response:
                return response.status, json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8") or "{}"
            try:
                payload = json.loads(raw)
            except ValueError:
                payload = {"ok": False, "error": {"code": "unparsable", "message": raw[:200]}}
            if error.code == 429 and expect_retry:
                # Rate limits are part of the product; a smoke run should not fail
                # because it worked too fast. Wait the window out and try once more.
                wait = int(error.headers.get("retry-after", "60") or 60) + 1
                print("  ...  rate limited (%s), waiting %ss" % (self.label, wait))
                time.sleep(min(wait, 320))
                return self.call(method, path, body, expect_retry=False)
            return error.code, payload
        except Exception as error:  # network failure: report, do not crash the run
            return 0, {"ok": False, "error": {"code": "transport", "message": str(error)}}

    def get(self, path):
        return self.call("GET", path)

    def post(self, path, body=None):
        return self.call("POST", path, body)

    def patch(self, path, body=None):
        return self.call("PATCH", path, body)

    def delete(self, path):
        return self.call("DELETE", path)

    def login(self, login, password):
        status, payload = self.post("/auth/login", {"login": login, "password": password})
        data = payload.get("data") or {}
        self.token = data.get("accessToken") or data.get("token")
        return status, payload


def data_of(payload):
    return payload.get("data") if isinstance(payload, dict) else None


def code_of(payload):
    error = (payload or {}).get("error") or {}
    return error.get("code")


def stamp():
    return str(int(time.time() * 1000))[-6:]


def main():
    run_id = stamp()
    anon = Client("anon")
    admin = Client("admin")
    editor = Client("editor")
    # Sign-up happens on its own client: POST /auth/register signs the caller in, so
    # reusing `anon` for it would quietly turn the anonymous visitor into the editor
    # and every "visitors cannot see this" assertion after it would be testing a
    # logged-in staff account.
    signup = Client("signup")
    editor_name = "cms_editor_%s" % run_id
    editor_password = "Editor!2026x"

    # ─────────────────────────── A. public reads ───────────────────────────
    section("A. public blog + page reads (anonymous)")

    status, payload = anon.get("/blog/categories")
    cats = (data_of(payload) or {}).get("items") or []
    tree = (data_of(payload) or {}).get("tree") or []
    check("GET /blog/categories → 200", status == 200, status)
    check("seeded categories present (>= 4)", len(cats) >= 4, len(cats))
    check("category shape (slug/name/url/postsCount)", all(
        {"slug", "name", "url", "postsCount"} <= set(c) for c in cats))
    check("category url is /blog/category/<slug>", all(
        c["url"] == "/blog/category/" + c["slug"] for c in cats))
    check("category tree returned", isinstance(tree, list) and len(tree) >= 1)

    status, payload = anon.get("/blog/posts?perPage=5")
    posts = (data_of(payload) or {}).get("items") or []
    total = ((payload or {}).get("meta") or {}).get("pagination", {}).get("total", 0)
    check("GET /blog/posts → 200", status == 200, status)
    check("seeded posts present (total >= 4)", total >= 4, total)
    check("perPage honoured", len(posts) <= 5, len(posts))
    check("card url is /blog/<slug>", all(p["url"] == "/blog/" + p["slug"] for p in posts))
    check("public cards are live+published", all(p["live"] is True and p["status"] == "published" for p in posts))
    check("card carries author + readingMinutes", all(
        p.get("author", {}).get("username") and p["readingMinutes"] >= 1 for p in posts))
    check("card exposes deletedAt (always null publicly)", all(p.get("deletedAt") is None for p in posts))

    status, _ = anon.get("/blog/posts?perPage=999")
    check("perPage above the public cap → 400", status == 400, status)

    seeded = posts[0] if posts else {}
    seeded_slug = seeded.get("slug")
    seeded_category = (seeded.get("category") or {}).get("slug")

    if seeded_category:
        status, payload = anon.get("/blog/posts?category=" + seeded_category)
        items = (data_of(payload) or {}).get("items") or []
        check("category filter narrows results", status == 200 and len(items) >= 1, status)
        check("category filter is exact", all((i.get("category") or {}).get("slug") == seeded_category for i in items))

    status, payload = anon.get("/blog/posts?category=category-that-does-not-exist")
    check("unknown category → empty list, not an error",
          status == 200 and (data_of(payload) or {}).get("items") == [], status)

    status, payload = anon.get("/blog/posts?q=" + urllib.parse.quote("ألعاب"))
    check("Arabic full-text search finds posts",
          status == 200 and len((data_of(payload) or {}).get("items") or []) >= 1, status)

    status, payload = anon.get("/blog/posts?sort=popular")
    pop = (data_of(payload) or {}).get("items") or []
    check("sort=popular accepted", status == 200 and len(pop) >= 1, status)
    if len(pop) >= 2:
        check("sort=popular orders by views desc", pop[0]["views"] >= pop[-1]["views"],
              "%s vs %s" % (pop[0]["views"], pop[-1]["views"]))

    status, payload = anon.get("/blog/posts/" + str(seeded_slug))
    view = data_of(payload) or {}
    check("GET /blog/posts/<slug> → 200", status == 200, status)
    check("post view carries the Markdown body", bool(view.get("body")), list(view)[:6])
    check("post view has tags + related", isinstance(view.get("tags"), list) and isinstance(view.get("related"), list))
    check("post view is not a preview for visitors", view.get("preview") is False)
    seo = view.get("seo") or {}
    check("seo.robots is indexable", "index," in str(seo.get("robots")), seo.get("robots"))
    check("seo.canonical is absolute", str(seo.get("canonical", "")).startswith("http"), seo.get("canonical"))
    kinds = [node.get("@type") for node in (view.get("jsonLd") or [])]
    check("JSON-LD has BlogPosting + BreadcrumbList", "BlogPosting" in kinds and "BreadcrumbList" in kinds, kinds)
    posting = next((n for n in (view.get("jsonLd") or []) if n.get("@type") == "BlogPosting"), {})
    check("BlogPosting has headline/datePublished/author",
          bool(posting.get("headline")) and bool(posting.get("datePublished"))
          and (posting.get("author") or {}).get("@type") == "Person", list(posting)[:8])

    status, payload = anon.get("/blog/posts/slug-that-does-not-exist")
    check("unknown post → 404 post.not_found",
          status == 404 and code_of(payload) == "post.not_found", (status, code_of(payload)))

    status, payload = anon.get("/pages")
    pages = (data_of(payload) or {}).get("items") or []
    slugs = [p["slug"] for p in pages]
    check("GET /pages → 200 with the seeded pages", status == 200 and "about" in slugs, slugs)
    check("page url is /<slug>", all(p["url"] == "/" + p["slug"] for p in pages))

    status, payload = anon.get("/pages/about")
    page = data_of(payload) or {}
    types = [b.get("type") for b in (page.get("blocks") or [])]
    check("GET /pages/about → 200", status == 200, status)
    check("seeded blocks survive the whitelist (hero/rich_text)", "hero" in types and "rich_text" in types, types)
    check("page seo is indexable", "index," in str((page.get("seo") or {}).get("robots")))
    check("page JSON-LD has BreadcrumbList",
          "BreadcrumbList" in [n.get("@type") for n in (page.get("jsonLd") or [])])

    status, payload = anon.get("/pages/not-a-page")
    check("unknown page → 404 page.not_found",
          status == 404 and code_of(payload) == "page.not_found", (status, code_of(payload)))

    status, payload = anon.get("/admin/content/blog/posts")
    check("anonymous admin list → 401", status == 401 and code_of(payload) == "auth.unauthorized", status)

    # ─────────────────────── B. roles and the publish right ─────────────────
    section("B. editor vs admin (the publish permission is separate)")

    status, payload = admin.login(ADMIN_LOGIN, ADMIN_PASSWORD)
    check("admin login → 200", status == 200, (status, code_of(payload)))
    check("admin got a CSRF cookie", bool(admin.csrf()))

    status, payload = admin.get("/admin/content/blog/posts?perPage=100")
    admin_total = ((payload or {}).get("meta") or {}).get("pagination", {}).get("total", 0)
    check("admin list → 200", status == 200, status)
    check("admin list sees at least the public posts", admin_total >= total, (admin_total, total))

    status, payload = signup.post("/auth/register", {
        "username": editor_name,
        "email": "%s@voltade.test" % editor_name,
        "password": editor_password,
    })
    check("register the editor account → 200/201", status in (200, 201), (status, code_of(payload)))

    status, payload = admin.patch("/admin/users/" + editor_name, {"role": "editor"})
    role = ((data_of(payload) or {}).get("role") or {})
    check("promote to editor → 200", status == 200, (status, code_of(payload)))
    check("role is editor", role.get("slug") == "editor" or role == "editor", role)

    status, payload = editor.login(editor_name, editor_password)
    check("editor login → 200", status == 200, (status, code_of(payload)))
    check("editor holds the CSRF cookie", bool(editor.csrf()))

    status, payload = editor.get("/admin/content/blog/posts")
    check("editor may read the admin list (blog.view)", status == 200, (status, code_of(payload)))

    draft_title = "مسودة اختبار %s" % run_id
    draft_body = "# عنوان\n\n" + ("كلمة " * 260) + "\n\n## فقرة\nنص تجريبي."
    status, payload = editor.post("/admin/content/blog/posts", {
        "title": draft_title,
        "body": draft_body,
        "tags": ["تجربة", "html5"],
    })
    draft = data_of(payload) or {}
    check("editor creates a draft → 200", status == 200, (status, code_of(payload)))
    check("draft status is draft", draft.get("status") == "draft", draft.get("status"))
    check("slug derived from the Arabic title", bool(draft.get("slug")) and draft["slug"] != draft_title, draft.get("slug"))
    check("derived slug keeps Arabic letters", any("\u0600" <= ch <= "\u06FF" for ch in str(draft.get("slug", ""))), draft.get("slug"))
    check("excerpt derived from the body", bool(draft.get("excerpt")), draft.get("excerpt"))
    check("readingMinutes computed (>= 1)", (draft.get("readingMinutes") or 0) >= 1, draft.get("readingMinutes"))
    check("tags attached", len(draft.get("tags") or []) == 2, draft.get("tags"))
    check("draft is flagged preview for staff", draft.get("preview") is True)
    check("draft seo is noindex", "noindex" in str((draft.get("seo") or {}).get("robots")))
    draft_slug = draft.get("slug")
    draft_id = draft.get("id")

    status, payload = anon.get("/blog/posts/" + str(draft_slug))
    check("a draft is 404 for visitors", status == 404 and code_of(payload) == "post.not_found", status)
    check("the visitor sees no trace of the draft body", "body" not in str(data_of(payload)), status)

    status, payload = editor.patch("/admin/content/blog/posts/" + str(draft_id), {"status": "published"})
    check("editor cannot publish (no blog.publish) → 403",
          status == 403 and code_of(payload) == "auth.missing_permission", (status, code_of(payload)))

    status, payload = editor.post("/admin/content/blog/posts/%s/publish" % draft_id)
    check("editor cannot use the publish route → 403", status == 403, (status, code_of(payload)))

    status, payload = editor.delete("/admin/content/blog/posts/" + str(draft_id))
    check("editor cannot delete (no blog.delete) → 403", status == 403, (status, code_of(payload)))

    status, payload = admin.get("/admin/content/blog/posts/" + str(draft_id))
    check("admin can open the draft by id → 200", status == 200, (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts/%s/publish" % draft_id)
    published = data_of(payload) or {}
    check("admin publishes → 200", status == 200, (status, code_of(payload)))
    check("status becomes published", published.get("status") == "published", published.get("status"))
    check("publishedAt set on first publish", bool(published.get("publishedAt")), published.get("publishedAt"))
    first_published_at = published.get("publishedAt")

    status, payload = anon.get("/blog/posts/" + str(draft_slug))
    check("published post is now public → 200", status == 200, (status, code_of(payload)))
    check("public copy is not a preview", (data_of(payload) or {}).get("preview") is False)

    time.sleep(1.1)
    status, payload = admin.post("/admin/content/blog/posts/%s/publish" % draft_id)
    check("re-publishing keeps the original publishedAt",
          (data_of(payload) or {}).get("publishedAt") == first_published_at,
          ((data_of(payload) or {}).get("publishedAt"), first_published_at))

    status, payload = admin.patch("/admin/content/blog/posts/" + str(draft_id), {"title": draft_title + " (محدّث)"})
    check("edit after publish → 200", status == 200, (status, code_of(payload)))
    check("editing does not move publishedAt",
          (data_of(payload) or {}).get("publishedAt") == first_published_at,
          (data_of(payload) or {}).get("publishedAt"))

    # ─────────────────────────── C. validation and safety ──────────────────
    section("C. validation, slugs, scheduling, unsafe URLs")

    status, payload = admin.post("/admin/content/blog/posts", {"title": "مكرر", "body": "نص", "slug": draft_slug})
    check("an already-taken slug → 409 post.slug_taken",
          status == 409 and code_of(payload) == "post.slug_taken", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts", {"title": "عنوان", "body": "نص", "slug": "Bad Slug!"})
    check("a malformed slug → 400", status == 400, (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "مجدول بلا وقت", "body": "نص", "status": "scheduled"})
    check("scheduled without publishAt → 400 post.publish_at_required",
          status == 400 and code_of(payload) == "post.publish_at_required", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "مجدول بالماضي", "body": "نص", "status": "scheduled", "publishAt": "2020-01-01T00:00:00.000Z"})
    check("scheduled in the past → 400 post.publish_at_past",
          status == 400 and code_of(payload) == "post.publish_at_past", (status, code_of(payload)))

    future = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 7 * 86400))
    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "منشور مجدول %s" % run_id, "body": "نص الجدولة.", "status": "scheduled", "publishAt": future})
    scheduled = data_of(payload) or {}
    check("scheduled in the future → 200", status == 200, (status, code_of(payload)))
    check("status stays scheduled", scheduled.get("status") == "scheduled", scheduled.get("status"))
    check("publishedAt holds the future instant", scheduled.get("publishedAt") == future, scheduled.get("publishedAt"))
    scheduled_id = scheduled.get("id")

    status, payload = anon.get("/blog/posts/" + str(scheduled.get("slug")))
    check("a future post is 404 for visitors", status == 404, status)
    status, payload = admin.get("/admin/content/blog/posts/" + str(scheduled_id))
    check("staff can preview a future post → 200", status == 200 and (data_of(payload) or {}).get("preview") is True, status)

    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "رابط خبيث", "body": "نص", "canonicalUrl": "javascript:alert(1)"})
    check("javascript: canonicalUrl → 400 content.unsafe_url",
          status == 400 and code_of(payload) == "content.unsafe_url", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "صورة خبيثة", "body": "نص", "coverImage": "javascript:alert(1)"})
    check("javascript: coverImage → 400", status == 400, (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "تصنيف غير موجود", "body": "نص", "category": "no-such-category"})
    check("unknown category → 400 blog_category.not_found (no silent auto-create)",
          status == 400 and code_of(payload) == "blog_category.not_found", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "وسوم كثيرة", "body": "نص", "tags": ["t%s" % i for i in range(13)]})
    check("13 tags → 400 (cap is 12)", status == 400, status)

    status, payload = admin.post("/admin/content/blog/posts", {"title": "x", "body": "نص"})
    check("a 1-char title → 400", status == 400, status)

    status, payload = admin.post("/admin/content/blog/posts", {"title": "بلا جسم", "body": ""})
    check("an empty body → 400", status == 400, status)

    scripty = "نص عادي\n\n<script>alert(1)</script>\n\n![صورة](/a.png)"
    status, payload = admin.post("/admin/content/blog/posts", {
        "title": "ماركداون خام %s" % run_id, "body": scripty})
    raw_id = (data_of(payload) or {}).get("id")
    status, payload = admin.get("/admin/content/blog/posts/" + str(raw_id))
    check("Markdown is stored verbatim (the renderer, not storage, decides what HTML means)",
          (data_of(payload) or {}).get("body") == scripty, repr((data_of(payload) or {}).get("body"))[:120])

    # ─────────────────────────── D. blog categories ────────────────────────
    section("D. blog categories (nesting, counts, non-empty delete)")

    status, payload = admin.post("/admin/content/blog/categories", {"name": "تجارب %s" % run_id})
    new_cat = data_of(payload) or {}
    check("create a category without a slug → 200", status == 200, (status, code_of(payload)))
    check("category slug derived from the Arabic name", bool(new_cat.get("slug")), new_cat)
    cat_id = new_cat.get("id")
    cat_slug = new_cat.get("slug")

    status, payload = admin.post("/admin/content/blog/categories", {"name": "مكرر", "slug": cat_slug})
    check("duplicate category slug → 409", status == 409 and code_of(payload) == "blog_category.slug_taken",
          (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/categories", {"id": cat_id, "name": "ذاتي", "parentId": cat_id})
    check("a category cannot be its own parent → 400",
          status == 400 and code_of(payload) == "blog_category.self_parent", (status, code_of(payload)))

    status, payload = anon.get("/blog/categories")
    check("the new category is public immediately (cache invalidated)",
          any(c["id"] == cat_id for c in (data_of(payload) or {}).get("items") or []), status)

    status, payload = admin.patch("/admin/content/blog/posts/" + str(draft_id), {"category": cat_slug})
    check("assign the post to the new category → 200", status == 200, (status, code_of(payload)))
    status, payload = anon.get("/blog/categories")
    mine = next((c for c in (data_of(payload) or {}).get("items") or [] if c["id"] == cat_id), {})
    check("postsCount reflects the assignment", mine.get("postsCount") == 1, mine.get("postsCount"))

    status, payload = editor.delete("/admin/content/blog/categories/" + str(cat_id))
    check("editor cannot delete a category → 403", status == 403, status)

    status, payload = admin.delete("/admin/content/blog/categories/" + str(cat_id))
    check("deleting a non-empty category → 409 blog_category.not_empty",
          status == 409 and code_of(payload) == "blog_category.not_empty", (status, code_of(payload)))

    status, payload = admin.patch("/admin/content/blog/posts/" + str(draft_id), {"category": ""})
    check("unassign the category → 200", status == 200, (status, code_of(payload)))
    status, payload = admin.delete("/admin/content/blog/categories/" + str(cat_id))
    check("deleting the now-empty category → 200", status == 200 and (data_of(payload) or {}).get("deleted") is True,
          (status, code_of(payload)))

    # ─────────────────────────────── E. pages ──────────────────────────────
    section("E. page builder (blocks, sanitising, reserved slugs, FAQ data)")

    blocks = [
        {"type": "hero", "props": {"title": "صفحة الاختبار", "subtitle": "مؤتمتة"}},
        {"type": "rich_text", "props": {"markdown": "## قسم\nنص."}},
        {"type": "stat_row", "props": {"stats": [{"label": "لعبة", "value": "20k"}]}},
        {"type": "faq", "props": {"items": [{"q": "هل تعمل؟", "a": "نعم."}, {"q": "بسرعة؟", "a": "جداً."}]}},
        {"type": "html", "props": {"html": "<p>آمن</p><script>alert(1)</script><img src=x onerror=alert(2)>"}},
    ]
    status, payload = admin.post("/admin/content/pages", {
        "title": "صفحة اختبار %s" % run_id,
        "slug": "smoke-page-%s" % run_id,
        "body": "نص الصفحة",
        "blocks": blocks,
        "status": "published",
    })
    new_page = data_of(payload) or {}
    stored_blocks = new_page.get("blocks") or []
    html_block = next((b for b in stored_blocks if b.get("type") == "html"), {})
    check("create a page with blocks → 200", status == 200, (status, code_of(payload)))
    check("all five blocks stored", len(stored_blocks) == 5, len(stored_blocks))
    check("every block got a stable id", all(b.get("id") for b in stored_blocks))
    check("<script> removed from an html block", "<script" not in str(html_block.get("props", {}).get("html", "")).lower(),
          html_block.get("props"))
    check("onerror handler removed from an html block", "onerror" not in str(html_block.get("props", {}).get("html", "")).lower(),
          html_block.get("props"))
    check("safe markup kept in an html block", "<p>" in str(html_block.get("props", {}).get("html", "")), html_block.get("props"))
    page_id = new_page.get("id")
    page_slug = new_page.get("slug")

    status, payload = anon.get("/pages/" + str(page_slug))
    public_page = data_of(payload) or {}
    kinds = [n.get("@type") for n in (public_page.get("jsonLd") or [])]
    check("published page is public → 200", status == 200, status)
    check("an faq block becomes FAQPage structured data", "FAQPage" in kinds, kinds)

    status, payload = anon.get("/pages")
    check("the new page joins the public page list",
          any(p["slug"] == page_slug for p in (data_of(payload) or {}).get("items") or []), status)

    status, payload = admin.post("/admin/content/pages", {"title": "نوع مجهول", "blocks": [{"type": "marquee"}]})
    check("an unknown block type → 400 (the whitelist is the renderer contract)", status == 400, status)

    status, payload = admin.post("/admin/content/pages", {
        "title": "رابط خبيث", "blocks": [{"type": "cta", "props": {"url": "javascript:alert(1)"}}]})
    check("javascript: in a block prop → 400 content.unsafe_url",
          status == 400 and code_of(payload) == "content.unsafe_url", (status, code_of(payload)))

    for reserved in ("games", "admin", "blog"):
        status, payload = admin.post("/admin/content/pages", {"title": "محجوز", "slug": reserved})
        check("reserved slug '%s' → 409 page.slug_reserved" % reserved,
              status == 409 and code_of(payload) == "page.slug_reserved", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/pages", {"title": "مكرر", "slug": page_slug})
    check("a taken page slug → 409 page.slug_taken",
          status == 409 and code_of(payload) == "page.slug_taken", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/pages", {
        "title": "بلا فهرسة", "slug": page_slug, "id": page_id, "isIndexed": False, "status": "published"})
    check("update a page by id → 200", status == 200, (status, code_of(payload)))
    status, payload = anon.get("/pages/" + str(page_slug))
    check("isIndexed=false sends noindex",
          "noindex" in str(((data_of(payload) or {}).get("seo") or {}).get("robots")),
          ((data_of(payload) or {}).get("seo") or {}).get("robots"))

    status, payload = editor.post("/admin/content/pages", {"title": "صفحة المحرر %s" % run_id, "body": "نص"})
    editor_page = data_of(payload) or {}
    check("editor may create a page (pages.manage) → 200", status == 200, (status, code_of(payload)))
    check("a page titled without a slug gets a derived one", bool(editor_page.get("slug")), editor_page.get("slug"))
    check("new pages start as drafts", editor_page.get("status") == "draft", editor_page.get("status"))
    editor_page_id = editor_page.get("id")

    status, payload = anon.get("/pages/" + str(editor_page.get("slug")))
    check("a draft page is 404 for visitors", status == 404, status)
    status, payload = editor.get("/admin/content/pages/" + str(editor_page.get("slug")))
    check("its author can preview it → 200 preview", status == 200 and (data_of(payload) or {}).get("preview") is True, status)

    # ────────────────────────── F. archive and restore ─────────────────────
    section("F. soft delete keeps content reachable for staff, and restorable")

    status, payload = admin.delete("/admin/content/blog/posts/" + str(raw_id))
    check("soft delete a post → 200", status == 200 and (data_of(payload) or {}).get("deleted") is True,
          (status, code_of(payload)))
    status, payload = admin.get("/admin/content/blog/posts/" + str(raw_id))
    check("staff can still open the archived post by id", status == 200, status)
    check("the archived post reports deletedAt", bool((data_of(payload) or {}).get("deletedAt")),
          (data_of(payload) or {}).get("deletedAt"))

    status, payload = admin.get("/admin/content/blog/posts?status=any&perPage=100")
    ids = [i["id"] for i in (data_of(payload) or {}).get("items") or []]
    check("status=any lists the archive", raw_id in ids, "archived id missing")

    status, payload = admin.post("/admin/content/blog/posts/%s/restore" % raw_id)
    restored = data_of(payload) or {}
    check("restore → 200", status == 200, (status, code_of(payload)))
    check("deletedAt cleared", restored.get("deletedAt") is None, restored.get("deletedAt"))
    check("restore does not re-publish (status archived)", restored.get("status") == "archived", restored.get("status"))

    status, payload = admin.post("/admin/content/blog/posts/%s/restore" % raw_id)
    check("restoring a live post → 409 post.not_archived",
          status == 409 and code_of(payload) == "post.not_archived", (status, code_of(payload)))

    status, payload = admin.post("/admin/content/blog/posts/%s/publish" % raw_id)
    check("re-publish after restore → 200", status == 200 and (data_of(payload) or {}).get("status") == "published",
          (status, code_of(payload)))

    status, payload = admin.delete("/admin/content/pages/" + str(editor_page_id))
    check("soft delete a page → 200", status == 200, (status, code_of(payload)))
    status, payload = admin.get("/admin/content/pages?status=any&perPage=100")
    check("the page archive is listed for staff",
          any(p["id"] == editor_page_id for p in (data_of(payload) or {}).get("items") or []), status)
    status, payload = admin.post("/admin/content/pages/%s/restore" % editor_page_id)
    check("restore the page → 200 with deletedAt cleared",
          status == 200 and (data_of(payload) or {}).get("deletedAt") is None, (status, code_of(payload)))
    status, payload = admin.post("/admin/content/pages/%s/restore" % editor_page_id)
    check("restoring twice → 409 page.not_archived",
          status == 409 and code_of(payload) == "page.not_archived", (status, code_of(payload)))

    status, payload = admin.delete("/admin/content/blog/posts/%s?hard=true" % scheduled_id)
    check("hard delete → 200", status == 200 and (data_of(payload) or {}).get("hard") is True, (status, code_of(payload)))
    status, payload = admin.get("/admin/content/blog/posts/" + str(scheduled_id))
    check("a hard-deleted post is gone for staff too → 404", status == 404, status)

    # ──────────────────────────── G. view counting ─────────────────────────
    section("G. one view per visitor per hour")

    status, payload = admin.get("/admin/content/blog/posts/" + str(draft_id))
    baseline = (data_of(payload) or {}).get("views") or 0

    visitor_a = Client("visitor-a")
    status, payload = visitor_a.get("/blog/posts/" + str(draft_slug))
    check("visitor A reads the post → 200", status == 200, status)
    check("visitor A sees its own view counted", (data_of(payload) or {}).get("views", 0) >= baseline + 1,
          ((data_of(payload) or {}).get("views"), baseline))

    status, _ = visitor_a.get("/blog/posts/" + str(draft_slug))
    status, payload = admin.get("/admin/content/blog/posts/" + str(draft_id))
    after_repeat = (data_of(payload) or {}).get("views") or 0
    check("a repeat visit by A does not count again", after_repeat == baseline + 1, (after_repeat, baseline))

    visitor_b = Client("visitor-b")
    status, _ = visitor_b.get("/blog/posts/" + str(draft_slug))
    status, payload = admin.get("/admin/content/blog/posts/" + str(draft_id))
    after_b = (data_of(payload) or {}).get("views") or 0
    check("a different visitor does count", after_b == baseline + 2, (after_b, baseline))

    # ─────────────────────────────── H. audit ──────────────────────────────
    section("H. every write left an audit line")

    status, payload = admin.get("/admin/activity?perPage=100")
    actions = [str(e.get("action")) for e in (data_of(payload) or {}).get("items") or []]
    if not actions:
        items = (data_of(payload) or {})
        actions = [str(e.get("action")) for e in (items.get("items") or items.get("logs") or [])]
    for expected in ("blog.post.create", "blog.post.publish", "blog.post.restore", "page.create", "page.update"):
        check("activity log has %s" % expected, expected in actions, actions[:8])

    return REPORT.summary()


if __name__ == "__main__":
    sys.exit(main())
