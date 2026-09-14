// Vetting a skill before you trust it.
//
// Installing a skill means adding a stranger's instructions to an agent that has
// a shell and your credentials. The realistic threat is not dramatic malware; it
// is a plausible-looking SKILL.md that quietly tells the agent to do something
// nobody asked for. These patterns say where to look. They do not decide: a
// security scanner necessarily contains the patterns it detects, and a formatting
// skill that reads ~/.ssh is a problem no regex can grade.
import { repoMeta, skillPaths, raw } from './github.js'
import { parseFrontmatter } from './resolve.js'

export const RISK = [
  [/curl[^\n|]*\|\s*(ba)?sh/i, 'pipes a remote script straight into a shell', 'high'],
  [/\brm\s+-rf\s+[~/$]/i, 'destructive recursive delete against a real path', 'high'],
  [/base64\s+(-d|--decode)/i, 'decodes obfuscated payloads', 'medium'],
  [/(~\/\.ssh\b|\.aws\/credentials|\bid_rsa\b|\.netrc\b)/i, 'references private keys or cloud credentials', 'medium'],
  // "Copy .env.example to .env" is the most common benign line in developer
  // docs, so a bare mention proves nothing; reading one back is the signal.
  [/\b(cat|read|source|load|print|echo|open|parse|upload|send)\b[^\n]{0,24}\.env\b(?!\.(example|sample|template))/i,
    'reads a .env file', 'medium'],
  // Matching "a URL near the word POST" flags a link to postgresql.org as
  // exfiltration. Outbound data transfer has concrete shapes; match those.
  [/\bcurl\b[^\n]*\s-(?:X\s*POST|d\b|-data\S*)/i, 'curl sends data to a remote endpoint', 'high'],
  [/\b(?:requests|httpx|axios)\.post\s*\(/i, 'HTTP client posts data', 'medium'],
  [/\bfetch\s*\([^)]*method\s*:\s*["']POST/i, 'fetch posts data', 'medium'],
  [/\bwebhook[_-]?url\b|discord\.com\/api\/webhooks|hooks\.slack\.com/i, 'writes to a webhook sink', 'high'],
  [/ignore (all )?(previous|prior|above) instructions/i, 'prompt-injection phrasing', 'high'],
  [/(disregard|override) (your|the) (system|safety)/i, 'attempts to override system instructions', 'high'],
  [/[​-‏‪-‮⁠-⁤]/, 'hidden or bidirectional unicode', 'high']
]

export async function auditSkill (repo, path, { warn } = {}) {
  const meta = await repoMeta(repo, { warn })
  if (!meta?.full_name) return { repo, error: 'repository not found' }
  const branch = meta.default_branch ?? 'main'

  let target = path
  if (!target) {
    const paths = await skillPaths(repo, branch, { warn })
    if (!paths.length) return { repo, error: 'no SKILL.md found' }
    // Reviewing an arbitrary file and calling it vetted is worse than not
    // vetting, so a multi-skill repo refuses to guess.
    if (paths.length > 1) {
      return { repo, error: `repository ships ${paths.length} skills; pass one with --path`, skillPaths: paths }
    }
    target = paths[0]
  }

  const body = await raw(repo, branch, target)
  if (!body) return { repo, error: `could not read ${target}` }
  const fm = parseFrontmatter(body)

  return {
    repo,
    path: target,
    url: `https://github.com/${repo}/blob/${branch}/${target}`,
    stars: meta.stargazers_count ?? 0,
    pushedAt: meta.pushed_at ?? null,
    archived: !!meta.archived,
    license: meta.license?.spdx_id ?? 'none',
    frontmatter: fm,
    allowedTools: fm['allowed-tools'] ?? 'unrestricted',
    lines: body.split('\n').length,
    hasScripts: /```(bash|sh|python)|scripts\//.test(body),
    riskFlags: RISK.filter(([re]) => re.test(body)).map(([, why, severity]) => ({ why, severity })),
    body
  }
}
