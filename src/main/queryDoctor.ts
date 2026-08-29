import type { Driver, QueryPlan } from '../shared/types'
import { parseQueryPlan } from '../shared/queryPlan'
import { splitStatements } from '../shared/sqlscan'
import { getConfig, runQuery } from './db'
import { canAutoRun } from './sqlutil'

function explainSql(driver: Driver, sql: string): string {
  if (driver === 'postgres') return `EXPLAIN (FORMAT JSON, COSTS TRUE, VERBOSE FALSE) ${sql}`
  if (driver === 'mysql') return `EXPLAIN FORMAT=JSON ${sql}`
  return `EXPLAIN QUERY PLAN ${sql}`
}

/**
 * Query Doctor is intentionally EXPLAIN-only. It never uses ANALYZE, so opening
 * the tool cannot execute a SELECT's workload or mutate data through a write CTE.
 */
export async function diagnoseQuery(id: string, sql: string): Promise<QueryPlan> {
  const cfg = getConfig(id)
  if (!cfg) throw new Error('Not connected')
  const statements = splitStatements(sql)
  const verdict = canAutoRun(statements)
  if (!verdict.autoRun) {
    throw new Error(
      `Query Doctor accepts one plainly read-only SELECT (${verdict.reason ?? 'approval required'}).`
    )
  }

  const result = await runQuery(id, explainSql(cfg.driver, statements[0]), { rowLimit: 0 })
  const set = result.sets[0]
  if (!set) throw new Error('The database did not return an EXPLAIN plan')
  return parseQueryPlan(cfg.driver, set)
}
