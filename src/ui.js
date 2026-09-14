// Terminal rendering helpers.
//
// Two rules shape all of this. Respect the actual width, because a line that
// wraps at the wrong place is harder to read than one that says less. And never
// leave the user staring at nothing: a search takes ten seconds, and ten seconds
// of silence reads as a hang.
import { stdout } from 'node:process'

export const plain = !!process.env.NO_COLOR || !stdout.isTTY
const sgr = (code) => (s) => (plain ? String(s) : `\x1b[${code}m${s}\x1b[0m`)

export const bold = sgr(1)
export const dim = sgr(2)
export const red = sgr(31)
export const green = sgr(32)
export const yellow = sgr(33)
export const blue = sgr(34)
export const magenta = sgr(35)
export const cyan = sgr(36)

export const width = () => Math.min(stdout.columns || 80, 100)
export const visibleLength = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length

/** Wrap to the real terminal width, breaking between words. */
export function wrap (text, indent = 0, max = width()) {
  const limit = Math.max(20, max - indent)
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ')
  const lines = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > limit) { lines.push(line); line = w } else line += (line ? ' ' : '') + w
  }
  if (line) lines.push(line)
  return lines.map((l, i) => (i === 0 ? '' : ' '.repeat(indent)) + l).join('\n')
}

export function truncate (text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
}

export const rule = (label = '') => {
  const w = width()
  if (!label) return dim('─'.repeat(w))
  return dim('─'.repeat(2)) + ' ' + label + ' ' + dim('─'.repeat(Math.max(0, w - visibleLength(label) - 4)))
}

/** A spinner that reports what is happening, not just that something is.
 *  Silent when not a TTY, so pipes and CI logs stay clean. */
export function progress () {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  let label = ''
  let timer = null
  const live = stdout.isTTY && !process.env.NO_COLOR

  const paint = () => {
    stdout.write(`\r\x1b[2K${cyan(frames[i++ % frames.length])} ${label}`)
  }
  return {
    start (initial) {
      label = initial
      if (!live) return
      paint()
      timer = setInterval(paint, 80)
      timer.unref?.()
    },
    update (next) {
      label = next
      if (live) paint()
    },
    stop (final) {
      if (timer) clearInterval(timer)
      if (live) stdout.write('\r\x1b[2K')
      if (final) console.log(final)
    }
  }
}
