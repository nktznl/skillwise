# skillwise

Finds the Agent Skills your project is missing, and audits them before you trust them.

```bash
npx skillwise
```

No install, no config. It reads the project you are standing in, works out what is
missing, searches the live ecosystem, and tells you what would help — then lets you
check each candidate before anything touches your machine.

Works with Claude Code, the Claude Agent SDK, and any agent that supports the
[Agent Skills](https://github.com/anthropics/skills) format.

## Two commands

```bash
npx skillwise                    # what should this project be using?
npx skillwise audit <owner/repo> --path <SKILL.md>   # is this safe to install?
```

`suggest` profiles the repo, derives the gaps, and answers **each gap separately**
rather than returning a global top-N — otherwise whichever topic has the most
skills wins every slot and the missing test setup goes unmentioned. Gaps nothing
credible covers are listed as unanswered, because "no good skill exists for this"
is a finding, not a failure.

`audit` reads the actual SKILL.md and reports provenance, tool permissions,
whether it ships executable scripts, and a pattern scan for the things that
matter: remote code piped into a shell, credential reads, outbound data,
prompt-injection phrasing, hidden unicode.

Install what you choose with the ecosystem installer:

```bash
npx skills add <owner/repo>
```

## Why the audit exists

Installing a skill means adding a stranger's instructions to an agent that has a
shell and your credentials. The realistic threat is not dramatic malware; it is a
plausible-looking SKILL.md that quietly tells your agent to do something you never
asked for.

So the scan is tuned to stay quiet. On a sample of twelve widely-used skills it
raises one medium flag and no high ones; on ten crafted malicious payloads it
catches all ten. A scanner that fires on everything gets ignored, and an ignored
scanner is worse than none.

It still only says where to look. A security scanner necessarily contains the
patterns it detects, and a formatting skill that reads `~/.ssh` is a problem no
regex can grade. The tool hands you the body and the link; the judgement is yours.

## How discovery works

Three phases, because the cheap signals and the truthful ones are different.

**Candidates.** The [skills.sh](https://www.skills.sh) registry, GitHub topic
search by stars *and* by recency, GitHub code search, and every repository the
curated indexes link to.

**Resolve.** Candidate repos are opened and the SKILL.md files they really contain
are read. This is also the existence check: a repo tagged `claude-skills` with no
SKILL.md is not a skill, and a repo with 84 of them is not one candidate.

**Rank.** Each skill is scored on its **own frontmatter description** — the text
that decides when it fires — not on the repo blurb, which is marketing and often
absent.

### Three things that make the results different

**Repository search cannot see inside repositories.** It matches names,
descriptions and topics only. `python topic:agent-skills` returns ~2,900 repos and
none of them is `trailofbits/skills`, which ships `modern-python` but describes
itself as "Security skills for static analysis". So repos get opened, and every
repo a curated index links to is opened whether or not it matched the query.

**The registry reaches what GitHub topics cannot.** `supabase/agent-skills` carries
~400k installs under the topics `ai, ai-agents, skills, supabase` — none of the
ecosystem topics a topic query filters on. Seven of the top eight results for
"supabase" are invisible to topic search. Its `installs` count also measures
adoption of the *skill*, where stars measure popularity of whatever repo hosts it.

**Fit multiplies reputation; it does not add to it.** If reputation were additive,
every skill inside a 176k-star repo would inherit the same large constant and a
spreadsheet skill would outrank a purpose-built one on a security query. Here a
skill with no topical evidence cannot be rescued by its pedigree, and stars are
divided across the skills a repo ships.

## As a skill

The CLI does the search; the skill teaches your agent to run it and do the
judgement — reading bodies, discarding what the user already has, writing the
report, installing only what is approved.

```
/plugin marketplace add nktznl/skillwise
/plugin install skillwise@skillwise
```

Or `npx skills add nktznl/skillwise`.

## Quality

`evals/` holds ground-truth cases, including regression guards for defects found
during development: a spreadsheet skill matching a Python query through its
*anti-trigger* clause, twelve CRM connectors flooding a release query through the
word "automation", star inheritance inside mega-repos, and a docs link to
`postgresql.org` scored as data exfiltration because a URL sat near the letters
"post".

```bash
npm run eval
```

Reports hit rate, mean reciprocal rank, forbidden-result violations, and per-gap
balance against the live ecosystem — deliberately not against a frozen fixture,
since a discovery tool that only passes on recorded data is not being tested on
its actual job.

## Requirements

Node 18.17+. An authenticated [`gh`](https://cli.github.com) unlocks GitHub code
search and much higher rate limits; without it the registry and repository search
still work, and the report says which channels were unavailable rather than
presenting a degraded search as a complete one.

## License

MIT
