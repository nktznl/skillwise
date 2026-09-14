#!/usr/bin/env python3
"""Live discovery of Agent Skills across the public ecosystem.

Three phases, because the cheap signals and the truthful ones are different:

  1. CANDIDATES  cast a wide net over repositories - topic search, code search,
                 curated indexes. Fast, noisy, metadata-only.
  2. RESOLVE     open each candidate repo and read the SKILL.md files it really
                 contains. A repo tagged `claude-skills` with no SKILL.md is not
                 a skill, and a repo with 84 of them is not one candidate.
  3. RANK        score each resolved skill on its own frontmatter description -
                 the text that decides when it fires - not on the repo blurb,
                 which is marketing and is frequently absent.

Ranking on the real description is the whole point. A repo called
"awesome-dev-tools" can host exactly the skill you need, and a repo named
"playwright-skill" can be an empty shell.

Usage:
  discover_skills.py --query "playwright e2e" --query "terraform review"
  discover_skills.py --inspect owner/repo [--path skills/foo/SKILL.md]
  discover_skills.py --list-skills owner/repo
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

API = "https://api.github.com"
UA = {"User-Agent": "skill-scout", "Accept": "application/vnd.github+json"}
TIMEOUT = 20
CACHE_DIR = os.path.join(os.environ.get("TMPDIR", "/tmp"), "skill-scout-cache")
CACHE_TTL = 6 * 3600

TOPICS = ["claude-skills", "agent-skills", "claude-code-skills", "claude-code-plugin"]
TIER_OFFICIAL, TIER_CURATED, TIER_COMMUNITY = 3, 2, 1
OFFICIAL_OWNERS = {"anthropics", "anthropic-experimental"}
INDEX_REPOS = [
    "anthropics/skills",
    "travisvn/awesome-claude-skills",
    "ComposioHQ/awesome-claude-skills",
    "obra/superpowers",
]

# Words carrying no topical signal here: they appear in every repo in the space.
STOPWORDS = {"github", "com", "http", "https", "www", "skill", "skills", "claude",
             "code", "agent", "agents", "the", "and", "for", "with", "your", "use"}
# Real words, but so common that a match on one alone means nothing - every CRM
# connector is an "automation". They count toward relevance; they cannot carry a
# candidate on their own.
GENERIC = {"automation", "automate", "integration", "integrations", "management",
           "platform", "workflow", "workflows", "tool", "tools", "api", "app",
           "apps", "service", "services", "data", "file", "files", "project"}

WARNINGS = []          # a silently empty source looks identical to "nothing exists"
MAX_REPOS_RESOLVED = 30
MAX_SKILLS_PER_REPO = 12


def warn(msg):
    if msg not in WARNINGS:
        WARNINGS.append(msg)


def have_gh():
    try:
        return subprocess.run(["gh", "auth", "status"], capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


GH = have_gh()


def gh_api(path, params=None):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    if GH:
        try:
            r = subprocess.run(["gh", "api", path + qs], capture_output=True, text=True, timeout=TIMEOUT)
            if r.returncode == 0:
                return json.loads(r.stdout)
            err = (r.stderr or "") + (r.stdout or "")
            if "Validation Failed" in err or "422" in err:
                warn("GitHub rejected a search query (HTTP 422) - that channel "
                     "returned nothing for this run.")
                return None
            if "rate limit" in err.lower():
                warn("GitHub search rate limit reached (30/min). Some results are "
                     "missing from this run; wait a minute and re-run to see the rest.")
                return None
        except Exception:
            pass
    try:
        req = urllib.request.Request(API + "/" + path.lstrip("/") + qs, headers=UA)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as fh:
            return json.loads(fh.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 429):
            warn("GitHub API rate-limited or unauthorized (HTTP %d). Results are "
                 "incomplete - authenticate `gh` or retry later." % e.code)
        elif e.code != 404:
            warn("GitHub API returned HTTP %d for %s. That channel contributed "
                 "nothing to this run." % (e.code, path))
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


def term_hits(terms, text):
    """Match on word starts: 'action' should find 'actions', not 'reactions'."""
    return [t for t in terms if re.search(r"\b" + re.escape(t), text)]


def terms_of(queries):
    return {t.lower() for q in queries for t in re.split(r"\W+", q)
            if len(t) > 2 and t.lower() not in STOPWORDS}


NEGATIVE = re.compile(
    r"^\s*(do\s*n[o']?t|don'?t|never|skip|avoid|not\b)|"
    r"(do not|don'?t|never)\s+(trigger|use|apply|invoke)|"
    r"\bskip (only )?when\b|\bnot for\b|\bunless\b", re.I)


def positive_text(desc):
    """Drop the anti-trigger half of a description before matching on it.

    Good SKILL.md descriptions say when *not* to fire - "Do NOT use for PDFs,
    spreadsheets, or coding unrelated to documents". Matching those clauses
    inverts the signal: a spreadsheet skill scores well on a Python query
    precisely because it declares it is wrong for Python.
    """
    keep = [part for part in re.split(r"(?<=[.;])\s+|\n+", desc) if not NEGATIVE.search(part)]
    return " ".join(keep) if keep else desc


def discriminating(hits):
    return len(set(hits)) >= 2 or any(h not in GENERIC for h in hits)


# ------------------------------------------------------- phase 1: candidates

def search_repos(queries):
    """All query terms are OR-ed into one request per topic and sort order.

    GitHub allows 30 searches a minute; one call per query per topic per order
    blows through that on a normal five-gap run, and the overflow comes back
    empty rather than as an error - a silent loss of half the ecosystem.

    Two sort orders on purpose: `stars` finds what the ecosystem settled on,
    `updated` finds good work published last week that has no stars yet.
    """
    terms = sorted(terms_of(queries))[:12]
    if not terms:
        return []
    # GitHub rejects a query with more than five boolean operators (HTTP 422), so
    # terms go out in chunks of six. One call per chunk per topic per sort order
    # keeps a five-gap run at ~16 searches, comfortably inside the 30/min budget.
    chunks = [terms[i:i + 6] for i in range(0, len(terms), 6)]
    found = {}
    for chunk in chunks:
        query = "(" + " OR ".join(chunk) + ")" if len(chunk) > 1 else chunk[0]
        for topic in TOPICS:
            for order in ("stars", "updated"):
                data = gh_api("search/repositories", {
                    "q": f"{query} topic:{topic}", "sort": order, "order": "desc", "per_page": 15})
                for r in (data or {}).get("items", []):
                    found.setdefault(r["full_name"], {
                        "repo": r["full_name"],
                        "repo_description": (r.get("description") or "").strip(),
                        "stars": r.get("stargazers_count", 0), "pushed_at": r.get("pushed_at"),
                        "archived": r.get("archived", False), "topics": r.get("topics", []),
                        "license": ((r.get("license") or {}).get("spdx_id") or ""),
                        "sources": set(), "matched_queries": set(),
                    })
                    found[r["full_name"]]["sources"].add(f"repo-search:{topic}")
                    found[r["full_name"]]["matched_queries"].update(chunk)
    return list(found.values())


def search_code(query):
    """Long tail: SKILL.md files inside repos that carry no ecosystem topic."""
    if not GH:
        warn("GitHub code search skipped: `gh` is not installed or not authenticated.")
        return []
    try:
        r = subprocess.run(
            ["gh", "search", "code", f"{query} path:SKILL.md", "--limit", "20",
             "--json", "repository,path"],
            capture_output=True, text=True, timeout=TIMEOUT)
        hits = json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else []
    except Exception:
        return []
    found = {}
    for h in hits:
        full = h["repository"]["nameWithOwner"]
        e = found.setdefault(full, {
            "repo": full, "repo_description": (h["repository"].get("description") or "").strip(),
            "stars": 0, "pushed_at": None, "archived": False, "topics": [], "license": "",
            "sources": {"code-search"}, "matched_queries": {query}, "hint_paths": set(),
        })
        e["hint_paths"].add(h["path"])
    return list(found.values())


LINK_RE = re.compile(r"\[([^\]\n]{2,80})\]\((https?://[^)\s]+|\./[^)\s]+)\)\s*[-–—:|]?\s*(.{0,180})")


def scan_index(index_repo, queries):
    """Curated indexes point at repos with human-written context. We take the
    pointer and the provenance; the description still comes from the SKILL.md."""
    meta = gh_api(f"repos/{index_repo}") or {}
    branch = meta.get("default_branch", "main")
    body = fetch_text(f"https://raw.githubusercontent.com/{index_repo}/{branch}/README.md")
    if not body:
        return []
    terms = terms_of(queries)
    found = {}
    for line in body.split("\n"):
        low = re.sub(r"https?://\S+", " ", line).lower()   # URLs match "github" on every row
        hits = term_hits(terms, low)
        if not discriminating(hits):
            continue
        m = LINK_RE.search(line)
        if not m:
            continue
        href = m.group(2)
        if href.startswith("./"):
            href = f"https://github.com/{index_repo}/tree/{branch}/{href[2:]}"
        if "github.com" not in href:
            continue
        slug = re.sub(r"^https://github\.com/", "", href)
        base, _, sub = slug.partition("/tree/")
        if not sub:
            base, _, sub = slug.partition("/blob/")
        parts = base.split("/")
        if len(parts) < 2:
            continue
        repo = "/".join(parts[:2])
        sub = "/".join(sub.split("/")[1:]).strip("/")      # drop the branch segment
        e = found.setdefault(repo, {
            "repo": repo, "repo_description": "", "stars": 0, "pushed_at": None,
            "archived": False, "topics": [], "license": "",
            "sources": set(), "matched_queries": set(), "hint_paths": set(),
        })
        e["sources"].add(f"index:{index_repo}")
        e["matched_queries"].update(hits)
        if sub:
            e["hint_paths"].add(sub)
    return list(found.values())


REPO_LINK = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)")
NOT_A_REPO = ("sponsors", "topics", "features", "orgs", "apps", "settings", "marketplace")


def index_shelf(index_repo):
    """Every repository a curated index links to, regardless of the query.

    The indexes are small - a few dozen repos between them - and someone
    deliberately put each one there. Opening all of them costs little and is the
    only way a skill like `modern-python`, living in a repo described as
    "Security skills for static analysis", is ever reachable from a Python query.
    """
    meta = repo_meta(index_repo)
    branch = meta.get("default_branch", "main")
    body = fetch_text(f"https://raw.githubusercontent.com/{index_repo}/{branch}/README.md")
    if not body:
        return []
    out = []
    for slug in sorted({m for m in REPO_LINK.findall(body)}):
        owner, _, name = slug.partition("/")
        if owner.lower() in NOT_A_REPO or not name or slug == index_repo:
            continue
        out.append({
            "repo": slug, "repo_description": "", "stars": 0, "pushed_at": None,
            "archived": False, "topics": [], "license": "",
            "sources": {f"index-shelf:{index_repo}"},
            "matched_queries": set(), "hint_paths": set(),
        })
    return out


def ecosystem_shelf():
    """The repos that host skills, enumerated without any query terms.

    Repository search matches names, descriptions and topics - never the contents
    of subdirectories. So `python topic:agent-skills` cannot find `modern-python`
    inside a repo whose description reads "Security skills for static analysis",
    and no amount of query tuning fixes that. The way to find a skill inside a
    monorepo is to open the monorepo.

    This is query-independent and therefore cacheable: one build of the shelf
    serves every search for the next few hours.
    """
    found = {}
    for topic in TOPICS:
        for order in ("stars", "updated"):
            data = _cached_api(f"shelf_{topic}_{order}", "search/repositories",
                               {"q": f"topic:{topic}", "sort": order,
                                "order": "desc", "per_page": 30})
            for r in (data or {}).get("items", []):
                e = found.setdefault(r["full_name"], {
                    "repo": r["full_name"],
                    "repo_description": (r.get("description") or "").strip(),
                    "stars": r.get("stargazers_count", 0), "pushed_at": r.get("pushed_at"),
                    "archived": r.get("archived", False), "topics": r.get("topics", []),
                    "license": ((r.get("license") or {}).get("spdx_id") or ""),
                    "sources": set(), "matched_queries": set(), "hint_paths": set(),
                })
                e["sources"].add("shelf")
    return list(found.values())


def gather_candidates(queries):
    jobs, raw = [], []
    with ThreadPoolExecutor(max_workers=12) as pool:
        jobs.append(pool.submit(search_repos, queries))
        jobs.append(pool.submit(ecosystem_shelf))
        for q in queries[:5]:          # code search stays per-query: it is precision, not recall
            jobs.append(pool.submit(search_code, q))
        for idx in INDEX_REPOS:
            jobs.append(pool.submit(scan_index, idx, queries))
            jobs.append(pool.submit(index_shelf, idx))
        for f in as_completed(jobs):
            try:
                raw.extend(f.result() or [])
            except Exception:
                pass
    merged = {}
    for c in raw:
        m = merged.setdefault(c["repo"], c)
        if m is not c:
            m["sources"] |= c["sources"]
            m["matched_queries"] |= c["matched_queries"]
            m["hint_paths"] = m.get("hint_paths", set()) | c.get("hint_paths", set())
            m["stars"] = max(m["stars"], c["stars"])
            m["pushed_at"] = m["pushed_at"] or c["pushed_at"]
            m["repo_description"] = m["repo_description"] or c["repo_description"]
            m["license"] = m["license"] or c["license"]
            m["topics"] = m["topics"] or c["topics"]
    return list(merged.values())


# --------------------------------------------------------- phase 2: resolve

FM_KEY = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$")


def parse_frontmatter(body):
    """Small YAML-subset reader: flat keys, quoted scalars, and block scalars
    (`|`, `|-`, `>`), which is what SKILL.md frontmatter actually uses."""
    if not body.startswith("---"):
        return {}
    end = body.find("\n---", 3)
    if end == -1:
        return {}
    out, key, buf = {}, None, []

    def flush():
        if key:
            out[key] = " ".join(x.strip() for x in buf if x.strip()).strip()

    for line in body[3:end].split("\n"):
        if line[:1] in (" ", "\t") and key:
            buf.append(line)
            continue
        m = FM_KEY.match(line)
        if not m:
            if key:
                buf.append(line)
            continue
        flush()
        key, val = m.group(1).strip(), m.group(2).strip()
        buf = [] if val in ("|", "|-", "|+", ">", ">-", "") else [val.strip("'\"")]
    flush()
    return out


def _cached_api(cache_key, path, params=None):
    """Repo metadata and file trees change slowly but dominate the call budget:
    resolving 30 repos is 60 requests, and re-running a search minutes later
    would repeat every one of them."""
    key = os.path.join(CACHE_DIR, "api_" + re.sub(r"\W+", "_", cache_key)[-140:])
    if os.path.exists(key) and time.time() - os.path.getmtime(key) < CACHE_TTL:
        try:
            return json.load(open(key, encoding="utf-8"))
        except Exception:
            pass
    data = gh_api(path, params)
    if data is not None:
        os.makedirs(CACHE_DIR, exist_ok=True)
        try:
            json.dump(data, open(key, "w", encoding="utf-8"))
        except Exception:
            pass
    return data


DENSITY_FILE = os.path.join(CACHE_DIR, "density.json")


def load_density():
    """How many skills each repo was last seen to ship.

    Learned, not configured: a repo hosting 84 skills is a high-yield place to
    look regardless of what its description says, and that is exactly the kind of
    repo query-driven search cannot find. Populated as trees are read, so it
    improves with use.
    """
    try:
        return json.load(open(DENSITY_FILE, encoding="utf-8"))
    except Exception:
        return {}


def save_density(d):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        json.dump(d, open(DENSITY_FILE, "w", encoding="utf-8"))
    except Exception:
        pass


def repo_meta(repo):
    return _cached_api(f"meta_{repo}", f"repos/{repo}") or {}


def list_skill_paths(repo, branch):
    tree = _cached_api(f"tree_{repo}_{branch}", f"repos/{repo}/git/trees/{branch}",
                       {"recursive": "1"}) or {}
    if tree.get("truncated"):
        warn(f"{repo}: file tree truncated by the API; some skills may be missed.")
    return [n["path"] for n in tree.get("tree", []) if n["path"].endswith("SKILL.md")]


def repo_tree_paths(cand):
    """One cached call per repo, returning every SKILL.md it ships."""
    repo = cand["repo"]
    meta = repo_meta(repo)
    if not meta.get("full_name"):
        return cand, "main", []
    branch = meta.get("default_branch", "main")
    cand["stars"] = meta.get("stargazers_count", cand["stars"])
    cand["pushed_at"] = meta.get("pushed_at") or cand["pushed_at"]
    cand["archived"] = meta.get("archived", cand["archived"])
    cand["license"] = (meta.get("license") or {}).get("spdx_id") or cand["license"]
    cand["repo_description"] = cand["repo_description"] or (meta.get("description") or "").strip()
    return cand, branch, list_skill_paths(repo, branch)


def read_skill(cand, branch, path, total_skills):
    body = fetch_text(f"https://raw.githubusercontent.com/{cand['repo']}/{branch}/{path}")
    if not body:
        return None
    fm = parse_frontmatter(body)
    name = (fm.get("name") or (path.split("/")[-2] if "/" in path else cand["repo"].split("/")[-1])).strip()
    desc = (fm.get("description") or "").strip()
    if not name and not desc:
        return None
    return {
        "name": name, "repo": cand["repo"], "skill_path": path,
        "url": f"https://github.com/{cand['repo']}/blob/{branch}/{path}",
        "description": desc or cand["repo_description"],
        "has_frontmatter_description": bool(desc),
        "lines": body.count("\n") + 1,
        "allowed_tools": fm.get("allowed-tools", ""),
        "stars": cand["stars"], "pushed_at": cand["pushed_at"],
        "archived": cand["archived"], "license": cand["license"],
        "topics": cand["topics"], "sources": sorted(cand["sources"]),
        "repo_skill_count": total_skills,
    }


def resolve_all(candidates, terms):
    """Open many repos cheaply, then read only the files worth reading.

    Listing a repo's tree is one request; reading a SKILL.md is another per file.
    Skill directory names are meaningful (`plugins/modern-python/skills/...`), so
    matching query terms against paths first buys broad coverage at low cost and
    spends the fetch budget where it can pay off.
    """
    tree_budget = 80 if GH else 8
    body_budget = 110 if GH else 25
    density = load_density()
    if not GH:
        warn("Unauthenticated: coverage limited to %d repositories. Authenticate "
             "`gh` for full ecosystem coverage." % tree_budget)

    def repo_priority(c):
        text = f"{c['repo']} {c['repo_description']} {' '.join(c['topics'])}".lower()
        return (len(term_hits(terms, text)) * 5
                + min(c["stars"], 20000) ** 0.4
                + min(density.get(c["repo"], 0), 60) * 0.5
                + (12 if any(s.startswith("index:") for s in c["sources"]) else 0)
                + (40 if any(s.startswith("index-shelf:") for s in c["sources"]) else 0)
                + (12 if c["repo"].split("/")[0].lower() in OFFICIAL_OWNERS else 0)
                + (6 if c.get("hint_paths") else 0)
                + (4 if any(s.startswith("repo-search") for s in c["sources"]) else 0))

    shortlist = sorted(candidates, key=repo_priority, reverse=True)[:tree_budget]

    trees = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        for f in as_completed([pool.submit(repo_tree_paths, c) for c in shortlist]):
            try:
                cand, branch, paths = f.result()
            except Exception:
                continue
            density[cand["repo"]] = len(paths)
            if paths and not cand["archived"]:
                trees.append((cand, branch, paths))
    save_density(density)

    # Rank candidate files by the evidence in their path before spending a fetch.
    targets = []
    for cand, branch, paths in trees:
        hints = {h.strip("/") for h in cand.get("hint_paths", set()) if h}
        for p in paths:
            path_terms = p.lower().replace("/", " ").replace("-", " ").replace("_", " ")
            hits = term_hits(terms, path_terms)
            weight = len([h for h in set(hits) if h not in GENERIC]) * 10
            if hints and any(h in p for h in hints):
                weight += 15          # an index or code hit pointed straight here
            if cand["repo"].split("/")[0].lower() in OFFICIAL_OWNERS:
                weight += 6
            if len(paths) == 1:
                weight += 4           # a single-skill repo that matched at repo level
            targets.append((weight, cand, branch, p, len(paths)))

    targets.sort(key=lambda t: -t[0])
    chosen = [t for t in targets if t[0] > 0][:body_budget]
    if not chosen:
        chosen = targets[:min(body_budget, 20)]

    skills = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futs = [pool.submit(read_skill, cand, branch, p, total)
                for _, cand, branch, p, total in chosen]
        for f in as_completed(futs):
            try:
                r = f.result()
            except Exception:
                r = None
            if r:
                skills.append(r)
    return skills, len(candidates), len(trees), sum(len(t[2]) for t in trees)


# ------------------------------------------------------------ phase 3: rank

def score(s, queries):
    """Fit decides the ordering; reputation only modulates it.

    Adding reputation to fit is what makes a famous spreadsheet skill outrank a
    purpose-built one on a security query: every skill inside a 176k-star repo
    inherits the same large constant. So fit multiplies here, and a skill with no
    topical evidence cannot be rescued by its pedigree.
    """
    owner = s["repo"].split("/")[0].lower()
    tier = (TIER_OFFICIAL if owner in OFFICIAL_OWNERS
            else TIER_CURATED if any(x.startswith("index:") for x in s["sources"])
            else TIER_COMMUNITY)
    terms = terms_of(queries)
    name_l = s["name"].lower()
    desc_l = positive_text(s["description"]).lower()

    # The frontmatter description is the text that decides when a skill fires, so
    # a match there is evidence of fit - unlike a match in a repo blurb. Generic
    # words count for less wherever they appear.
    def weigh(hits, w):
        return sum(w if h not in GENERIC else w * 0.25 for h in set(hits))

    fit = (weigh(term_hits(terms, name_l), 5)
           + weigh(term_hits(terms, desc_l), 3)
           + weigh(term_hits(terms, s["skill_path"].lower().replace("/", " ")), 1))

    # Only specific evidence counts as answering a gap. A spreadsheet skill
    # matching "file" and "data" has not addressed a security query, and without
    # this rule those generic hits accumulate into a respectable-looking fit.
    specific = [h for h in term_hits(terms, f"{name_l} {desc_l}") if h not in GENERIC]
    queries_hit = sum(1 for q in queries
                      if [h for h in term_hits(terms_of([q]), f"{name_l} {desc_l}")
                          if h not in GENERIC])
    fit += 4 * max(0, queries_hit - 1)
    if not specific:
        fit = 0.0

    # Stars belong to the repository, not to each of the 84 skills inside it.
    per_skill = s["stars"] / max(1, s["repo_skill_count"]) if s["stars"] else 0
    adoption = min(per_skill, 20000) ** 0.35 if per_skill >= 1 else 0
    age = months_since(s["pushed_at"])
    freshness = 6 if age < 2 else 3 if age < 6 else 0 if age < 14 else -6
    # A description written for the trigger system shows the author understood the
    # format; without one the skill may simply never fire when it should.
    quality = 4 if s["has_frontmatter_description"] else -6
    corroboration = 4 * (len(set(s["sources"])) - 1)
    trust = adoption + freshness + quality + corroboration + tier * 3
    penalty = -1000 if s["archived"] else 0

    s["fit"] = round(fit, 1)
    s["trust"] = round(trust, 1)
    s["tier"] = tier
    s["score"] = round(fit * (1 + max(0.0, trust) / 30.0) + penalty, 1)
    s["signals"] = {
        "fit": s["fit"], "trust": s["trust"],
        "queries_matched": queries_hit,
        "stars": s["stars"], "stars_per_skill": round(per_skill),
        "months_since_push": round(age, 1) if age < 99 else None,
        "tier": {3: "official", 2: "curated-index", 1: "community"}[tier],
        "archived": s["archived"],
        "corroborating_sources": len(set(s["sources"])),
        "has_frontmatter_description": s["has_frontmatter_description"],
        "skills_in_repo": s["repo_skill_count"],
    }
    return s


def discover(queries, limit):
    terms = terms_of(queries)
    candidates = gather_candidates(queries)
    skills, n_cand, n_repos, n_paths = resolve_all(candidates, terms)

    MIN_FIT = 5.0   # one real name hit, or a couple of specific description hits
    ranked = []
    for s in skills:
        text = f"{s['name']} {s['description']} {s['skill_path']}".lower()
        if not discriminating(term_hits(terms, text)):
            continue
        scored = score(s, queries)
        if scored["fit"] < MIN_FIT or scored["archived"]:
            continue
        ranked.append(scored)

    # Repos frequently ship the same skill at two paths (a plugin copy and a bare
    # one). Within a repo the frontmatter name is the identity, not the path.
    best = {}
    for sk in ranked:
        key = (sk["repo"].lower(), sk["name"].lower())
        if key not in best or sk["score"] > best[key]["score"]:
            best[key] = sk
    out = sorted(best.values(), key=lambda x: -x["score"])

    return out[:limit], {
        "repos_found": n_cand, "repos_opened": n_repos,
        "skills_seen": n_paths, "skills_read": len(skills),
        "skills_relevant": len(ranked),
    }


# ---------------------------------------------------------- inspect / vetting

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
    meta = repo_meta(repo)
    branch = meta.get("default_branch", "main")
    paths = [path] if path else list_skill_paths(repo, branch)
    if not paths:
        return {"repo": repo, "error": "no SKILL.md found"}
    if not path and len(paths) > 1:
        return {"repo": repo, "error": "repository ships %d skills; re-run with --path" % len(paths),
                "skill_paths": paths}
    p = paths[0]
    body = fetch_text(f"https://raw.githubusercontent.com/{repo}/{branch}/{p}", cache=False)
    if not body:
        return {"repo": repo, "error": "could not read %s" % p}
    fm = parse_frontmatter(body)
    return {
        "repo": repo, "path": p, "stars": meta.get("stargazers_count", 0),
        "pushed_at": meta.get("pushed_at"), "archived": meta.get("archived", False),
        "license": (meta.get("license") or {}).get("spdx_id") or "none",
        "frontmatter": fm, "lines": body.count("\n") + 1,
        "allowed_tools": fm.get("allowed-tools", "unrestricted"),
        "risk_flags": [why for rx, why in RISK if re.search(rx, body, re.I)],
        "has_scripts": bool(re.search(r"```(bash|sh|python)|scripts/", body)),
        "body": body[:14000],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", action="append", default=[], help="capability gap (repeatable)")
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--inspect", metavar="OWNER/REPO")
    ap.add_argument("--path", help="explicit SKILL.md path for --inspect")
    ap.add_argument("--list-skills", metavar="OWNER/REPO")
    args = ap.parse_args()

    if args.list_skills:
        meta = repo_meta(args.list_skills)
        print(json.dumps({"repo": args.list_skills,
                          "skills": list_skill_paths(args.list_skills,
                                                     meta.get("default_branch", "main"))}, indent=2))
        return
    if args.inspect:
        print(json.dumps(inspect(args.inspect, args.path), indent=2))
        return
    if not args.query:
        ap.error("need at least one --query")

    res, coverage = discover(args.query, args.limit)
    print(json.dumps({
        "gh_authenticated": GH, "code_search_available": GH,
        "queries": args.query, "coverage": coverage,
        "warnings": WARNINGS, "count": len(res), "candidates": res,
    }, indent=2))


if __name__ == "__main__":
    main()
