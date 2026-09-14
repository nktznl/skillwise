// GitHub channels: repository search, code search, and the curated indexes.
//
// These exist alongside the registry because they cover different ground. The
// registry is curated and therefore lags; GitHub carries the long tail and
// anything published this week.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cached } from './cache.js'

const run = promisify(execFile)
const API = 'https://api.github.com'
const UA = { 'user-agent': 'skillwise', accept: 'application/vnd.github+json' }

export const TOPICS = ['claude-skills', 'agent-skills', 'claude-code-skills', 'claude-code-plugin']
export const OFFICIAL_OWNERS = new Set(['anthropics', 'anthropic-experimental'])
export const INDEX_REPOS = [
  'anthropics/skills',
  'travisvn/awesome-claude-skills',
  'ComposioHQ/awesome-claude-skills',
  'obra/superpowers'
]

let ghReady = null
export async function hasGh () {
  if (ghReady !== null) return ghReady
  try {
    await run('gh', ['auth', 'status'], { timeout: 10_000 })
    ghReady = true
  } catch { ghReady = false }
  return ghReady
}

export async function api (path, params, { warn } = {}) {
  const qs = params ? '?' + new URLSearchParams(params) : ''
  if (await hasGh()) {
    try {
      const { stdout } = await run('gh', ['api', path + qs], { timeout: 25_000, maxBuffer: 32 << 20 })
      return JSON.parse(stdout)
    } catch (err) {
      const text = `${err.stderr ?? ''}${err.stdout ?? ''}`
      // A rejected query returns nothing, which is indistinguishable from an
      // empty ecosystem unless we say so.
      if (/Validation Failed|422/.test(text)) {
        warn?.('GitHub rejected a search query (HTTP 422); that channel returned nothing this run.')
        return null
      }
      if (/rate limit/i.test(text)) {
        warn?.('GitHub search rate limit reached (30/min). Some results are missing; retry in a minute.')
        return null
      }
    }
  }
  try {
    const res = await fetch(API + '/' + path.replace(/^\//, '') + qs, { headers: UA })
    if (res.ok) return await res.json()
    if ([401, 403, 429].includes(res.status)) {
      warn?.(`GitHub API rate-limited or unauthorized (HTTP ${res.status}). Results are incomplete - authenticate \`gh\`.`)
    } else if (res.status !== 404) {
      warn?.(`GitHub API returned HTTP ${res.status} for ${path}; that channel contributed nothing.`)
    }
    return null
  } catch { return null }
}

export async function raw (repo, branch, path) {
  return cached(`raw:${repo}@${branch}:${path}`, undefined, async () => {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${path}`, { headers: UA })
      return res.ok ? await res.text() : ''
    } catch { return '' }
  })
}

export const repoMeta = (repo, opts) => cached(`meta:${repo}`, undefined, () => api(`repos/${repo}`, null, opts))

export async function skillPaths (repo, branch, opts) {
  const tree = await cached(`tree:${repo}@${branch}`, undefined,
    () => api(`repos/${repo}/git/trees/${branch}`, { recursive: '1' }, opts))
  if (tree?.truncated) opts?.warn?.(`${repo}: file tree truncated by the API; some skills may be missed.`)
  return (tree?.tree ?? []).filter((n) => n.path.endsWith('SKILL.md')).map((n) => n.path)
}

/** Repository search. Terms go out in chunks of six: GitHub rejects a query with
 *  more than five boolean operators, and one call per query per topic per sort
 *  order blows past the 30/min search budget on a normal run. */
export async function searchRepos (terms, opts) {
  const picked = [...terms].sort().slice(0, 12)
  if (!picked.length) return []
  const chunks = []
  for (let i = 0; i < picked.length; i += 6) chunks.push(picked.slice(i, i + 6))

  const found = new Map()
  const calls = []
  for (const chunk of chunks) {
    const q = chunk.length > 1 ? `(${chunk.join(' OR ')})` : chunk[0]
    for (const topic of TOPICS) {
      for (const sort of ['stars', 'updated']) {
        calls.push(api('search/repositories',
          { q: `${q} topic:${topic}`, sort, order: 'desc', per_page: '15' }, opts)
          .then((d) => ({ topic, items: d?.items ?? [] })))
      }
    }
  }
  for (const { topic, items } of await Promise.all(calls)) {
    for (const r of items) mergeRepo(found, r, `repo-search:${topic}`)
  }
  return [...found.values()]
}

/** The shelf: repos that host skills, enumerated without any query terms.
 *  Query-independent, therefore cacheable, and the only way a skill inside a
 *  monorepo whose description says something unrelated is ever reachable. */
export async function ecosystemShelf (opts) {
  const found = new Map()
  const calls = []
  for (const topic of TOPICS) {
    for (const sort of ['stars', 'updated']) {
      calls.push(cached(`shelf:${topic}:${sort}`, undefined,
        () => api('search/repositories', { q: `topic:${topic}`, sort, order: 'desc', per_page: '30' }, opts))
        .then((d) => d?.items ?? []))
    }
  }
  for (const items of await Promise.all(calls)) {
    for (const r of items) mergeRepo(found, r, 'shelf')
  }
  return [...found.values()]
}

const REPO_LINK = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g
const NOT_A_REPO = new Set(['sponsors', 'topics', 'features', 'orgs', 'apps', 'settings', 'marketplace'])

/** Every repository a curated index links to, regardless of the query. Between
 *  them the indexes name only a few dozen repos and someone deliberately put
 *  each one there, so opening all of them is cheap and high-yield. */
export async function indexShelf (indexRepo, opts) {
  const meta = await repoMeta(indexRepo, opts)
  const branch = meta?.default_branch ?? 'main'
  const body = await raw(indexRepo, branch, 'README.md')
  if (!body) return []
  const out = new Map()
  for (const [, slug] of body.matchAll(REPO_LINK)) {
    const [owner, name] = slug.split('/')
    if (!name || NOT_A_REPO.has(owner.toLowerCase()) || slug === indexRepo) continue
    if (!out.has(slug)) {
      out.set(slug, {
        repo: slug, repoDescription: '', stars: 0, pushedAt: null, archived: false,
        topics: [], license: '', sources: new Set([`index-shelf:${indexRepo}`]), hintPaths: new Set()
      })
    }
  }
  return [...out.values()]
}

function mergeRepo (map, r, source) {
  const e = map.get(r.full_name) ?? {
    repo: r.full_name,
    repoDescription: (r.description ?? '').trim(),
    stars: r.stargazers_count ?? 0,
    pushedAt: r.pushed_at ?? null,
    archived: !!r.archived,
    topics: r.topics ?? [],
    license: r.license?.spdx_id ?? '',
    sources: new Set(),
    hintPaths: new Set()
  }
  e.sources.add(source)
  map.set(r.full_name, e)
}
