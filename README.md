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
3. **Discover** — three phases, live:
   - *Candidates*: GitHub topic search by stars **and** by recency, code search
     for `SKILL.md`, and every repository the curated indexes link to.
   - *Resolve*: candidate repos are opened and their real `SKILL.md` files read.
     This is also the existence check — a repo tagged `claude-skills` with no
     `SKILL.md` is not a skill, and a repo with 84 of them is not one candidate.
   - *Rank*: each skill is scored on **its own frontmatter description**, the
     text that decides when it fires, not on the repo blurb.
4. **Vet** — each finalist's `SKILL.md` is fetched and read. Prompt-injection
   phrasing, remote-code-into-shell, unexplained credential access, outbound data
   flow and hidden unicode are grounds for rejection, not a caveat.
5. **Install** — on explicit approval only, pinned to a commit, with provenance
   recorded so the copy can be updated later.

### Two ideas that make the results different

**Repository search cannot see inside repositories.** It matches names,
descriptions and topics only. `python topic:agent-skills` returns ~2,900 repos and
none of them is `trailofbits/skills` — which ships a skill called `modern-python`
but describes itself as "Security skills for static analysis". So candidate repos
are opened and their file trees read, and every repo a curated index links to is
opened whether or not it matched the query.

**Fit multiplies reputation; it does not add to it.** If reputation were additive,
every skill inside a 176k-star repo would inherit the same large constant and a
spreadsheet skill would outrank a purpose-built one on a security query. Here a
skill with no topical evidence cannot be rescued by its pedigree, and stars are
divided by the number of skills the repo ships.

## Quality

`evals/` holds ground-truth cases measuring discovery quality, including
regression guards for defects found during development — a spreadsheet skill
matching a Python query through its *anti-trigger* clause, twelve CRM connectors
flooding a release query through the word "automation", and star inheritance
inside mega-repos.

```bash
python3 evals/run_eval.py
```

Reports hit rate, mean reciprocal rank, and forbidden-result violations against
the live ecosystem — deliberately not against a frozen fixture, since a discovery
tool that only passes on recorded data is not being tested on its actual job.

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
