// Query-term handling shared by discovery and ranking.

// Words that appear in nearly every repo in this space and carry no signal.
const STOPWORDS = new Set(['github', 'com', 'http', 'https', 'www', 'skill', 'skills',
  'claude', 'code', 'agent', 'agents', 'the', 'and', 'for', 'with', 'your', 'use'])

// Real words, but so common here that a match on one alone means nothing - every
// CRM connector is an "automation". They count toward fit; they cannot carry a
// candidate on their own.
export const GENERIC = new Set(['automation', 'automate', 'integration', 'integrations',
  'management', 'platform', 'workflow', 'workflows', 'tool', 'tools', 'api', 'app',
  'apps', 'service', 'services', 'data', 'file', 'files', 'project'])

export function termsOf (queries) {
  const out = new Set()
  for (const q of queries) {
    for (const t of String(q).split(/\W+/)) {
      const low = t.toLowerCase()
      if (low.length > 2 && !STOPWORDS.has(low)) out.add(low)
    }
  }
  return out
}

/** Match on word starts: "action" should find "actions", but not "reactions". */
export function termHits (terms, text) {
  const hay = String(text).toLowerCase()
  return [...terms].filter((t) => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(hay))
}

export const discriminating = (hits) =>
  new Set(hits).size >= 2 || hits.some((h) => !GENERIC.has(h))

const NEGATIVE = /^\s*(do\s*n[o']?t|don'?t|never|skip|avoid|not\b)|(do not|don'?t|never)\s+(trigger|use|apply|invoke)|\bskip (only )?when\b|\bnot for\b|\bunless\b/i

/** Drop the anti-trigger half of a description before matching on it.
 *
 *  Good descriptions declare when *not* to fire - "Do NOT use for PDFs,
 *  spreadsheets, or coding unrelated to documents". Matching those clauses
 *  inverts the signal: a spreadsheet skill scores well on a Python query
 *  precisely because it says it is wrong for Python. */
export function positiveText (description) {
  const parts = String(description).split(/(?<=[.;])\s+|\n+/).filter((p) => !NEGATIVE.test(p))
  return parts.length ? parts.join(' ') : String(description)
}
