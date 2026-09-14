// Disk cache for network reads.
//
// Repo metadata and file trees change slowly but dominate the request budget:
// resolving 60 repos is 120 requests, and running a second search minutes later
// would repeat every one of them. Search results are deliberately NOT cached -
// "what exists right now" is the question this tool answers.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = join(tmpdir(), 'skillwise-cache')
const TTL_MS = 6 * 60 * 60 * 1000

const keyFor = (k) => join(DIR, createHash('sha256').update(k).digest('hex').slice(0, 40) + '.json')

export async function cached (key, ttl, produce) {
  const file = keyFor(key)
  try {
    const s = await stat(file)
    if (Date.now() - s.mtimeMs < (ttl ?? TTL_MS)) {
      return JSON.parse(await readFile(file, 'utf8'))
    }
  } catch { /* miss */ }

  const value = await produce()
  if (value !== undefined && value !== null) {
    try {
      await mkdir(DIR, { recursive: true })
      await writeFile(file, JSON.stringify(value))
    } catch { /* cache is an optimisation, never a requirement */ }
  }
  return value
}

export const cacheDir = DIR
