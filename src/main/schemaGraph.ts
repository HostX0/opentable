import type { Driver, ResultSet, SchemaRelationship } from '../shared/types'
import { getConfig, runQuery } from './db'

interface RelationshipRow {
  name: string
  sourceSchema: string
  sourceTable: string
  sourceColumn: string
  targetSchema: string
  targetTable: string
  targetColumn: string
  ordinal: number
  onUpdate?: string
  onDelete?: string
}

const POSTGRES_SQL = `
select con.conname as name,
       ns.nspname as source_schema,
       src.relname as source_table,
       src_att.attname as source_column,
       nt.nspname as target_schema,
       target.relname as target_table,
       target_att.attname as target_column,
       src_key.ord as ordinal,
       con.confupdtype::text as update_rule,
       con.confdeltype::text as delete_rule
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid
  join pg_namespace ns on ns.oid = src.relnamespace
  join pg_class target on target.oid = con.confrelid
  join pg_namespace nt on nt.oid = target.relnamespace
  join lateral unnest(con.conkey) with ordinality as src_key(attnum, ord) on true
  join lateral unnest(con.confkey) with ordinality as target_key(attnum, ord)
    on target_key.ord = src_key.ord
  join pg_attribute src_att
    on src_att.attrelid = con.conrelid and src_att.attnum = src_key.attnum
  join pg_attribute target_att
    on target_att.attrelid = con.confrelid and target_att.attnum = target_key.attnum
 where con.contype = 'f'
   and ns.nspname not in ('pg_catalog', 'information_schema')
 order by ns.nspname, src.relname, con.conname, src_key.ord`

const MYSQL_SQL = `
select k.constraint_name as name,
       k.table_schema as source_schema,
       k.table_name as source_table,
       k.column_name as source_column,
       k.referenced_table_schema as target_schema,
       k.referenced_table_name as target_table,
       k.referenced_column_name as target_column,
       k.ordinal_position as ordinal,
       rc.update_rule as update_rule,
       rc.delete_rule as delete_rule
  from information_schema.key_column_usage k
  left join information_schema.referential_constraints rc
    on rc.constraint_schema = k.constraint_schema
   and rc.constraint_name = k.constraint_name
   and rc.table_name = k.table_name
 where k.table_schema = database()
   and k.referenced_table_name is not null
 order by k.table_name, k.constraint_name, k.ordinal_position`

// SQLite exposes PRAGMAs as table-valued functions. Joining against
// sqlite_schema lets us fetch every foreign key with one cheap metadata query.
const SQLITE_SQL = `
select 'fk_' || m.name || '_' || fk.id as name,
       'main' as source_schema,
       m.name as source_table,
       fk."from" as source_column,
       'main' as target_schema,
       fk."table" as target_table,
       fk."to" as target_column,
       fk.seq + 1 as ordinal,
       fk.on_update as update_rule,
       fk.on_delete as delete_rule
  from sqlite_schema m
  join pragma_foreign_key_list(m.name) fk
 where m.type = 'table'
   and m.name not like 'sqlite_%'
 order by m.name, fk.id, fk.seq`

function value(set: ResultSet, row: unknown[], name: string): unknown {
  const index = set.columns.indexOf(name)
  return index >= 0 ? row[index] : undefined
}

function text(set: ResultSet, row: unknown[], name: string): string {
  const v = value(set, row, name)
  return v == null ? '' : String(v)
}

function postgresAction(code: string): string | undefined {
  return (
    {
      a: 'NO ACTION',
      r: 'RESTRICT',
      c: 'CASCADE',
      n: 'SET NULL',
      d: 'SET DEFAULT'
    } as Record<string, string>
  )[code]
}

function normalizeAction(driver: Driver, action: string): string | undefined {
  if (!action) return undefined
  return driver === 'postgres' ? postgresAction(action) : action.toUpperCase()
}

function rowsFrom(set: ResultSet, driver: Driver): RelationshipRow[] {
  return set.rows
    .map((row) => ({
      name: text(set, row, 'name'),
      sourceSchema: text(set, row, 'source_schema'),
      sourceTable: text(set, row, 'source_table'),
      sourceColumn: text(set, row, 'source_column'),
      targetSchema: text(set, row, 'target_schema'),
      targetTable: text(set, row, 'target_table'),
      targetColumn: text(set, row, 'target_column'),
      ordinal: Number(value(set, row, 'ordinal') ?? 0),
      onUpdate: normalizeAction(driver, text(set, row, 'update_rule')),
      onDelete: normalizeAction(driver, text(set, row, 'delete_rule'))
    }))
    .filter(
      (r) => r.name && r.sourceTable && r.sourceColumn && r.targetTable && r.targetColumn
    )
}

function group(rows: RelationshipRow[]): SchemaRelationship[] {
  const grouped = new Map<string, SchemaRelationship & { ordinals: number[] }>()

  for (const row of rows) {
    const key = [
      row.sourceSchema,
      row.sourceTable,
      row.name,
      row.targetSchema,
      row.targetTable
    ].join('\u0000')
    let relation = grouped.get(key)
    if (!relation) {
      relation = {
        name: row.name,
        sourceSchema: row.sourceSchema,
        sourceTable: row.sourceTable,
        sourceColumns: [],
        targetSchema: row.targetSchema,
        targetTable: row.targetTable,
        targetColumns: [],
        onUpdate: row.onUpdate,
        onDelete: row.onDelete,
        ordinals: []
      }
      grouped.set(key, relation)
    }
    relation.sourceColumns.push(row.sourceColumn)
    relation.targetColumns.push(row.targetColumn)
    relation.ordinals.push(row.ordinal)
  }

  return [...grouped.values()].map(({ ordinals, ...relation }) => {
    const zipped = relation.sourceColumns.map((source, i) => ({
      source,
      target: relation.targetColumns[i],
      ordinal: ordinals[i]
    }))
    zipped.sort((a, b) => a.ordinal - b.ordinal)
    return {
      ...relation,
      sourceColumns: zipped.map((x) => x.source),
      targetColumns: zipped.map((x) => x.target)
    }
  })
}

/** Fetch all real foreign-key edges without touching user query history. */
export async function getSchemaRelationships(id: string): Promise<SchemaRelationship[]> {
  const cfg = getConfig(id)
  if (!cfg) throw new Error('Not connected')

  const sql =
    cfg.driver === 'postgres' ? POSTGRES_SQL : cfg.driver === 'mysql' ? MYSQL_SQL : SQLITE_SQL
  const result = await runQuery(id, sql)
  const set = result.sets[0]
  if (!set) return []
  return group(rowsFrom(set, cfg.driver))
}
