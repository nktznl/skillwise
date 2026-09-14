#!/usr/bin/env node
import { profileProject, deriveQueries } from '../src/profile.js'
import { discover } from '../src/index.js'
import { auditSkill } from '../src/audit.js'
import { checkbox, select, confirm, interactive } from '../src/prompt.js'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// npx resolves `latest` on every run, so a stale copy is rare - but when someone
// reports odd behaviour, the first question is always which version they ran.
const { version: VERSION } = createRequire(import.meta.url)('../package.json')

import { bold, dim, red, green, yellow, blue, cyan, magenta, wrap, truncate, rule, width, progress } from '../src/ui.js'

const HELP = `
${bold('skillwise')} ${dim('v' + VERSION)} - find the Agent Skills your project is missing, and audit them before you trust them

${bold('Usage')}
  npx skillwise [suggest]              profile this project and recommend skills
  npx skillwise audit <owner/repo>     read a skill and report what it does and risks
  npx skillwise profile                show what this project looks like

${bold('Options')}
  -q, --query <text>    search for this instead of the derived gaps (repeatable)
  -l, --limit <n>       how many candidates to return (default: one per gap, plus two)
  -p, --path <path>     which SKILL.md to audit, in a repo that ships several
  -C, --cwd <dir>       project directory to profile (default: current)
      --json            machine-readable output
      --no-install      just print the report, never offer to install
  -h, --help            this text
  -v, --version         print the version and exit

${bold('Notes')}
  An authenticated ${cyan('gh')} unlocks GitHub code search and much higher rate limits.
  Without it the registry and repository search still work, and the report says so.
`

function parseArgs (argv) {
  const opts = { queries: [], limit: null, json: false, cwd: process.cwd() }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-q' || a === '--query') opts.queries.push(argv[++i])
    else if (a === '-l' || a === '--limit') opts.limit = Number(argv[++i]) || null
    else if (a === '-p' || a === '--path') opts.path = argv[++i]
    else if (a === '-C' || a === '--cwd') opts.cwd = argv[++i]
    else if (a === '--json') opts.json = true
    else if (a === '--no-install') opts.noInstall = true
    else if (a === '-h' || a === '--help') opts.help = true
    else if (a === '-v' || a === '--version') opts.version = true
    else rest.push(a)
  }
  return { opts, rest }
}

