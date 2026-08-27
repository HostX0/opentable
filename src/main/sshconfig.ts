import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'

export interface SshConfigHost {
  /** the alias you type after `ssh` */
  alias: string
  hostName: string
  port: number
  user: string
  identityFile?: string
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Reads ~/.ssh/config so a saved bastion can be picked instead of retyped.
 * Wildcard patterns and `Match` blocks are skipped — they describe defaults
 * rather than a specific host you would connect to.
 */
export function readSshHosts(): SshConfigHost[] {
  const path = join(homedir(), '.ssh', 'config')
  if (!existsSync(path)) return []

  let text = ''
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return []
  }

  const hosts: SshConfigHost[] = []
  let current: { aliases: string[]; opts: Record<string, string> } | null = null

  const flush = (): void => {
    if (!current) return
    for (const alias of current.aliases) {
      if (alias.includes('*') || alias.includes('?')) continue
      const identity = current.opts['identityfile']
      hosts.push({
        alias,
        hostName: current.opts['hostname'] || alias,
        port: Number(current.opts['port']) || 22,
        user: current.opts['user'] || '',
        identityFile: identity ? expandHome(identity.replace(/^"|"$/g, '')) : undefined
      })
    }
    current = null
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    // `Key value` or `Key=value`
    const m = /^(\w+)\s*=?\s+(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()

    if (key === 'host') {
      flush()
      current = { aliases: value.split(/\s+/).filter(Boolean), opts: {} }
    } else if (key === 'match') {
      flush()
    } else if (current) {
      // first occurrence wins, matching ssh's own precedence
      if (!(key in current.opts)) current.opts[key] = value
    }
  }
  flush()

  // de-duplicate by alias, keep declaration order
  const seen = new Set<string>()
  return hosts.filter((h) => {
    if (seen.has(h.alias)) return false
    seen.add(h.alias)
    return true
  })
}
