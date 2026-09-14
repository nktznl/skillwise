// Minimal interactive prompts, written by hand to keep the package dependency-free.
//
// An npx tool people run once should not drag a prompt library (and its tree)
// through the network first. This is the whole surface needed: a checkbox list
// and a yes/no.
import { stdin, stdout } from 'node:process'
import { emitKeypressEvents } from 'node:readline'

export const interactive = () => stdin.isTTY && stdout.isTTY

const ESC = { up: '\x1b[A', down: '\x1b[B' }

function render (lines, previousHeight) {
  if (previousHeight) stdout.write(`\x1b[${previousHeight}A`)
  for (const line of lines) stdout.write(`\x1b[2K${line}\n`)
  return lines.length
}

/** Checkbox list. Returns the chosen items, or null if the user backed out. */
export function checkbox (title, items, { render: renderItem, hint } = {}) {
  return new Promise((resolve) => {
    const chosen = new Set()
    let cursor = 0
    let height = 0
    const label = renderItem ?? ((it) => String(it))

    const draw = () => {
      const lines = [title, '']
      items.forEach((item, i) => {
        const mark = chosen.has(i) ? '\x1b[32m◉\x1b[0m' : '◯'
        const pointer = i === cursor ? '\x1b[36m❯\x1b[0m' : ' '
        for (const [j, part] of label(item, i === cursor).split('\n').entries()) {
          lines.push(j === 0 ? `${pointer} ${mark} ${part}` : `    ${part}`)
        }
      })
      lines.push('', `\x1b[2m${hint ?? '↑↓ move · space select · a all · enter confirm · esc cancel'}\x1b[0m`)
      height = render(lines, height)
    }

    emitKeypressEvents(stdin)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()

    const done = (value) => {
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdin.removeListener('keypress', onKey)
      stdout.write('\n')
      resolve(value)
    }

    function onKey (str, key) {
      if (key.name === 'up' || str === ESC.up) cursor = (cursor - 1 + items.length) % items.length
      else if (key.name === 'down' || str === ESC.down) cursor = (cursor + 1) % items.length
      else if (str === ' ') chosen.has(cursor) ? chosen.delete(cursor) : chosen.add(cursor)
      else if (str === 'a') {
        if (chosen.size === items.length) chosen.clear()
        else items.forEach((_, i) => chosen.add(i))
      } else if (key.name === 'return') return done([...chosen].sort((a, b) => a - b).map((i) => items[i]))
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null)
      draw()
    }

    stdin.on('keypress', onKey)
    draw()
  })
}

/** Single-choice list, same keys minus the toggling. */
export function select (title, options) {
  return new Promise((resolve) => {
    let cursor = 0
    let height = 0
    const draw = () => {
      const lines = [title, '']
      options.forEach((o, i) => {
        lines.push(`${i === cursor ? '\x1b[36m❯\x1b[0m' : ' '} ${o.label}` +
          (o.hint ? `  \x1b[2m${o.hint}\x1b[0m` : ''))
      })
      lines.push('', '\x1b[2m↑↓ move · enter choose · esc cancel\x1b[0m')
      height = render(lines, height)
    }
    emitKeypressEvents(stdin)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    const done = (v) => {
      stdin.setRawMode(wasRaw); stdin.pause(); stdin.removeListener('keypress', onKey)
      stdout.write('\n'); resolve(v)
    }
    function onKey (str, key) {
      if (key.name === 'up') cursor = (cursor - 1 + options.length) % options.length
      else if (key.name === 'down') cursor = (cursor + 1) % options.length
      else if (key.name === 'return') return done(options[cursor].value)
      else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null)
      draw()
    }
    stdin.on('keypress', onKey)
    draw()
  })
}

export function confirm (question, { defaultYes = false } = {}) {
  return new Promise((resolve) => {
    stdout.write(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)
    emitKeypressEvents(stdin)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    const done = (v) => {
      stdin.setRawMode(wasRaw); stdin.pause(); stdin.removeListener('keypress', onKey)
      stdout.write(`${v ? 'yes' : 'no'}\n`); resolve(v)
    }
    function onKey (str, key) {
      if (key.ctrl && key.name === 'c') return done(false)
      if (key.name === 'return') return done(defaultYes)
      if (/^[yY]$/.test(str)) return done(true)
      if (/^[nN]$/.test(str)) return done(false)
    }
    stdin.on('keypress', onKey)
  })
}
