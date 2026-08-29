import type { Driver } from '../shared/types'
export { quoteIdent } from '../shared/sql'

/** Renders a value as a SQL literal. Display/logging only — execution uses parameters. */
export function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return "'" + String(value).replace(/'/g, "''") + "'"
}

export function placeholder(driver: Driver, index: number): string {
  return driver === 'postgres' ? `$${index}` : '?'
}

export interface BuiltStatement {
  /** parameterized SQL actually sent to the server */
  text: string
  params: unknown[]
  /** human-readable SQL with values inlined, for the review panel and history */
  display: string
}

/** True when a statement changes data or structure. */
export function isDestructive(sql: string): boolean {
  return /^\s*(update|delete|drop|truncate|alter|insert|replace|create|grant|revoke)\b/i.test(sql)
}

/** UPDATE/DELETE with no WHERE clause — the classic production accident. */
export function isUnscopedWrite(sql: string): boolean {
  const s = sql.trim()
  if (!/^\s*(update|delete)\b/i.test(s)) return false
  return !/\bwhere\b/i.test(s)
}

/* ————————————————————— auto-run classification ————————————————————— */

/**
 * Decides whether the assistant may run a statement on its own, or must stop
 * and ask first. Nothing is permanently forbidden — the user can approve
 * anything they could have typed themselves — but the default is to ask.
 *
 * This is an allowlist, not a blocklist, because the input is model-generated
 * rather than typed by a person. `isDestructive` above is the opposite shape:
 * fine for warning a human about their own SQL, useless as a gate on an LLM.
 *
 * Traps that make a first-keyword check insufficient:
 *   WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x   -- a write, starts WITH
 *   SELECT * INTO new_table FROM t                          -- creates a table (Postgres)
 *   SELECT * FROM t INTO OUTFILE '/tmp/x'                   -- writes a file (MySQL)
 *   SELECT * FROM t FOR UPDATE                              -- takes row locks
 *   SELECT pg_sleep(9999)                                   -- ties up the connection
 */
const NEEDS_APPROVAL = [
  // anything that writes data or structure, wherever it appears
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|upsert)\b/i,
  // REPLACE() and MERGE() are also ordinary functions, so only bar them as verbs
  /^\s*(replace|merge)\b/i,
  // procedural escapes
  /\b(call|do|execute|prepare|deallocate)\b/i,
  // server-side file and program access
  /\b(copy|outfile|dumpfile|load_file|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|dblink)\b/i,
  // session and maintenance verbs
  /\b(set|reset|vacuum|analyze|reindex|cluster|checkpoint|discard|listen|notify|attach|detach)\b/i,
  // SELECT ... INTO creates a table on Postgres
  /\binto\b/i,
  // locking reads
  /\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i,
  // trivially available denial of service
  /\b(pg_sleep|sleep|benchmark|generate_series)\s*\(/i
]

/** Removes comments and literal contents so keyword matching cannot be fooled. */
function analysable(sql: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (quote) {
      if (ch === '\\' && quote !== '`') {
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        out += ' '
      }
      i++
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i++
      continue
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    out += ch
    i++
  }
  return out
}

export interface AutoRunVerdict {
  /** true when the assistant may run this itself without interrupting */
  autoRun: boolean
  /** why approval is needed, phrased for the confirmation prompt */
  reason?: string
}

/**
 * `statements` comes from splitStatements, which is quote- and comment-aware.
 * Anything that is not a single, plainly read-only SELECT needs approval.
 */
export function canAutoRun(statements: string[]): AutoRunVerdict {
  if (statements.length === 0) return { autoRun: false, reason: 'empty statement' }
  if (statements.length > 1) {
    return { autoRun: false, reason: `${statements.length} statements in one block` }
  }
  const text = analysable(statements[0])
  if (!/^\s*(select|with)\b/i.test(text)) {
    const verb = /^\s*([a-z_]+)/i.exec(text.trim())?.[1] ?? 'statement'
    return { autoRun: false, reason: `${verb.toUpperCase()} changes the database` }
  }
  for (const pattern of NEEDS_APPROVAL) {
    const hit = pattern.exec(text)
    if (hit) return { autoRun: false, reason: `contains ${hit[0].trim().toUpperCase()}` }
  }
  return { autoRun: true }
}
