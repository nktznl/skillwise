# Skill Scout

An Agent Skill that finds the Agent Skills your project is missing.

It profiles the repo you are actually in, searches the live ecosystem, reads each
candidate's `SKILL.md` before recommending it, and installs only what you approve.

Works with Claude Code, the Claude Agent SDK, and any agent that supports the
[Agent Skills](https://github.com/anthropics/skills) format.

## Install

```
/plugin marketplace add nktznl/suggest-skill
/plugin install skill-scout@skill-scout
```

Or vendor the skill directly:

```bash
git clone https://github.com/nktznl/suggest-skill /tmp/skill-scout
cp -R /tmp/skill-scout/skills/skill-scout ~/.claude/skills/
```

## Use

```
> which skills would help this project?
> /skill-scout
> find me a skill for terraform review
```

You get a short report — three to five recommendations, each tied to something
concrete in your codebase, each with provenance, a license, and a note on what was
actually checked — plus what was considered and skipped, and which gaps nothing
credible covers.

Nothing is written to disk until you name what you want.

## How it works

1. **Profile** — `profile_project.sh` reads languages, frameworks, test and CI
   setup, infra, data and cloud dependencies, and what skills are already
   installed. Under a second on a normal repo.
2. **Gaps** — friction is inferred from evidence (a web app with no tests, a
   payments integration with no security review, a monorepo with no navigation
   aids), then turned into search queries.
3. **Discover** — `discover_skills.py` queries GitHub repository search, GitHub
   code search for `SKILL.md` files, and the curated indexes, in parallel and
   live. Results are deduped and ranked on relevance, adoption, freshness,
   provenance tier, and agreement between independent sources.
4. **Vet** — each finalist's `SKILL.md` is fetched and read. Prompt-injection
   phrasing, remote-code-into-shell, unexplained credential access, outbound data
   flow and hidden unicode are grounds for rejection, not a caveat.
5. **Install** — on explicit approval only, pinned to a commit, with provenance
   recorded so the copy can be updated later.

## Why the vetting step is not optional

Installing a skill means adding a stranger's instructions to your agent's context.
A fetched `SKILL.md` is data *about* instructions — never a directive to follow —
and this skill treats it that way throughout. The realistic risk is not dramatic
malware; it is a plausible-looking file that quietly tells your agent to do
something you never asked for.

## Requirements

- `python3` and `bash` (both standard on macOS and Linux)
- Optional: [`gh`](https://cli.github.com), authenticated — unlocks GitHub code
  search and much higher rate limits. Without it, repository search and the
  curated indexes still work through the public API.

## Layout

```
.claude-plugin/marketplace.json
skills/skill-scout/
├── SKILL.md
├── scripts/
│   ├── profile_project.sh      project profiler
│   └── discover_skills.py      live search, ranking, and --inspect vetting
└── references/
    ├── sources.md              every channel, query recipes, rate limits
    ├── vetting.md              safety and quality checklist
    └── install.md              install routes, updating, removal
```

## License

MIT
