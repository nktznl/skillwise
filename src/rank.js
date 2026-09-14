// Scoring.
//
// Fit decides the ordering; reputation only modulates it. Adding reputation to
// fit is what makes a famous spreadsheet skill outrank a purpose-built one on a
// security query: every skill inside a 176k-star repo inherits the same large
// constant. So fit multiplies here, and a skill with no topical evidence cannot
// be rescued by its pedigree.
import { termsOf, termHits, positiveText, GENERIC } from './terms.js'
import { OFFICIAL_OWNERS } from './github.js'

const TIER = { official: 3, curated: 2, community: 1 }
export const MIN_FIT = 5
// Crediting a skill with answering a gap is a stronger claim than listing it, so
// it needs stronger evidence: roughly a specific hit in the name, or several in
// the description. Below this a gap is reported as unanswered, which is more
// useful than filling the slot with something that merely shares a word.
export const GAP_FIT = 12

const monthsSince = (iso) => {
  if (!iso) return 99
  const d = new Date(iso)
  return Number.isNaN(+d) ? 99 : (Date.now() - d) / (1000 * 60 * 60 * 24 * 30.4)
}

export function score (skill, queries) {
  const owner = skill.repo.split('/')[0].toLowerCase()
  const tier = OFFICIAL_OWNERS.has(owner)
    ? TIER.official
    : skill.sources.some((s) => s.startsWith('index')) ? TIER.curated : TIER.community

  const terms = termsOf(queries)
  const nameL = skill.name.toLowerCase()
  const descL = positiveText(skill.description).toLowerCase()

  // The frontmatter description is the text that decides when a skill fires, so a
  // match there is evidence of fit - unlike a match in a repo blurb. Generic
  // words count for less wherever they appear.
  const weigh = (hits, w) =>
    [...new Set(hits)].reduce((n, h) => n + (GENERIC.has(h) ? w * 0.25 : w), 0)

  let fit = weigh(termHits(terms, nameL), 5)
    + weigh(termHits(terms, descL), 3)
    + weigh(termHits(terms, skill.skillPath.toLowerCase().replace(/\//g, ' ')), 1)

  // Only specific evidence counts as answering a gap. A spreadsheet skill
  // matching "file" and "data" has not addressed a security query.
  const specific = termHits(terms, `${nameL} ${descL}`).filter((h) => !GENERIC.has(h))
  const queriesMatched = queries.filter((q) =>
    termHits(termsOf([q]), `${nameL} ${descL}`).some((h) => !GENERIC.has(h))).length
  fit += 4 * Math.max(0, queriesMatched - 1)
  if (!specific.length) fit = 0

  // Installs count the skill; stars count whatever repo happens to host it, so
  // they are divided across the skills that repo ships.
  const perSkill = skill.stars ? skill.stars / Math.max(1, skill.repoSkillCount) : 0
  const adoption = skill.installs > 0
    ? Math.min(skill.installs, 200_000) ** 0.28
    : perSkill >= 1 ? Math.min(perSkill, 20_000) ** 0.35 : 0

  const age = monthsSince(skill.pushedAt)
  const freshness = age < 2 ? 6 : age < 6 ? 3 : age < 14 ? 0 : -6
  // A description written for the trigger system shows the author understood the
  // format; without one the skill may simply never fire when it should.
  const quality = skill.hasFrontmatterDescription ? 4 : -6
  const corroboration = 4 * (new Set(skill.sources).size - 1)
  const trust = adoption + freshness + quality + corroboration + tier * 3

  skill.fit = Math.round(fit * 10) / 10
  skill.trust = Math.round(trust * 10) / 10
  skill.score = Math.round((fit * (1 + Math.max(0, trust) / 30) + (skill.archived ? -1000 : 0)) * 10) / 10
  skill.signals = {
    fit: skill.fit,
    trust: skill.trust,
    queriesMatched,
    installs: skill.installs,
    stars: skill.stars,
    starsPerSkill: Math.round(perSkill),
    monthsSincePush: age < 99 ? Math.round(age * 10) / 10 : null,
    tier: tier === 3 ? 'official' : tier === 2 ? 'curated' : 'community',
    archived: skill.archived,
    corroboratingSources: new Set(skill.sources).size,
    hasFrontmatterDescription: skill.hasFrontmatterDescription,
    skillsInRepo: skill.repoSkillCount
  }
  return skill
}

/** Answer every gap, rather than the loudest one.
 *
 *  Pooling all queries and taking a global top-N lets whichever topic has the
 *  most skills win every slot: two security-flavoured gaps out of six will fill
 *  a six-slot report with security, leaving the missing test setup and the
 *  missing CI unanswered. A gap the user has and cannot see an answer to is the
 *  failure this tool exists to prevent, so each gap is ranked on its own and the
 *  slots are dealt out in rotation. Whatever is left over is filled globally.
 */
export function rankByGap (skills, queries, limit) {
  const perGap = queries.map((q) => ({
    query: q,
    hits: rank(skills, [q], limit).filter((s) => s.fit >= GAP_FIT)
  }))
  const taken = new Set()
  const out = []

  for (let round = 0; out.length < limit; round++) {
    let progressed = false
    for (const gap of perGap) {
      if (out.length >= limit) break
      const pick = gap.hits.find((s) => !taken.has(s))
      if (!pick) continue
      taken.add(pick)
      out.push({ ...pick, answersGap: gap.query })
      progressed = true
    }
    if (!progressed) break
  }

  // Any slots still free go to the strongest remaining candidates overall.
  if (out.length < limit) {
    for (const s of rank(skills, queries, limit * 2)) {
      if (out.length >= limit) break
      if (!taken.has(s)) { taken.add(s); out.push({ ...s, answersGap: null }) }
    }
  }

  const unanswered = perGap.filter((g) => !g.hits.length).map((g) => g.query)
  return { candidates: out.sort((a, b) => b.score - a.score), unanswered }
}

/** Within a repo the frontmatter name is a skill's identity, not its path:
 *  repos frequently ship the same skill at two paths (a plugin copy and a bare
 *  one) and listing it twice is noise. */
export function rank (skills, queries, limit) {
  const terms = termsOf(queries)
  const best = new Map()
  for (const s of skills) {
    const hay = `${s.name} ${positiveText(s.description)} ${s.skillPath}`
    const hits = termHits(terms, hay)
    if (new Set(hits).size < 2 && hits.every((h) => GENERIC.has(h))) continue
    const scored = score(s, queries)
    if (scored.fit < MIN_FIT || scored.archived) continue
    const key = `${s.repo.toLowerCase()}::${s.name.toLowerCase()}`
    if (!best.has(key) || scored.score > best.get(key).score) best.set(key, scored)
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
