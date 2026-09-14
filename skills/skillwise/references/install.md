# Installing an approved skill

Only after the user names what they want. Approval of the report is not approval
to write files.

## The installer bridges the two conventions

`npx skills add` writes the skill to `.agents/skills/<name>/` - the cross-agent
location - and then symlinks `.claude/skills/<name>` to it, so Claude Code picks
it up without a second copy. Installs made before that bridging existed sit in
`.agents/skills/` alone and are invisible to Claude Code; if a skill is installed
but never fires, check for the missing symlink before assuming the skill is at
fault.

## Where skills live

| Target | Path | Use when |
|---|---|---|
| Personal | `~/.claude/skills/<name>/SKILL.md` | the user wants it everywhere |
| Project | `<repo>/.claude/skills/<name>/SKILL.md` | the team should get it too — commit it |
| Plugin | installed via a marketplace | the source ships `.claude-plugin/marketplace.json` |

Default to the project when the skill is stack-specific, personal when it is about
how this user likes to work. Ask if it is genuinely ambiguous.

## Route A — marketplace (preferred when offered)

If the source repo has `.claude-plugin/marketplace.json`, it is packaged. In an
interactive Claude Code session:

```
/plugin marketplace add owner/repo
/plugin install <plugin-name>@<marketplace-name>
```

Read the marketplace file first to get the real plugin and marketplace names —
they are frequently not the repo name:

```bash
gh api repos/owner/repo/contents/.claude-plugin/marketplace.json --jq '.content' \
  | base64 -d | python3 -m json.tool
```

Adding a marketplace is a standing trust decision, not a one-time download: later
updates arrive under the same grant. Say that out loud before the user agrees to
one.

## Route B — vendored copy (single skill, full control)

Pin to a commit rather than a branch. A branch can be edited upstream after you
vetted it, and the agent's instructions would change underneath the user.

```bash
SHA=$(gh api repos/OWNER/REPO/commits/HEAD --jq '.sha')
DEST=".claude/skills/NAME"
mkdir -p "$DEST"
gh api "repos/OWNER/REPO/tarball/$SHA" > /tmp/skill.tgz
tar -xzf /tmp/skill.tgz -C /tmp
cp -R /tmp/OWNER-REPO-*/PATH/TO/SKILL/. "$DEST/"
printf 'source: OWNER/REPO@%s\nvendored: %s\n' "$SHA" "$(date +%F)" > "$DEST/.provenance"
```

The `.provenance` file is what makes the copy updatable later — without it nobody
can tell where the directory came from or how far behind it is.

## After installing

1. `ls -la` the destination and show the user what landed.
2. Confirm the frontmatter `name` matches the directory name, or the skill will
   not resolve.
3. Say that skills are picked up on session start, so a restart may be needed.
4. If it went into the repo, mention that committing it shares it with the team —
   that is usually the point, but it should be a conscious choice.

## Updating and removing

```bash
# what is installed, and where each copy came from
find ~/.claude/skills .claude/skills -maxdepth 2 -name SKILL.md 2>/dev/null
cat .claude/skills/NAME/.provenance

# remove
rm -rf .claude/skills/NAME
```

Re-vet on update. A skill that was clean at the pinned commit is an unknown again
at a newer one, and "we already checked this repo" is exactly the assumption a
supply-chain problem relies on.
