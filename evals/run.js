#!/usr/bin/env node
// Measures discovery quality against evals/cases.json, live.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { discover } from '../src/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const matches = (c, w) => (!w.repo || c.repo.toLowerCase() === w.repo.toLowerCase()) &&
  c.name.toLowerCase() === w.name.toLowerCase()

const spec = JSON.parse(await readFile(join(HERE, 'cases.json'), 'utf8'))
const only = process.argv[2]
const cases = spec.cases.filter((c) => !only || c.id === only)
const rows = []

for (const c of cases) {
  const t0 = Date.now()
  const res = await discover(c.queries, { limit: Math.max(spec.k, 10) })
  const topK = res.candidates.slice(0, spec.k)
  const ranks = topK.flatMap((cand, i) => c.expect.some((w) => matches(cand, w)) ? [i + 1] : [])
  const violations = res.candidates.slice(0, 10)
    .filter((cand) => c.forbid.some((w) => matches(cand, w)))
    .map((cand) => `${cand.name} (${cand.repo})`)

  const hit = ranks.length > 0 || c.expect.length === 0
  const clean = violations.length === 0
  rows.push({ id: c.id, hit, clean, rank: ranks[0] ?? null, mrr: ranks.length ? 1 / ranks[0] : 0, scored: c.expect.length > 0 })

  const detail = ranks.length ? `rank ${ranks[0]}` : c.expect.length ? 'MISS' : 'no expectation'
  console.log(`${hit && clean ? 'PASS' : 'FAIL'}  ${c.id.padEnd(17)} ${detail.padEnd(15)} ${String((Date.now() - t0) / 1000).padStart(5)}s  ` +
    `${String(res.coverage.reposFound).padStart(4)} repos -> ${String(res.coverage.skillsRead).padStart(4)} read`)
  if (violations.length) console.log(`      forbidden in top 10: ${violations.join(', ')}`)
  if (!ranks.length && c.expect.length) console.log('      top: ' + topK.map((s) => `${s.name}(${s.score})`).join(', '))
}

// Per-gap balance: a report that answers one loud topic and ignores the rest is
// the failure mode this tool is built to avoid, so it is measured, not assumed.
if (!only) {
  const b = spec.balance
  const res = await discover(b.queries, { limit: b.queries.length + 2 })
  const answered = new Set(res.candidates.map((c) => c.answersGap).filter(Boolean))
  const ok = answered.size + res.unanswered.length >= b.minGapsAnswered
  rows.push({ id: 'gap-balance', hit: ok, clean: true, mrr: 0, scored: false })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'gap-balance'.padEnd(17)} ${answered.size} answered, ${res.unanswered.length} declared unanswered of ${b.queries.length}`)
}

const passed = rows.filter((r) => r.hit && r.clean).length
const scored = rows.filter((r) => r.scored)
console.log('\n' + '-'.repeat(62))
console.log(`pass ${passed}/${rows.length}   MRR ${(scored.reduce((n, r) => n + r.mrr, 0) / scored.length).toFixed(3)}   ` +
  `clean ${rows.filter((r) => r.clean).length}/${rows.length}`)
process.exit(passed === rows.length ? 0 : 1)
