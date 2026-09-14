// The skills.sh registry: the highest-recall channel available.
//
// It indexes skills that GitHub topic search cannot see - `supabase/agent-skills`
// carries 399k installs and topics `ai, skills, supabase`, none of which are the
// ecosystem topics a topic query filters on. It also resolves to the skill rather
// than the repository, and reports installs, which measures adoption of the skill
// itself rather than popularity of whatever repo happens to host it.
//
// What it does not return is descriptions, so ranking still has to read the real
// SKILL.md. This is a recall and adoption channel, not a ranking one.
const ENDPOINT = 'https://skills.sh/api/search'

export async function searchRegistry (query, { signal, warn } = {}) {
  let res
  try {
    res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
      signal, headers: { accept: 'application/json' }
    })
  } catch (err) {
    warn?.(`skills.sh registry unreachable (${err.message}). That channel contributed nothing.`)
    return []
  }
  if (!res.ok) {
    warn?.(`skills.sh registry returned HTTP ${res.status}. That channel contributed nothing.`)
    return []
  }

  let body
  try { body = await res.json() } catch { return [] }

  return (body.skills ?? []).flatMap((s) => {
    // ids look like `owner/repo/skill-id`; anything else we cannot resolve.
    const parts = String(s.id ?? '').split('/')
    if (parts.length < 3) return []
    const repo = parts.slice(0, 2).join('/')
    if (!s.source || !String(s.source).includes('/')) return []
    return [{
      repo,
      skillId: s.skillId ?? parts.at(-1),
      name: s.name ?? parts.at(-1),
      installs: Number(s.installs) || 0,
      source: 'registry',
      matchedQuery: query
    }]
  })
}
