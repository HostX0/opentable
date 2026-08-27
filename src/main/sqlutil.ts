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
