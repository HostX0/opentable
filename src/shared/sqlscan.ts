export interface SqlWord {
  value: string
  start: number
  end: number
  depth: number
}

/** PostgreSQL dollar-quote opener at `index`, or null when `$` is ordinary SQL. */
function dollarTagAt(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))
  return match?.[0] ?? null
}

function quotedEnd(sql: string, index: number, quote: "'" | '"' | '`'): number {
  let i = index + 1
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === quote) {
      // Standard SQL escapes a delimiter by doubling it: 'it''s', "odd""name",
      // and `` in MySQL identifiers. Do not universally honour backslash
      // escapes here: PostgreSQL normally treats backslash as ordinary text,
      // so doing so could hide a real closing quote and executable SQL after it.
      // For ambiguous MySQL string syntax the safety scanner deliberately fails
      // closed (possibly asking for approval) rather than hiding a statement.
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

function bracketEnd(sql: string, index: number): number {
  let i = index + 1
  while (i < sql.length) {
    if (sql[i] === ']') {
      if (sql[i + 1] === ']') {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

function dollarEnd(sql: string, index: number, tag: string): number {
  const close = sql.indexOf(tag, index + tag.length)
  return close === -1 ? sql.length : close + tag.length
}

function blockCommentEnd(sql: string, index: number): number {
  // PostgreSQL allows nested block comments. Supporting them everywhere is
  // harmless and prevents a semicolon in the inner comment becoming SQL.
  let depth = 1
  let i = index + 2
  while (i < sql.length && depth > 0) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth++
      i += 2
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth--
      i += 2
    } else {
      i++
    }
  }
  return i
}

function lineCommentEnd(sql: string, index: number): number {
  let i = index
  while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
  return i
}

/**
 * Replaces comments, string literals and quoted identifiers with spaces while
 * preserving string length and newlines. Keyword checks can then operate on
 * SQL structure without being fooled by `WHERE` in a value or `DELETE` in a
 * comment. PostgreSQL dollar-quoted strings are covered too.
 *
 * `#` is intentionally not treated as a universal line comment here: MySQL
 * accepts that form, but PostgreSQL uses #, #> and #>> as real operators. A
 * shared safety scanner must never hide executable SQL after one of those.
 */
export function maskSqlForAnalysis(sql: string): string {
  const out = sql.split('')
  let i = 0

  const blank = (from: number, to: number): void => {
    for (let p = from; p < to; p++) {
      if (out[p] !== '\n' && out[p] !== '\r') out[p] = ' '
    }
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      const end = lineCommentEnd(sql, i)
      blank(i, end)
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = blockCommentEnd(sql, i)
      blank(i, end)
      i = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedEnd(sql, i, ch)
      blank(i, end)
      i = end
      continue
    }
    if (ch === '[') {
      const end = bracketEnd(sql, i)
      blank(i, end)
      i = end
      continue
    }
    if (ch === '$') {
      const tag = dollarTagAt(sql, i)
      if (tag) {
        const end = dollarEnd(sql, i, tag)
        blank(i, end)
        i = end
        continue
      }
    }
    i++
  }

  return out.join('')
}

/** Words outside comments/literals/quoted identifiers, annotated with paren depth. */
export function scanSqlWords(sql: string): SqlWord[] {
  const masked = maskSqlForAnalysis(sql)
  const words: SqlWord[] = []
  let depth = 0
  let i = 0

  while (i < masked.length) {
    const ch = masked[i]
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i++
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i
      i++
      while (i < masked.length && /[A-Za-z0-9_$]/.test(masked[i])) i++
      words.push({ value: masked.slice(start, i).toLowerCase(), start, end: i, depth })
      continue
    }
    i++
  }
  return words
}

const MAIN_VERBS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'merge',
  'replace',
  'create',
  'alter',
  'drop',
  'truncate'
])

/** Main statement verb, including a statement that begins with WITH/CTEs. */
export function mainStatementWord(sql: string): SqlWord | undefined {
  const top = scanSqlWords(sql).filter((w) => w.depth === 0)
  if (top.length === 0) return undefined
  if (top[0].value !== 'with') return top[0]
  return top.slice(1).find((w) => MAIN_VERBS.has(w.value))
}

/**
 * Split a script on real statement semicolons. Semicolons in strings, quoted
 * identifiers, comments and PostgreSQL dollar-quoted bodies stay untouched.
 * Comment-only tails are discarded, so `SELECT 1; -- note` is one statement.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let hasCode = false
  let i = 0

  const take = (end: number, code: boolean): void => {
    cur += sql.slice(i, end)
    hasCode ||= code
    i = end
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      take(lineCommentEnd(sql, i), false)
      continue
    }
    if (ch === '/' && next === '*') {
      take(blockCommentEnd(sql, i), false)
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      take(quotedEnd(sql, i, ch), true)
      continue
    }
    if (ch === '[') {
      take(bracketEnd(sql, i), true)
      continue
    }
    if (ch === '$') {
      const tag = dollarTagAt(sql, i)
      if (tag) {
        take(dollarEnd(sql, i, tag), true)
        continue
      }
    }
    if (ch === ';') {
      if (hasCode && cur.trim()) out.push(cur.trim())
      cur = ''
      hasCode = false
      i++
      continue
    }

    cur += ch
    if (!/\s/.test(ch)) hasCode = true
    i++
  }

  if (hasCode && cur.trim()) out.push(cur.trim())
  return out
}
