// Orchestration: gather candidates from every channel, resolve them into real
// skills, rank what came back.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { searchRegistry } from './registry.js'
import { searchRepos, ecosystemShelf, indexShelf, hasGh, INDEX_REPOS } from './github.js'
import { resolveAll } from './resolve.js'
import { rankByGap } from './rank.js'
import { termsOf } from './terms.js'
import { cacheDir } from './cache.js'

const DENSITY = join(cacheDir, 'density.json')

/** How many skills each repo was last seen to ship. Learned, not configured: a
 *  repo hosting 84 skills is a high-yield place to look regardless of what its
 *  description says, and that is exactly the kind of repo query-driven search
 *  cannot find. */
async function loadDensity () {
  try { return JSON.parse(await readFile(DENSITY, 'utf8')) } catch { return {} }
}
async function saveDensity (d) {
  try { await mkdir(cacheDir, { recursive: true }); await writeFile(DENSITY, JSON.stringify(d)) } catch {}
}

function mergeInto (map, entry) {
  const cur = map.get(entry.repo)
  if (!cur) { map.set(entry.repo, entry); return }
  for (const s of entry.sources) cur.sources.add(s)
  for (const h of entry.hintPaths ?? []) cur.hintPaths.add(h)
  cur.stars = Math.max(cur.stars, entry.stars ?? 0)
  cur.installs = Math.max(cur.installs ?? 0, entry.installs ?? 0)
  cur.pushedAt ||= entry.pushedAt
  cur.repoDescription ||= entry.repoDescription
  cur.license ||= entry.license
  if (!cur.topics?.length) cur.topics = entry.topics ?? []
}

export async function discover (queries, { limit = 12, warnings = [] } = {}) {
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m) }
  const terms = termsOf(queries)
  const authenticated = await hasGh()

  const channels = [
    ...queries.map((q) => searchRegistry(q, { warn })),
    searchRepos(terms, { warn }),
    ecosystemShelf({ warn }),
    ...INDEX_REPOS.map((r) => indexShelf(r, { warn }))
  ]
  const results = await Promise.all(channels.map((p) => p.catch(() => [])))

  const candidates = new Map()
  for (const batch of results) {
    for (const item of batch) {
      // Registry hits name a skill inside a repo; keep the skill id as a hint so
      // resolution looks in the right place instead of scanning the whole tree.
      if (item.source === 'registry') {
        mergeInto(candidates, {
          repo: item.repo, repoDescription: '', stars: 0, installs: item.installs,
          pushedAt: null, archived: false, topics: [], license: '',
          sources: new Set(['registry']), hintPaths: new Set([item.skillId])
        })
      } else {
        mergeInto(candidates, { installs: 0, ...item })
      }
    }
  }

  const density = await loadDensity()
  const { skills, coverage } = await resolveAll([...candidates.values()], terms,
    { authenticated, density, warn })
  await saveDensity(density)

  const ranked = rankByGap(skills, queries, limit)
  return {
    authenticated,
    queries,
    coverage: { ...coverage, skillsRelevant: ranked.candidates.length },
    warnings,
    unanswered: ranked.unanswered,
    candidates: ranked.candidates
  }
}

export { auditSkill } from './audit.js'
export { profileProject } from './profile.js'