const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`

function printProfile (p) {
  const facts = [p.languages.slice(0, 4).join(', '), p.frameworks.join(', '),
    p.data.join(', '), p.cloud.join(', '), p.infra.join(', '), p.aiMl.join(', ')]
    .filter(Boolean).join(' \u00b7 ')

  const missing = []
  if (!p.signals.hasTests) missing.push('no tests')
  if (!p.signals.hasCi) missing.push('no CI')
  if (!p.agentSetup.claudeMd && !p.agentSetup.agentsMd) missing.push('no agent context file')
  if (p.signals.isMonorepo) missing.push('monorepo')

  console.log('\n' + rule(bold(p.root.replace(process.env.HOME ?? '~~', '~'))))
  if (facts) console.log('  ' + wrap(facts, 2))
  console.log(dim(`  ${p.fileCount} files`) + (missing.length ? dim(' \u00b7 ') + yellow(missing.join(' \u00b7 ')) : ''))
  if (p.existingSkills.length) {
    console.log(dim('  already installed: ' + truncate(p.existingSkills.join(', '), width() - 22)))
  }
}

function adoptionOf (g) {
  if (g.installs > 0) return `${g.installs.toLocaleString()} installs`
  if (!g.stars) return 'no adoption data'
  const k = g.stars >= 1000 ? `${Math.round(g.stars / 1000)}k` : String(g.stars)
  return g.skillsInRepo > 1 ? `${k}\u2605 across ${g.skillsInRepo} skills` : `${k}\u2605`
}

function printCandidate (s, index, installed, showCommands) {
  const g = s.signals
  const tier = g.tier === 'official' ? green('official') : g.tier === 'curated' ? blue('curated') : dim('community')
  const age = g.monthsSincePush == null
    ? 'age unknown'
    : g.monthsSincePush < 1 ? 'updated this month' : `updated ${Math.round(g.monthsSincePush)}mo ago`
  const dup = installed.has(s.name) ? '  ' + yellow('already installed') : ''

  console.log(`\n ${dim(String(index).padStart(2))}  ${bold(s.name)}  ${tier}${dup}`)
  console.log('     ' + wrap(truncate(s.description, 340), 5))
  console.log(dim(`     ${s.repo} \u00b7 ${adoptionOf(g)} \u00b7 ${age} \u00b7 ${s.license || 'no license'}`))
  if (showCommands) console.log(dim(`     npx skillwise audit ${s.repo} --path ${s.skillPath}`))
}

/** Group results under the gap each one answers.
 *
 *  These are not search results, they are answers to specific things this
 *  project lacks - and a flat list buries that, which is the only argument the
 *  report actually makes. */
function printResults (result, installed, showCommands) {
  const cov = result.coverage
  console.log('\n' + rule(bold('Recommended')))
  console.log(dim(`  searched ${cov.reposFound.toLocaleString()} repositories \u00b7 ` +
    `indexed ${cov.skillsSeen.toLocaleString()} skills \u00b7 read ${cov.skillsRead}`) +
    (result.authenticated ? '' : yellow('  \u00b7 gh not authenticated, coverage reduced')))

  const byGap = new Map()
  for (const c of result.candidates) byGap.set(c.answersGap ?? null, [...(byGap.get(c.answersGap ?? null) ?? []), c])

  let n = 0
  for (const [gap, items] of byGap) {
    console.log('\n  ' + (gap ? magenta('\u25b8 ') + gap : dim('\u25b8 also worth knowing about')))
    for (const c of items) printCandidate(c, ++n, installed, showCommands)
  }

  if (result.unanswered?.length || result.squeezed?.length) {
    console.log('\n' + rule(bold('Not covered')))
    for (const q of result.unanswered ?? []) {
      console.log(`  ${yellow('\u25b8')} ${q}  ${dim('nothing credible found')}`)
    }
    for (const q of result.squeezed ?? []) {
      console.log(`  ${yellow('\u25b8')} ${q}  ${dim('candidates exist, cut by --limit')}`)
    }
  }
  for (const w of result.warnings) console.log('\n' + yellow('!') + '  ' + wrap(w, 3))
}

async function cmdSuggest (opts) {
  const profile = await profileProject(opts.cwd)
  const derived = deriveQueries(profile)
  const queries = opts.queries.length ? opts.queries : derived.map((g) => g.query)
  // Default to covering every gap: a fixed limit silently drops the last ones,
  // and an unanswered gap the user cannot see is the failure mode here.
  const limit = opts.limit ?? queries.length + 2
  if (!queries.length) {
    console.error('Nothing to search for: this directory looks empty. Pass --query to search anyway.')
    process.exit(1)
  }

  if (opts.json) {
    const result = await discover(queries, { limit })
    console.log(JSON.stringify({ profile, derivedQueries: derived, ...result }, null, 2))
    return
  }

  console.log(bold('\nskillwise ') + dim('v' + VERSION))
  printProfile(profile)
  console.log('\n' + rule(bold('Looking for')))
  const gaps = opts.queries.length ? queries.map((q) => ({ query: q, why: 'you asked' })) : derived
  for (const g of gaps) console.log(`  ${magenta('\u25b8')} ${g.query}  ${dim(`(${g.why})`)}`)

  // Ten seconds of silence reads as a hang, so the spinner reports the phase.
  const spin = progress()
  spin.start('searching the live ecosystem')
  let result
  try {
    result = await discover(queries, { limit, onProgress: (m) => spin.update(m) })
  } finally {
    spin.stop()
  }

  const installed = new Set(profile.existingSkills)
  const canInstall = interactive() && !opts.noInstall && result.candidates.length > 0
  printResults(result, installed, !canInstall)

  if (canInstall) await offerInstall(result.candidates, installed)
  else if (result.candidates.length) {
    console.log(dim('\n  Nothing here is vetted yet. A SKILL.md is instructions for your agent,'))
    console.log(dim('  and the only thing that makes one safe is reading it.\n'))
  }
}

const run = (cmd, args) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: 'inherit' })
  child.on('close', (code) => resolve(code === 0))
  child.on('error', () => resolve(false))
})

/** Select, audit, then install - in that order.
 *
 *  A checkbox that installs on the next keypress would undercut the one thing
 *  this tool insists on: nobody should add a stranger's instructions to their
 *  agent without seeing what they say. So the selection is the question, and the
 *  audit is what makes the answer informed.
 */
async function offerInstall (candidates, installed) {
  const selectable = candidates.filter((s) => !installed.has(s.name))
  if (!selectable.length) return

  const picked = await checkbox(bold('\nWhich of these should be audited and installed?'), selectable, {
    render: (s) => `${bold(s.name)} ${dim(s.repo)}\n${dim(truncate(s.description, width() - 6))}`
  })
  if (!picked?.length) { console.log(dim('\nNothing selected.')); return }

  console.log(dim(`\nReading ${picked.length} SKILL.md ${picked.length === 1 ? 'file' : 'files'} before anything is installed…`))
  const audits = await Promise.all(picked.map((s) =>
    auditSkill(s.repo, s.skillPath).then((a) => ({ s, a })).catch(() => ({ s, a: { error: 'unreadable' } }))))

  let blocking = 0
  for (const { s, a } of audits) {
    if (a.error) { console.log(`\n  ${red('?')} ${bold(s.name)} - could not read it: ${a.error}`); blocking++; continue }
    const high = a.riskFlags.filter((f) => f.severity === 'high')
    const mark = high.length ? red('!') : a.riskFlags.length ? yellow('?') : green('ok')
    console.log(`\n  ${mark} ${bold(s.name)}  ${dim(`${a.lines} lines · ${a.license} · tools: ${a.allowedTools}`)}`)
    for (const f of a.riskFlags) console.log(`      ${f.severity === 'high' ? red(f.why) : yellow(f.why)}`)
    if (a.riskFlags.length) console.log(dim(`      read it: ${a.url}`))
    if (high.length) blocking++
  }

  if (blocking) {
    console.log(yellow(`\n${blocking} of ${picked.length} raised something worth reading first.`))
    console.log(dim('A scanner cannot tell an exfiltration from a security skill describing one.'))
    if (!await confirm(red('Install anyway?'))) { console.log(dim('Nothing installed.')); return }
  }

  const scope = await select(bold('\nWhere should these go?'), [
    { label: 'This project', value: 'project', hint: 'only sessions in this repo' },
    { label: 'Globally', value: 'global', hint: 'every project on this machine' }
  ])
  if (!scope) { console.log(dim('Nothing installed.')); return }

  // One call per repo: several selected skills can share a source.
  const byRepo = new Map()
  for (const s of picked) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s.skillId])

  let ok = 0
  for (const [repo, names] of byRepo) {
    const args = ['-y', 'skills@latest', 'add', repo, '--skill', names.join(','), '-y',
      ...(scope === 'global' ? ['-g'] : [])]
    console.log(dim(`\n$ npx ${args.join(' ')}`))
    if (await run('npx', args)) ok += names.length
  }
  console.log(ok === picked.length
    ? green(`\n${plural(ok, 'skill')} installed.`)
    : yellow(`\n${ok} of ${picked.length} installed; see the output above.`))
}

async function cmdAudit (target, opts) {
  if (!target || !target.includes('/')) {
    console.error('Usage: npx skillwise audit <owner/repo> [--path <SKILL.md>]')
    process.exit(1)
  }
  const r = await auditSkill(target, opts.path)
  if (opts.json) { console.log(JSON.stringify(r, null, 2)); return }

  if (r.error) {
    console.error(`\n${red('cannot audit')}: ${r.error}`)
    if (r.skillPaths) {
      console.error(dim('\nAvailable skills (pick one with --path):'))
      for (const p of r.skillPaths.slice(0, 40)) console.error(`  ${p}`)
      if (r.skillPaths.length > 40) console.error(dim(`  … and ${r.skillPaths.length - 40} more`))
    }
    process.exit(1)
  }

  console.log(bold(`\n${r.frontmatter.name ?? r.path}`) + dim(`  ${r.repo}`))
  console.log(`  ${(r.frontmatter.description ?? '(no description)').replace(/\s+/g, ' ').slice(0, 240)}`)
  console.log(bold('\nProvenance'))
  console.log(`  ${r.stars.toLocaleString()}★ · ${r.license} · ${r.lines} lines · updated ${r.pushedAt?.slice(0, 10) ?? 'unknown'}`)
  console.log(`  tools: ${r.allowedTools === 'unrestricted' ? yellow('unrestricted') : r.allowedTools}`)
  console.log(`  ships executable scripts: ${r.hasScripts ? yellow('yes') : 'no'}`)
  if (r.archived) console.log(red('  repository is ARCHIVED - nobody will fix it'))

  console.log(bold('\nPattern scan'))
  if (!r.riskFlags.length) console.log(green('  no risk patterns matched'))
  for (const f of r.riskFlags) {
    console.log(`  ${f.severity === 'high' ? red('!') : yellow('?')} ${f.why}`)
  }
  console.log(dim(`
These patterns say where to look, not what to conclude. A security scanner
necessarily contains the patterns it detects; a formatting skill that reads
~/.ssh is a problem no regex can grade. Read it yourself:
  ${r.url}
`))
}

const { opts, rest } = parseArgs(process.argv.slice(2))
const cmd = rest[0] && !rest[0].includes('/') ? rest.shift() : 'suggest'
if (opts.version) { console.log(VERSION); process.exit(0) }
if (opts.help) { console.log(HELP); process.exit(0) }

try {
  if (cmd === 'audit') await cmdAudit(rest[0], opts)
  else if (cmd === 'profile') {
    const p = await profileProject(opts.cwd)
    if (opts.json) console.log(JSON.stringify({ ...p, derivedQueries: deriveQueries(p) }, null, 2))
    else { printProfile(p); console.log(bold('\nWould search for')); for (const g of deriveQueries(p)) console.log(`  ${g.query}  ${dim(`(${g.why})`)}`) }
  } else if (cmd === 'suggest') await cmdSuggest(opts)
  else { console.error(`Unknown command: ${cmd}`); console.log(HELP); process.exit(1) }
} catch (err) {
  console.error(red(`\nskillwise failed: ${err.message}`))
  process.exit(1)
}
