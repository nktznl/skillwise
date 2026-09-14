// Reading a project well enough to know what it is missing.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'

const PRUNE = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'venv',
  'target', '.next', '__pycache__', '.terraform', 'coverage', '.cache', '.turbo'])

const MANIFESTS = /^(package\.json|pyproject\.toml|requirements.*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|.*\.csproj|pubspec\.yaml|Package\.swift|mix\.exs)$/

const LANG = { '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.java': 'java',
  '.kt': 'kotlin', '.cs': 'csharp', '.swift': 'swift', '.dart': 'dart', '.ex': 'elixir',
  '.exs': 'elixir', '.sql': 'sql', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ipynb': 'notebook' }

const DETECT = {
  frameworks: [['next', /"next"|next\.config/], ['react', /"react"/], ['vue', /"vue"/],
    ['svelte', /"svelte"/], ['angular', /"@angular\/core"/], ['astro', /"astro"|astro\.config/],
    ['remix', /"@remix-run/], ['nuxt', /"nuxt"/], ['django', /\bdjango\b/i], ['flask', /\bflask\b/i],
    ['fastapi', /fastapi/i], ['rails', /\brails\b/i], ['laravel', /laravel\/framework/],
    ['spring', /spring-boot/], ['express', /"express"/], ['nestjs', /"@nestjs\/core"/],
    ['electron', /"electron"/], ['react-native', /"react-native"/], ['flutter', /\bflutter\b/i]],
  testing: [['jest', /"jest"/], ['vitest', /"vitest"/], ['playwright', /playwright/i],
    ['cypress', /"cypress"/], ['pytest', /pytest/i], ['rspec', /rspec/i],
    ['testing-library', /@testing-library/], ['junit', /junit/i]],
  data: [['prisma', /prisma/i], ['drizzle', /drizzle-orm/], ['sqlalchemy', /sqlalchemy/i],
    ['typeorm', /typeorm/i], ['alembic', /alembic/i], ['mongodb', /mongodb|mongoose/i],
    ['redis', /\bredis\b/i], ['supabase', /supabase/i], ['firebase', /firebase/i], ['dbt', /dbt-core/]],
  cloud: [['aws', /aws-sdk|boto3/], ['gcp', /google-cloud/], ['azure', /@azure\//],
    ['vercel', /"vercel"|vercel\.json/], ['cloudflare', /wrangler|cloudflare/i],
    ['stripe', /\bstripe\b/i], ['twilio', /twilio/i], ['sentry', /@sentry|sentry-sdk/]],
  aiMl: [['anthropic', /anthropic|claude-/i], ['openai', /\bopenai\b/i], ['langchain', /langchain/i],
    ['pytorch', /\btorch\b/], ['tensorflow', /tensorflow/i], ['pandas', /\bpandas\b/],
    ['huggingface', /transformers|huggingface/i], ['mcp', /modelcontextprotocol/i]]
}

async function walk (root, { maxFiles = 20000 } = {}) {
  const files = []
  const queue = ['']
  while (queue.length && files.length < maxFiles) {
    const rel = queue.shift()
    let entries
    try { entries = await readdir(join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!PRUNE.has(e.name)) queue.push(path) } else files.push(path)
    }
  }
  return files
}

const exists = (root, p) => stat(join(root, p)).then(() => true, () => false)

export async function profileProject (root = process.cwd()) {
  const files = await walk(root)
  const byLang = new Map()
  for (const f of files) {
    const l = LANG[extname(f).toLowerCase()]
    if (l) byLang.set(l, (byLang.get(l) ?? 0) + 1)
  }
  const languages = [...byLang.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l]) => l)

  const manifests = files.filter((f) => MANIFESTS.test(basename(f))).slice(0, 40)
  const deps = (await Promise.all(manifests.map((m) =>
    readFile(join(root, m), 'utf8').then((t) => t.slice(0, 60_000), () => '')))).join('\n')
  const hay = deps + '\n' + files.join('\n')
  const detect = (rules) => rules.filter(([, re]) => re.test(hay)).map(([label]) => label)

  const infra = [
    ['docker', /\/Dockerfile|Dockerfile$|docker-compose/],
    ['kubernetes', /\/k8s\/|\/kubernetes\/|Chart\.yaml/],
    ['terraform', /\.tf$/m], ['pulumi', /Pulumi\.yaml/],
    ['github-actions', /\.github\/workflows\//], ['gitlab-ci', /\.gitlab-ci\.yml/],
    ['circleci', /\.circleci\//]
  ].filter(([, re]) => re.test(files.join('\n'))).map(([l]) => l)

  // A skill already installed anywhere is not a gap, whichever tool put it there:
  // .agents/skills is the cross-agent location several installers write to.
  const home = process.env.HOME ?? ''
  const skillRoots = ['.claude/skills', '.agents/skills',
    join(home, '.claude/skills'), join(home, '.agents/skills')]
  const existingSkills = new Set()
  for (const r of skillRoots) {
    const base = r.startsWith('/') ? r : join(root, r)
    try {
      for (const e of await readdir(base, { withFileTypes: true })) {
        if (e.isDirectory() && await exists(join(base, e.name), 'SKILL.md')) existingSkills.add(e.name)
      }
    } catch { /* absent */ }
  }

  const testing = detect(DETECT.testing)
  return {
    root,
    fileCount: files.length,
    languages,
    frameworks: detect(DETECT.frameworks),
    testing,
    infra,
    data: detect(DETECT.data),
    cloud: detect(DETECT.cloud),
    aiMl: detect(DETECT.aiMl),
    existingSkills: [...existingSkills].sort(),
    agentSetup: {
      claudeMd: await exists(root, 'CLAUDE.md'),
      agentsMd: await exists(root, 'AGENTS.md'),
      dotClaude: await exists(root, '.claude'),
      cursorRules: await exists(root, '.cursor')
    },
    signals: {
      hasTests: testing.length > 0,
      hasCi: infra.some((i) => ['github-actions', 'gitlab-ci', 'circleci'].includes(i)),
      isMonorepo: (await Promise.all(['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json']
        .map((f) => exists(root, f)))).some(Boolean),
      containerized: infra.includes('docker')
    }
  }
}

/** Turn the profile into search queries.
 *
 *  A gap is a friction the project will hit, not a technology it uses - so these
 *  read from the absence of things as much as their presence. Specific nouns
 *  carry the search; generic ones dilute it, which is why each query names a
 *  tool or a failure mode rather than a category. */
export function deriveQueries (p) {
  const web = p.frameworks.some((f) =>
    ['next', 'react', 'vue', 'svelte', 'angular', 'astro', 'remix', 'nuxt'].includes(f))
  const gaps = []
  const add = (query, why) => gaps.push({ query, why })

  if (web && !p.signals.hasTests) add('playwright browser end-to-end testing', 'web app with no test setup')
  else if (!p.signals.hasTests && p.languages.length) add(`${p.languages[0]} unit testing framework`, 'no test setup detected')
  if (p.cloud.includes('stripe')) add('stripe payment webhook security', 'payment integration present')
  if (p.data.includes('supabase')) add('supabase postgres row level security', 'supabase in use')
  if (p.cloud.length || p.data.length) add('secret scanning credential leak', 'credentials or cloud SDKs present')
  if (!p.signals.hasCi) add('github actions release pipeline', 'no CI configured')
  if (p.signals.isMonorepo || p.fileCount > 800) add('codebase architecture navigation', 'large or multi-package codebase')
  if (p.infra.includes('terraform') || p.infra.includes('kubernetes')) add('terraform kubernetes infrastructure review', 'infrastructure as code present')
  if (p.aiMl.length) add('llm prompt evaluation harness', 'AI/ML dependencies present')
  if (!p.agentSetup.claudeMd && !p.agentSetup.agentsMd) add('repository onboarding context', 'no agent context file')
  if (p.languages.includes('python')) add('python static analysis linting', 'python source present')

  return gaps.slice(0, 6)
}
