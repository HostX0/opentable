import type { Driver, SchemaRelationship } from './types'

export interface RelationshipPathStep {
  relation: SchemaRelationship
  fromSchema: string
  fromTable: string
  toSchema: string
  toTable: string
  /** true when traversing child(FK) -> parent(reference), false for reverse. */
  sourceToTarget: boolean
}

function key(schema: string, table: string): string {
  return `${schema}\u0000${table}`
}

function splitKey(value: string): { schema: string; table: string } {
  const i = value.indexOf('\u0000')
  return { schema: value.slice(0, i), table: value.slice(i + 1) }
}

/**
 * Find the shortest FK path between two tables. Relationships are traversed in
 * either direction because SQL can join parent→child or child→parent equally.
 */
export function findRelationshipPath(
  relationships: SchemaRelationship[],
  from: { schema: string; table: string },
  to: { schema: string; table: string }
): RelationshipPathStep[] | null {
  const start = key(from.schema, from.table)
  const goal = key(to.schema, to.table)
  if (start === goal) return []

  const adjacency = new Map<string, { next: string; relation: SchemaRelationship; forward: boolean }[]>()
  const add = (
    a: string,
    b: string,
    relation: SchemaRelationship,
    forward: boolean
  ): void => {
    const list = adjacency.get(a) ?? []
    list.push({ next: b, relation, forward })
    adjacency.set(a, list)
  }

  for (const relation of relationships) {
    const source = key(relation.sourceSchema, relation.sourceTable)
    const target = key(relation.targetSchema, relation.targetTable)
    add(source, target, relation, true)
    add(target, source, relation, false)
  }

  const queue = [start]
  const seen = new Set([start])
  const previous = new Map<
    string,
    { from: string; relation: SchemaRelationship; forward: boolean }
  >()

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]
    const edges = [...(adjacency.get(current) ?? [])].sort((a, b) =>
      a.next.localeCompare(b.next)
    )
    for (const edge of edges) {
      if (seen.has(edge.next)) continue
      seen.add(edge.next)
      previous.set(edge.next, { from: current, relation: edge.relation, forward: edge.forward })
      if (edge.next === goal) {
        const steps: RelationshipPathStep[] = []
        let walk = goal
        while (walk !== start) {
          const p = previous.get(walk)
          if (!p) return null
          const fromParts = splitKey(p.from)
          const toParts = splitKey(walk)
          steps.push({
            relation: p.relation,
            fromSchema: fromParts.schema,
            fromTable: fromParts.table,
            toSchema: toParts.schema,
            toTable: toParts.table,
            sourceToTarget: p.forward
          })
          walk = p.from
        }
        return steps.reverse()
      }
      queue.push(edge.next)
    }
  }
  return null
}

function ident(value: string, driver: Driver): string {
  if (driver === 'mysql') return '`' + value.replace(/`/g, '``') + '`'
  return '"' + value.replace(/"/g, '""') + '"'
}

function qualified(schema: string, table: string, driver: Driver): string {
  if (driver === 'postgres' && schema && schema !== 'public') {
    return `${ident(schema, driver)}.${ident(table, driver)}`
  }
  return ident(table, driver)
}

/** Build a ready-to-run multi-hop JOIN for a path returned above. */
export function buildRelationshipPathSql(
  driver: Driver,
  from: { schema: string; table: string },
  steps: RelationshipPathStep[]
): string {
  const aliases = steps.map((_, i) => `t${i + 1}`)
  const selectAliases = ['t0', ...aliases].map((a) => `${a}.*`).join(', ')
  const lines = [`SELECT ${selectAliases}`, `FROM ${qualified(from.schema, from.table, driver)} AS t0`]

  steps.forEach((step, i) => {
    const currentAlias = `t${i}`
    const nextAlias = `t${i + 1}`
    const relation = step.relation
    const leftColumns = step.sourceToTarget ? relation.sourceColumns : relation.targetColumns
    const rightColumns = step.sourceToTarget ? relation.targetColumns : relation.sourceColumns
    const predicates = leftColumns
      .map(
        (column, n) =>
          `${currentAlias}.${ident(column, driver)} = ${nextAlias}.${ident(rightColumns[n], driver)}`
      )
      .join('\n AND ')
    lines.push(
      `JOIN ${qualified(step.toSchema, step.toTable, driver)} AS ${nextAlias}`,
      `  ON ${predicates}`
    )
  })

  return lines.join('\n') + ';'
}
