#!/usr/bin/env python3
"""Live discovery of Agent Skills across the public ecosystem.

Queries several independent sources in parallel and returns one normalized,
ranked JSON list. Uses `gh` when it is installed and authenticated (better
rate limits plus code search); otherwise falls back to the unauthenticated
GitHub API, which still covers repository search.

Nothing here decides what to install. It returns candidates and the evidence
behind them so the agent can read the actual SKILL.md before recommending it.

Usage:
  discover_skills.py --query "playwright e2e" --query "astro" [--limit 12]
  discover_skills.py --inspect owner/repo [--path skills/foo/SKILL.md]
  discover_skills.py --indexes     # just list the curated index repos, live
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

API = "https://api.github.com"
UA = {"User-Agent": "skill-scout", "Accept": "application/vnd.github+json"}
TIMEOUT = 20
CACHE_DIR = os.path.join(os.environ.get("TMPDIR", "/tmp"), "skill-scout-cache")
CACHE_TTL = 6 * 3600  # only long-lived documents (index READMEs) are cached

# Topics that the ecosystem actually converged on. Kept short on purpose:
# a wide topic net returns generic "awesome" repos instead of usable skills.
TOPICS = ["claude-skills", "agent-skills", "claude-code-skills", "claude-code-plugin"]

# Provenance tiers. Higher tier means the burden of proof for trusting the
# content is lower - but never zero, which is why vetting is a separate step.
TIER_OFFICIAL, TIER_CURATED, TIER_COMMUNITY = 3, 2, 1
OFFICIAL_OWNERS = {"anthropics", "anthropic-experimental"}

# Curated indexes, resolved live (default branch is looked up, never assumed).
# These carry human-written descriptions, which beats raw repo metadata.
INDEX_REPOS = [
    "anthropics/skills",
    "travisvn/awesome-claude-skills",
    "ComposioHQ/awesome-claude-skills",
    "obra/superpowers",
]


def have_gh():
    try:
        return subprocess.run(["gh", "auth", "status"], capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


GH = have_gh()
WARNINGS = []  # a silently empty source looks identical to "nothing exists" - it is not


def gh_api(path, params=None):
    """GitHub API through `gh` when available, plain HTTPS otherwise."""
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    if GH:
        try:
            r = subprocess.run(["gh", "api", path + qs], capture_output=True, text=True, timeout=TIMEOUT)
            if r.returncode == 0:
                return json.loads(r.stdout)
        except Exception:
            pass
    try:
        req = urllib.request.Request(API + "/" + path.lstrip("/") + qs, headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as fh:
            return json.loads(fh.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 429):
            msg = ("GitHub API rate-limited or unauthorized (HTTP %d) on %s. "
                   "Results are incomplete - authenticate `gh` or retry later." % (e.code, path))
            if msg not in WARNINGS:
                WARNINGS.append(msg)
        return None
    except Exception:
        return None


def fetch_text(url, cache=True):
    key = os.path.join(CACHE_DIR, re.sub(r"\W+", "_", url)[-150:])
    if cache and os.path.exists(key) and time.time() - os.path.getmtime(key) < CACHE_TTL:
        return open(key, encoding="utf-8", errors="replace").read()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=TIMEOUT) as fh:
            body = fh.read().decode("utf-8", "replace")
    except Exception:
        return ""
    if cache:
        os.makedirs(CACHE_DIR, exist_ok=True)
        try:
            open(key, "w", encoding="utf-8").write(body)
        except Exception:
            pass
    return body


def months_since(iso):
    if not iso:
        return 99.0
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - d).days / 30.4
    except Exception:
        return 99.0


# ---------------------------------------------------------------- sources

def search_repos(query):
    """Repository search: the highest-signal channel. Skills ship as repos."""
    out = []
    for topic in TOPICS:
        data = gh_api("search/repositories", {
            "q": f"{query} topic:{topic}", "sort": "stars", "order": "desc", "per_page": 12})
        for r in (data or {}).get("items", []):
            out.append({
                "name": r["name"], "repo": r["full_name"], "url": r["html_url"],
                "stars": r.get("stargazers_count", 0), "pushed_at": r.get("pushed_at"),
                "description": (r.get("description") or "").strip(),
                "topics": r.get("topics", []), "archived": r.get("archived", False),
                "license": ((r.get("license") or {}).get("spdx_id") or ""),
                "source": f"repo-search:{topic}", "matched_query": query,
            })
    return out


def search_code(query):
    """Long tail: individual SKILL.md files inside larger repos. Needs auth."""
    if not GH:
        if "GitHub code search skipped: `gh` is not installed or not authenticated." not in WARNINGS:
            WARNINGS.append("GitHub code search skipped: `gh` is not installed or not authenticated.")
        return []
    try:
        r = subprocess.run(
            ["gh", "search", "code", f"{query} path:SKILL.md", "--limit", "15",
             "--json", "repository,path"],
            capture_output=True, text=True, timeout=TIMEOUT)
        hits = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
    except Exception:
        return []
    out = []
    for h in hits:
        full = h["repository"]["nameWithOwner"]
        out.append({
            "name": h["path"].rstrip("/SKILL.md").split("/")[-1] or full.split("/")[-1],
            "repo": full, "url": f"https://github.com/{full}/blob/HEAD/{h['path']}",
            "skill_path": h["path"], "stars": 0, "pushed_at": None,
            "description": (h["repository"].get("description") or "").strip(),
            "topics": [], "archived": False, "license": "",
            "source": "code-search", "matched_query": query,
        })
    return out


STOPWORDS = {"github", "com", "http", "https", "www", "skill", "skills", "claude",
             "code", "agent", "agents", "the", "and", "for", "with", "your", "use"}

# Words that are real but so common in this ecosystem that a match on one alone
# means nothing - every CRM connector is an "automation". They still count toward
# relevance; they just cannot be the sole reason a candidate makes the list.
GENERIC = {"automation", "automate", "integration", "integrations", "management",
           "platform", "workflow", "workflows", "tool", "tools", "api", "app",
           "apps", "service", "services", "data", "file", "files", "project"}


def discriminating(hits):
    """A hit list earns a place only if it is specific: two distinct terms, or
    one term that is not ecosystem boilerplate."""
    return len(set(hits)) >= 2 or any(h not in GENERIC for h in hits)


def term_hits(terms, text):
    """Match on word starts: 'action' should find 'actions', but not 'reactions'."""
    return [t for t in terms if re.search(r"\b" + re.escape(t), text)]


def terms_of(queries):
    """Query terms worth matching on: long enough, and not ecosystem boilerplate."""
    return {t.lower() for q in queries for t in re.split(r"\W+", q)
            if len(t) > 2 and t.lower() not in STOPWORDS}


LINK_RE = re.compile(r"\[([^\]\n]{2,80})\]\((https?://[^)\s]+|\./[^)\s]+)\)\s*[-–—:|]?\s*(.{0,180})")


def scan_index(repo, queries):
    """Pull a curated index README live and keep lines that match the queries.

    Human-curated one-liners describe what a skill is *for*, which repo
    metadata often does not - so these entries tend to rank well.
    """
    meta = gh_api(f"repos/{repo}") or {}
    branch = meta.get("default_branch", "main")
    body = fetch_text(f"https://raw.githubusercontent.com/{repo}/{branch}/README.md")
    if not body:
        return []
    terms = terms_of(queries)
    out = []
    for line in body.split("\n"):
        # URLs carry no topical meaning here and would match "github" on every row
        low = re.sub(r"https?://\S+", " ", line).lower()
        hits = term_hits(terms, low)
        if not discriminating(hits):
            continue
        m = LINK_RE.search(line)
        if not m:
            continue
        label, href, tail = m.group(1).strip(), m.group(2), m.group(3).strip(" -–—:|")
        if href.startswith("./"):
            href = f"https://github.com/{repo}/tree/{branch}/{href[2:]}"
        if "github.com" not in href:
            continue
        slug = re.sub(r"^https://github\.com/", "", href)
        base, _, sub = slug.partition("/tree/")
        if not sub:
            base, _, sub = slug.partition("/blob/")
        parts = base.split("/")
        sub = "/".join(sub.split("/")[1:]).strip("/")  # drop the branch segment
        clean = lambda t: re.sub(r"[*`_]{1,3}", "", t).strip(" -–—:|")
        out.append({
            "name": clean(label), "repo": "/".join(parts[:2]) if len(parts) >= 2 else base,
            "url": href, "skill_path": sub or None, "stars": 0, "pushed_at": None,
            "description": clean(tail)[:180], "topics": [], "archived": False, "license": "",
            "source": f"index:{repo}", "matched_query": " ".join(sorted(set(hits))),
        })
    return out


# ---------------------------------------------------------------- ranking

def score(c, queries):
    """Heuristic pre-ranking. It orders the shortlist; it does not pick winners.

    Only the agent, after reading a candidate's SKILL.md, can judge real fit -
    so these signals deliberately favour 'worth opening' over 'must install'.
    """
    owner = c["repo"].split("/")[0].lower()
    c["tier"] = (TIER_OFFICIAL if owner in OFFICIAL_OWNERS
                 else TIER_CURATED if c["source"].startswith("index:") else TIER_COMMUNITY)
    text = f"{c['name']} {c['description']} {' '.join(c.get('topics', []))}".lower()
    terms = terms_of(queries)
    relevance = sum(3 if term_hits([t], c["name"].lower()) else 1
                    for t in term_hits(terms, text))

    stars = c.get("stars") or 0
    adoption = min(stars, 20000) ** 0.35          # damped: stars are popularity, not fit
    age = months_since(c.get("pushed_at"))
    freshness = 6 if age < 2 else 3 if age < 6 else 0 if age < 14 else -6
    penalty = -20 if c.get("archived") else 0
    # A whole-repo hit is usually a bundle; a direct SKILL.md hit is the real unit.
    precision = 3 if c.get("skill_path") else 0

    c["score"] = round(relevance * 4 + adoption + freshness + penalty + precision + c["tier"] * 3, 1)
    c["signals"] = {
        "relevance": relevance, "stars": stars,
        "months_since_push": round(age, 1) if age < 99 else None,
        "tier": {3: "official", 2: "curated-index", 1: "community"}[c["tier"]],
        "archived": c.get("archived", False),
    }
    if c.get("stars_disclaimer"):
        c["signals"]["stars_note"] = c["stars_disclaimer"]
    return c


def enrich(candidates):
    """Index hits carry no repo metadata; fill it in so ranking is comparable."""
    need = {c["repo"] for c in candidates if not c.get("stars") and "/" in c["repo"]}
    meta = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(gh_api, f"repos/{r}"): r for r in list(need)[:25]}
        for f in as_completed(futs):
            try:
                d = f.result()
            except Exception:
                d = None
            if d and d.get("full_name"):
                meta[futs[f]] = d
    index_set = set(INDEX_REPOS)
    for c in candidates:
        d = meta.get(c["repo"])
        if d and c["repo"] in index_set and c.get("skill_path"):
            # Popularity belongs to the list, not to one entry inside it.
            c["stars"] = 0
            c["pushed_at"] = d.get("pushed_at")
            c["license"] = (d.get("license") or {}).get("spdx_id") or ""
            c["stars_disclaimer"] = f"listed inside {c['repo']}; stars not attributable"
            continue
        if d:
            c["stars"] = d.get("stargazers_count", 0)
            c["pushed_at"] = d.get("pushed_at")
            c["archived"] = d.get("archived", False)
            c["license"] = (d.get("license") or {}).get("spdx_id") or ""
            if not c["description"]:
                c["description"] = (d.get("description") or "").strip()
    return candidates


def dedupe(candidates):
    best = {}
    for c in candidates:
        key = (c["repo"].lower(), c.get("skill_path") or "")
        prev = best.get(key)
        if not prev or c["score"] > prev["score"]:
            if prev:
                c["source"] = f"{prev['source']}+{c['source']}"
            best[key] = c
        elif prev:
            prev["source"] = f"{prev['source']}+{c['source']}"
    for c in best.values():
        corroboration = len(set(c["source"].split("+")))
        if corroboration > 1:
            c["score"] = round(c["score"] + 4 * (corroboration - 1), 1)
            c["signals"]["corroborating_sources"] = corroboration
    return sorted(best.values(), key=lambda x: -x["score"])


def discover(queries, limit):
    jobs, results = [], []
    with ThreadPoolExecutor(max_workers=10) as pool:
        for q in queries:
            jobs.append(pool.submit(search_repos, q))
            jobs.append(pool.submit(search_code, q))
        for repo in INDEX_REPOS:
            jobs.append(pool.submit(scan_index, repo, queries))
        for f in as_completed(jobs):
            try:
                results.extend(f.result() or [])
            except Exception:
                pass
    results = enrich(results)
    scored = [score(c, queries) for c in results]
    terms = terms_of(queries)
    scored = [c for c in scored if discriminating(
        term_hits(terms, f"{c['name']} {c['description']} {' '.join(c.get('topics', []))}".lower()))]
    return dedupe(scored)[:limit]


# ---------------------------------------------------------------- inspect

RISK = [
    (r"curl[^\n|]*\|\s*(ba)?sh", "pipes a remote script straight into a shell"),
    (r"\brm\s+-rf\s+[~/$]", "destructive recursive delete against a real path"),
    (r"base64\s+(-d|--decode)", "decodes obfuscated payloads"),
    (r"(~/\.ssh|\.aws/credentials|\.env\b|id_rsa|\.netrc)", "touches credential material"),
    (r"(webhook|https?://[^\s\"']+)\s*[\"']?\s*(-d|--data|POST)", "posts data to a remote endpoint"),
    (r"ignore (all )?(previous|prior|above) instructions", "prompt-injection phrasing"),
    (r"(disregard|override) (your|the) (system|safety)", "attempts to override system instructions"),
    (r"[​-‏‪-‮⁠-⁤]", "hidden/bidirectional unicode"),
]


def inspect(repo, path=None):
    meta = gh_api(f"repos/{repo}") or {}
    branch = meta.get("default_branch", "main")
    paths = [path] if path else ["SKILL.md", "skills/SKILL.md", ".claude/skills/SKILL.md"]
    body, used = "", None
    for p in paths:
        body = fetch_text(f"https://raw.githubusercontent.com/{repo}/{branch}/{p}", cache=False)
        if body:
            used = p
            break
    if not body:
        tree = gh_api(f"repos/{repo}/git/trees/{branch}", {"recursive": "1"}) or {}
        for node in tree.get("tree", [])[:4000]:
            if node["path"].endswith("SKILL.md"):
                body = fetch_text(f"https://raw.githubusercontent.com/{repo}/{branch}/{node['path']}", cache=False)
                used = node["path"]
                break
    if not body:
        return {"repo": repo, "error": "no SKILL.md found"}

    fm = {}
    if body.startswith("---"):
        head = body.split("---", 2)[1] if body.count("---") >= 2 else ""
        for line in head.split("\n"):
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip().strip("|>").strip()
    flags = [reason for rx, reason in RISK if re.search(rx, body, re.I)]
    return {
        "repo": repo, "path": used, "stars": meta.get("stargazers_count", 0),
        "pushed_at": meta.get("pushed_at"), "archived": meta.get("archived", False),
        "license": (meta.get("license") or {}).get("spdx_id") or "none",
        "frontmatter": fm, "lines": body.count("\n") + 1,
        "risk_flags": flags,
        "has_scripts": bool(re.search(r"```(bash|sh|python)|scripts/", body)),
        "body": body[:12000],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", action="append", default=[], help="capability gap to search for (repeatable)")
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--inspect", metavar="OWNER/REPO")
    ap.add_argument("--path", help="explicit SKILL.md path for --inspect")
    ap.add_argument("--indexes", action="store_true")
    args = ap.parse_args()

    if args.inspect:
        print(json.dumps(inspect(args.inspect, args.path), indent=2))
        return
    if args.indexes:
        print(json.dumps({"indexes": INDEX_REPOS, "gh_authenticated": GH}, indent=2))
        return
    if not args.query:
        ap.error("need at least one --query")
    res = discover(args.query, args.limit)
    print(json.dumps({
        "gh_authenticated": GH,
        "code_search_available": GH,
        "queries": args.query,
        "count": len(res),
        "warnings": WARNINGS,
        "candidates": res,
    }, indent=2))


if __name__ == "__main__":
    main()
