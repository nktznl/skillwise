// Turning candidate repositories into the skills they actually ship.
//
// A repository is not the unit anyone installs - a skill is. Resolving is also
// the existence check: a repo tagged `claude-skills` with no SKILL.md is not a
// skill, and a repo with 84 of them is not one candidate.
//
// Listing a tree costs one request; reading a SKILL.md costs one per file. Skill
// directory names are meaningful (`plugins/modern-python/skills/...`), so paths
// are matched first and the read budget is spent where it can pay off.
import { repoMeta, skillPaths, raw, OFFICIAL_OWNERS } from './github.js'
import { termHits, GENERIC } from './terms.js'

const FM_KEY = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/

/** YAML subset as SKILL.md frontmatter actually uses it: flat keys, quoted
 *  scalars, and block scalars (`|`, `|-`, `>`). */
export function parseFrontmatter (body) {
  if (!body.startsWith('---')) return {}
  const end = body.indexOf('\n---', 3)
  if (end === -1) return {}
  const out = {}
  let key = null
  let buf = []
  const flush = () => { if (key) out[key] = buf.map((l) => l.trim()).filter(Boolean).join(' ').trim() }

  for (const line of body.slice(3, end).split('\n')) {
    if (/^[ \t]/.test(line) && key) { buf.push(line); continue }
    const m = FM_KEY.exec(line)
    if (!m) { if (key) buf.push(line); continue }
    flush()
    key = m[1].trim()
    const val = m[2].trim()
    buf = ['|', '|-', '|+', '>', '>-', ''].includes(val) ? [] : [val.replace(/^['"]|['"]$/g, '')]
  }
  flush()
  return out
}

async function readSkill (cand, branch, path, totalSkills) {
  const body = await raw(cand.repo, branch, path)
  if (!body) return null
  const fm = parseFrontmatter(body)
  const fallback = path.includes('/') ? path.split('/').at(-2) : cand.repo.split('/').at(-1)
  const name = (fm.name || fallback || '').trim()
  const description = (fm.description || '').trim()
  if (!name && !description) return null
  return {
    name,
    // The installer addresses a skill by its directory, not its display name:
    // frontmatter names contain spaces and capitals ("Stripe Payments").
    skillId: path.includes('/') ? path.split('/').at(-2) : name,
    repo: cand.repo,
    skillPath: path,
    url: `https://github.com/${cand.repo}/blob/${branch}/${path}`,
    description: description || cand.repoDescription,
    hasFrontmatterDescription: !!description,
    lines: body.split('\n').length,
    allowedTools: fm['allowed-tools'] ?? '',
    stars: cand.stars,
    installs: cand.installs ?? 0,
    pushedAt: cand.pushedAt,
    archived: cand.archived,
    license: cand.license,
    sources: [...cand.sources],
    repoSkillCount: totalSkills
  }
}

async function openRepo (cand, opts) {
  const meta = await repoMeta(cand.repo, opts)
  if (!meta?.full_name) return null
  const branch = meta.default_branch ?? 'main'
  Object.assign(cand, {
    stars: meta.stargazers_count ?? cand.stars,
    pushedAt: meta.pushed_at ?? cand.pushedAt,
    archived: meta.archived ?? cand.archived,
    license: meta.license?.spdx_id ?? cand.license,
    repoDescription: cand.repoDescription || (meta.description ?? '').trim()
  })
  const paths = await skillPaths(cand.repo, branch, opts)
  return paths.length && !cand.archived ? { cand, branch, paths } : null
}

export async function resolveAll (candidates, terms, { authenticated, density, warn } = {}) {
  const treeBudget = authenticated ? 80 : 8
  const bodyBudget = authenticated ? 110 : 25
  if (!authenticated) {
    warn?.(`Unauthenticated: coverage limited to ${treeBudget} repositories. Authenticate \`gh\` for full coverage.`)
  }

  const priority = (c) => {
    const text = `${c.repo} ${c.repoDescription} ${c.topics.join(' ')}`
    const srcs = [...c.sources]
    return termHits(terms, text).length * 5
      + Math.min(c.stars, 20000) ** 0.4
      + Math.min(c.installs ?? 0, 200000) ** 0.3
      + Math.min(density?.[c.repo] ?? 0, 60) * 0.5
      // Curated-index candidates arrive before their metadata is known, so they
      // would lose the race on stars alone despite being the most deliberately
      // vetted set available. There are only a few dozen: open all of them.
      + (srcs.some((s) => s.startsWith('index-shelf:')) ? 40 : 0)
      + (srcs.some((s) => s.startsWith('index:')) ? 12 : 0)
      + (srcs.includes('registry') ? 20 : 0)
      + (OFFICIAL_OWNERS.has(c.repo.split('/')[0].toLowerCase()) ? 12 : 0)
      + (c.hintPaths?.size ? 6 : 0)
  }

  const shortlist = [...candidates].sort((a, b) => priority(b) - priority(a)).slice(0, treeBudget)
  const trees = (await Promise.all(shortlist.map((c) => openRepo(c, { warn }).catch(() => null)))).filter(Boolean)
  for (const t of trees) if (density) density[t.cand.repo] = t.paths.length

  const targets = []
  for (const { cand, branch, paths } of trees) {
    const hints = [...(cand.hintPaths ?? [])].map((h) => h.replace(/^\/|\/$/g, '')).filter(Boolean)
    for (const p of paths) {
      const hay = p.toLowerCase().replace(/[/_-]/g, ' ')
      const specific = new Set(termHits(terms, hay).filter((h) => !GENERIC.has(h)))
      let weight = specific.size * 10
      if (hints.some((h) => p.includes(h))) weight += 15
      if (OFFICIAL_OWNERS.has(cand.repo.split('/')[0].toLowerCase())) weight += 6
      if (paths.length === 1) weight += 4
      targets.push({ weight, cand, branch, path: p, total: paths.length })
    }
  }
  targets.sort((a, b) => b.weight - a.weight)
  let chosen = targets.filter((t) => t.weight > 0).slice(0, bodyBudget)
  if (!chosen.length) chosen = targets.slice(0, Math.min(bodyBudget, 20))

  const skills = (await Promise.all(
    chosen.map((t) => readSkill(t.cand, t.branch, t.path, t.total).catch(() => null))
  )).filter(Boolean)

  return {
    skills,
    coverage: {
      reposFound: candidates.length,
      reposOpened: trees.length,
      skillsSeen: trees.reduce((n, t) => n + t.paths.length, 0),
      skillsRead: skills.length
    }
  }
}
