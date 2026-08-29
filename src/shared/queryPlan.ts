import type {
  Driver,
  PlanFinding,
  PlanSeverity,
  QueryPlan,
  QueryPlanNode,
  ResultSet
} from './types'

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function text(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  return String(value)
}

function severityForRows(rows: number | undefined): PlanSeverity {
  if ((rows ?? 0) >= 250_000) return 'critical'
  if ((rows ?? 0) >= 10_000) return 'warning'
  return 'info'
}

function findingKey(f: PlanFinding): string {
  return `${f.severity}\u0000${f.title}\u0000${f.nodeId ?? ''}`
}

function uniqueFindings(findings: PlanFinding[]): PlanFinding[] {
  const seen = new Set<string>()
  return findings.filter((f) => {
    const key = findingKey(f)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pgNode(raw: Record<string, unknown>, path: string, findings: PlanFinding[]): QueryPlanNode {
  const operation = text(raw['Node Type']) ?? 'Plan node'
  const relation = text(raw['Relation Name'])
  const alias = text(raw['Alias'])
  const index = text(raw['Index Name'])
  const estimatedRows = num(raw['Plan Rows'])
  const estimatedCost = num(raw['Total Cost'])
  const filter = text(raw['Filter'] ?? raw['Index Cond'] ?? raw['Hash Cond'] ?? raw['Join Filter'])
  const id = `pg:${path}`
  const lower = operation.toLowerCase()

  if (lower.includes('seq scan') && (estimatedRows ?? 0) >= 1_000) {
    findings.push({
      severity: severityForRows(estimatedRows),
      title: `Sequential scan on ${relation ?? alias ?? 'a relation'}`,
      detail: `PostgreSQL estimates ${estimatedRows?.toLocaleString() ?? 'many'} rows will be scanned without an index path.`,
      nodeId: id,
      suggestion: filter
        ? 'Check whether the filter/join columns have a selective index, then compare the new plan.'
        : 'If this table is large, verify that a full scan is intentional.'
    })
  }

  if (lower.includes('sort') && (estimatedRows ?? 0) >= 25_000) {
    findings.push({
      severity: severityForRows(estimatedRows),
      title: 'Large sort in the plan',
      detail: `The sort is estimated to process ${estimatedRows?.toLocaleString()} rows.`,
      nodeId: id,
      suggestion: 'An index matching ORDER BY / GROUP BY can sometimes remove or shrink this sort.'
    })
  }

  if (lower.includes('nested loop') && (estimatedRows ?? 0) >= 100_000) {
    findings.push({
      severity: 'warning',
      title: 'High-cardinality nested loop',
      detail: `This nested loop is estimated to emit ${estimatedRows?.toLocaleString()} rows.`,
      nodeId: id,
      suggestion: 'Verify join indexes and row estimates; a large nested loop can multiply work quickly.'
    })
  }

  const childrenRaw = Array.isArray(raw['Plans']) ? (raw['Plans'] as Record<string, unknown>[]) : []
  return {
    id,
    operation,
    relation,
    alias,
    index,
    estimatedRows,
    estimatedCost,
    filter,
    children: childrenRaw.map((child, i) => pgNode(child, `${path}.${i}`, findings))
  }
}

function postgresPlan(set: ResultSet): QueryPlan {
  const rawValue = set.rows[0]?.[0]
  const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue
  const doc = Array.isArray(parsed) ? parsed[0] : parsed
  const planRaw = (doc?.Plan ?? doc?.plan ?? doc) as Record<string, unknown>
  if (!planRaw || typeof planRaw !== 'object') throw new Error('PostgreSQL returned an unreadable EXPLAIN plan')
  const findings: PlanFinding[] = []
  const root = pgNode(planRaw, '0', findings)
  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      title: 'No obvious planner red flags',
      detail: 'The estimated plan does not contain a large sequential scan, large sort, or high-cardinality nested loop.'
    })
  }
  return {
    driver: 'postgres',
    executed: false,
    totalCost: root.estimatedCost,
    estimatedRows: root.estimatedRows,
    root,
    findings: uniqueFindings(findings),
    raw: JSON.stringify(parsed, null, 2)
  }
}

function mysqlChildren(value: unknown, path: string, findings: PlanFinding[]): QueryPlanNode[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => mysqlChildren(item, `${path}.${i}`, findings))
  if (!value || typeof value !== 'object') return []
  const obj = value as Record<string, unknown>

  if (obj.table && typeof obj.table === 'object') {
    return [mysqlTableNode(obj.table as Record<string, unknown>, `${path}.table`, findings)]
  }

  const nodes: QueryPlanNode[] = []
  const structural = [
    'nested_loop',
    'query_block',
    'ordering_operation',
    'grouping_operation',
    'duplicates_removal',
    'union_result',
    'materialized_from_subquery',
    'attached_subqueries'
  ]
  for (const key of structural) {
    if (!(key in obj)) continue
    const children = mysqlChildren(obj[key], `${path}.${key}`, findings)
    if (key === 'query_block' || key === 'nested_loop' || key === 'attached_subqueries') {
      nodes.push(...children)
    } else if (children.length) {
      nodes.push({ id: `my:${path}.${key}`, operation: key.replace(/_/g, ' '), children })
    }
  }
  return nodes
}

