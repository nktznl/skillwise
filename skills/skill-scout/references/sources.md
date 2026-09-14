# Discovery sources

Every channel below is queried live. `discover_skills.py` handles the first four;
the rest are worth reaching for by hand when the automated pass comes back thin.

## 1. GitHub repository search — the workhorse

Most skills ship as their own repo, tagged with an ecosystem topic.

```bash
gh search repos --topic=claude-skills --sort=stars --limit 20 \
  --json fullName,stargazersCount,pushedAt,description
gh search repos "terraform review" --topic=agent-skills --limit 15 --json fullName,description
```

Topics that carry real signal: `claude-skills`, `agent-skills`,
`claude-code-skills`, `claude-code-plugin`. Broader topics (`claude`, `ai-agents`)
mostly return blog-post repos and star-farming lists.

Works unauthenticated through `https://api.github.com/search/repositories`, at 10
searches/minute and 60 core calls/hour — enough for one report, not for looping.

## 2. GitHub code search — the long tail

Finds individual `SKILL.md` files buried inside larger repos, which repo search
never surfaces. **Requires an authenticated `gh`**; the unauthenticated endpoint
returns 401.

```bash
gh search code "kubernetes path:SKILL.md" --limit 15 --json repository,path
```

Indexing here is patchy and single keywords work better than phrases. Treat empty
results as "not indexed", not "does not exist".

## 3. Curated indexes — the best descriptions

Human-written one-liners that say what a skill is *for*, which repo metadata
rarely does. Resolve the default branch rather than assuming `main`; these repos
disagree about it.

- `anthropics/skills` — official, the quality baseline
- `travisvn/awesome-claude-skills`
- `ComposioHQ/awesome-claude-skills`
- `obra/superpowers` — large battle-tested bundle, ships its own marketplace.json

A candidate appearing in two independent indexes is meaningfully stronger than
one appearing in either alone; the script scores that corroboration.

## 4. Official set, enumerated directly

```bash
gh api repos/anthropics/skills/contents/skills --jq '.[].name'
```

Start here for anything document-, artifact- or API-shaped. It is the one source
where provenance needs no argument.

## 5. The user's own catalogs — lowest friction of all

When these tools exist in session, use them *before* reaching for third-party
repos. Anything here installs in a click and is already governed by the user's
org.

- `ListSkills` / `SearchSkills` — their enabled and available skills
- `ListPlugins` / `SearchPlugins` — their org plugin catalog
- `SuggestSkills` — renders an add-card for skills they do not yet have

## 6. Marketplaces already known to the machine

```bash
cat ~/.claude/plugins/config.json 2>/dev/null
find . -maxdepth 3 -name marketplace.json -not -path './node_modules/*'
```

A marketplace the user already trusts is a better source than a new one.

## 7. Web search — the fallback

When `gh` is missing, rate-limited, or the topic is too new to be tagged, search
the web for the capability plus "claude skill" or "agent skill". Verify anything
found this way against the GitHub API before recommending it: blog posts go stale
and frequently point at repos that have since been archived or renamed.

## Rate limits and failure modes

| Condition | What happens | What to do |
|---|---|---|
| `gh` absent or logged out | code search returns empty, repo search still works | say code search was unavailable; lean on indexes |
| 403 from the API | core limit exhausted (60/hr unauthenticated) | authenticate `gh`, or fall back to indexes and web search |
| An index README 404s | the repo renamed or changed branch | skip it; the script resolves branches and degrades quietly |
| Every source thin | the gap may be genuinely uncovered | report it as uncovered and offer `skill-creator` |

Never present a degraded search as a complete one. If a channel failed, the
report says which.