function mysqlTableNode(
  table: Record<string, unknown>,
  path: string,
  findings: PlanFinding[]
): QueryPlanNode {
  const relation = text(table.table_name)
  const access = text(table.access_type)
  const index = text(table.key)
  const estimatedRows = num(table.rows_examined_per_scan ?? table.rows_produced_per_join)
  const filter = text(table.attached_condition)
  const id = `my:${path}`

  if (access?.toUpperCase() === 'ALL' && (estimatedRows ?? 0) >= 1_000) {
    findings.push({
      severity: severityForRows(estimatedRows),
      title: `Full table scan on ${relation ?? 'a table'}`,
      detail: `MySQL estimates ${estimatedRows?.toLocaleString() ?? 'many'} rows examined per scan with access type ALL.`,
      nodeId: id,
      suggestion: 'Review possible_keys and predicates; a selective index may replace the full scan.'
    })
  }

  if (table.using_filesort === true || /filesort/i.test(String(table.using_filesort ?? ''))) {
    findings.push({
      severity: 'warning',
      title: 'Filesort reported',
      detail: 'MySQL expects an explicit sort step for this part of the query.',
      nodeId: id,
      suggestion: 'Check whether an index can satisfy the ORDER BY in the required column order.'
    })
  }

  return {
    id,
    operation: access ? `table access · ${access}` : 'table access',
    relation,
    access,
    index,
    estimatedRows,
    filter,
    detail: text(table.message),
    children: mysqlChildren(table.materialized_from_subquery, `${path}.materialized`, findings)
  }
}

function mysqlPlan(set: ResultSet): QueryPlan {
  const rawValue = set.rows[0]?.[0]
  const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue
  const findings: PlanFinding[] = []
  const children = mysqlChildren(parsed, '0', findings)
  const root: QueryPlanNode =
    children.length === 1 ? children[0] : { id: 'my:root', operation: 'query', children }

  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      title: 'No obvious access-path red flags',
      detail: 'The estimated plan does not show a large access_type ALL scan in the parsed table nodes.'
    })
  }
  return {
    driver: 'mysql',
    executed: false,
    estimatedRows: root.estimatedRows,
    root,
    findings: uniqueFindings(findings),
    raw: JSON.stringify(parsed, null, 2)
  }
}

function sqlitePlan(set: ResultSet): QueryPlan {
  const col = (name: string): number => set.columns.findIndex((c) => c.toLowerCase() === name)
  const idAt = col('id')
  const parentAt = col('parent')
  const detailAt = col('detail')
  if (idAt < 0 || parentAt < 0 || detailAt < 0) throw new Error('SQLite returned an unreadable EXPLAIN QUERY PLAN result')
  const nodes = new Map<number, QueryPlanNode>()
  const parent = new Map<number, number>()
  const findings: PlanFinding[] = []

  for (const row of set.rows) {
    const id = Number(row[idAt])
    const parentId = Number(row[parentAt])
    const detail = String(row[detailAt] ?? '')
    const scan = /\bSCAN\s+(?:TABLE\s+)?([^\s]+)/i.exec(detail)
    const search = /\bSEARCH\s+(?:TABLE\s+)?([^\s]+)/i.exec(detail)
    const using = /\bUSING\s+(?:COVERING\s+)?INDEX\s+([^\s]+)/i.exec(detail)
    const relation = scan?.[1] ?? search?.[1]
    const nodeId = `sq:${id}`
    nodes.set(id, {
      id: nodeId,
      operation: scan ? 'scan' : search ? 'search' : detail.split(/\s+/).slice(0, 3).join(' ') || 'plan step',
      relation,
      index: using?.[1],
      detail,
      children: []
    })
    parent.set(id, parentId)

    if (scan && !/USING\s+(?:COVERING\s+)?INDEX/i.test(detail)) {
      findings.push({
        severity: 'warning',
        title: `Full scan on ${relation ?? 'a table'}`,
        detail,
        nodeId,
        suggestion: 'If this query is selective, an index on its WHERE/JOIN columns may avoid the scan.'
      })
    }
    if (/USE TEMP B-TREE/i.test(detail)) {
      findings.push({
        severity: 'warning',
        title: 'Temporary B-tree',
        detail,
        nodeId,
        suggestion: 'SQLite is materializing sort/group work; a matching index can sometimes avoid it.'
      })
    }
  }

  const roots: QueryPlanNode[] = []
  for (const [id, node] of nodes) {
    const p = parent.get(id)
    const parentNode = p === undefined || p === id ? undefined : nodes.get(p)
    if (parentNode) parentNode.children.push(node)
    else roots.push(node)
  }
  const root: QueryPlanNode =
    roots.length === 1 ? roots[0] : { id: 'sq:root', operation: 'query plan', children: roots }
  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      title: 'No obvious SQLite plan red flags',
      detail: 'The plan does not report an unindexed SCAN or temporary B-tree.'
    })
  }
  return {
    driver: 'sqlite',
    executed: false,
    root,
    findings: uniqueFindings(findings),
    raw: set.rows.map((row) => row.map(String).join(' | ')).join('\n')
  }
}

export function parseQueryPlan(driver: Driver, set: ResultSet): QueryPlan {
  if (driver === 'postgres') return postgresPlan(set)
  if (driver === 'mysql') return mysqlPlan(set)
  return sqlitePlan(set)
}
