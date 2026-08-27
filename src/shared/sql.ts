import type { Driver } from './types'

/**
 * Quotes an identifier for the given dialect. Embedded quote characters are
 * doubled so a crafted name cannot break out of the quoting.
 * Shared by the main process and the DDL builders in the UI.
 */
export function quoteIdent(name: string, driver: Driver): string {
  if (driver === 'mysql') return '`' + name.replace(/`/g, '``') + '`'
  return '"' + name.replace(/"/g, '""') + '"'
}

/** A plain, unquoted identifier — letters, digits and underscores only. */
export function isSafeIdent(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

export type FkAction = 'NO ACTION' | 'CASCADE' | 'SET NULL' | 'RESTRICT'

export interface ForeignKeyRef {
  table: string
  column: string
  onDelete: FkAction
  onUpdate: FkAction
}

export interface ColumnDef {
  /** stable identity for React keys and reordering; ignored when building DDL */
  id?: string
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  unique: boolean
  defaultValue: string
  /** optional link to a column on another table */
  references?: ForeignKeyRef
}

export const FK_ACTIONS: FkAction[] = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT']

/** Column types offered by the table builder, per dialect. */
export const COLUMN_TYPES: Record<Driver, string[]> = {
  postgres: [
    'text',
    'varchar(255)',
    'integer',
    'bigint',
    'serial',
    'bigserial',
    'boolean',
    'numeric(12,2)',
    'date',
    'timestamptz',
    'jsonb',
    'uuid'
  ],
  mysql: [
    'VARCHAR(255)',
    'TEXT',
    'INT',
    'BIGINT',
    'INT AUTO_INCREMENT',
    'TINYINT(1)',
    'DECIMAL(12,2)',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'JSON',
    'CHAR(36)'
  ],
  sqlite: ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB']
}

/** Types that already imply a primary key / auto-increment. */
export function isAutoIncrement(type: string): boolean {
  return /serial|auto_increment/i.test(type)
}

export interface TableConstraints {
  /** overrides the per-column primaryKey flags when given */
  primaryKey?: string[]
  /** table-level foreign keys, including multi-column ones */
  foreignKeys?: ForeignKeySpec[]
  /** table-level unique constraints spanning several columns */
  uniques?: { name?: string; columns: string[] }[]
}

export interface ForeignKeySpec {
  name?: string
  columns: string[]
  refTable: string
  refColumns: string[]
  onDelete: FkAction
  onUpdate: FkAction
}

export function buildCreateTable(
  driver: Driver,
  schemaName: string,
  tableName: string,
  columns: ColumnDef[],
  constraints: TableConstraints = {}
): string {
  const qualified =
    driver === 'postgres' && schemaName && schemaName !== 'public'
      ? `${quoteIdent(schemaName, driver)}.${quoteIdent(tableName, driver)}`
      : quoteIdent(tableName, driver)

  const usable = columns.filter((c) => c.name.trim())
  const pks =
    constraints.primaryKey ?? usable.filter((c) => c.primaryKey).map((c) => c.name.trim())
  // a single-column SQLite key must be inline to drive rowid auto-increment
  const inlineSqlitePk = driver === 'sqlite' && pks.length === 1

  const lines = usable.map((c) => {
    const bits = [quoteIdent(c.name.trim(), driver), c.type]
    if (inlineSqlitePk && c.primaryKey) bits.push('PRIMARY KEY')
    if (!c.nullable && !(inlineSqlitePk && c.primaryKey)) bits.push('NOT NULL')
    if (c.unique && !c.primaryKey) bits.push('UNIQUE')
    if (c.defaultValue.trim()) bits.push(`DEFAULT ${c.defaultValue.trim()}`)
    return '  ' + bits.join(' ')
  })

  if (!inlineSqlitePk && pks.length > 0) {
    lines.push(`  PRIMARY KEY (${pks.map((p) => quoteIdent(p, driver)).join(', ')})`)
  }

  for (const u of constraints.uniques ?? []) {
    if (u.columns.length === 0) continue
    lines.push(`  UNIQUE (${u.columns.map((c) => quoteIdent(c, driver)).join(', ')})`)
  }

  // Table-level FOREIGN KEY rather than an inline REFERENCES: MySQL parses the
  // inline form but silently ignores it, so only this shape works everywhere.
  const fkSpecs: ForeignKeySpec[] = [
    ...usable
      .filter((c) => c.references?.table && c.references.column)
      .map((c) => ({
        columns: [c.name.trim()],
        refTable: c.references!.table,
        refColumns: [c.references!.column],
        onDelete: c.references!.onDelete,
        onUpdate: c.references!.onUpdate
      })),
    ...(constraints.foreignKeys ?? [])
  ]

  for (const fk of fkSpecs) {
    if (!fk.refTable || fk.columns.length === 0 || fk.refColumns.length === 0) continue
    lines.push('  ' + foreignKeyClause(fk, driver))
  }

  return `CREATE TABLE ${qualified} (\n${lines.join(',\n')}\n);`
}

export function buildCreateDatabase(
  driver: Driver,
  name: string,
  opts: { encoding?: string; collation?: string } = {}
): string {
  const ident = quoteIdent(name, driver)
  if (driver === 'mysql') {
    const charset = opts.encoding || 'utf8mb4'
    const collate = opts.collation || 'utf8mb4_unicode_ci'
    return `CREATE DATABASE ${ident} CHARACTER SET ${charset} COLLATE ${collate};`
  }
  const enc = opts.encoding || 'UTF8'
  return `CREATE DATABASE ${ident} ENCODING '${enc}';`
}

/** The constraint body shared by CREATE TABLE and ALTER TABLE ADD CONSTRAINT. */
export function foreignKeyClause(fk: ForeignKeySpec, driver: Driver): string {
  const cols = fk.columns.map((c) => quoteIdent(c, driver)).join(', ')
  const refCols = fk.refColumns.map((c) => quoteIdent(c, driver)).join(', ')
  const actions =
    (fk.onDelete && fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : '') +
    (fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : '')
  return `FOREIGN KEY (${cols}) REFERENCES ${quoteIdent(fk.refTable, driver)} (${refCols})${actions}`
}

export function buildCreateIndex(
  driver: Driver,
  schemaName: string,
  tableName: string,
  index: { name: string; columns: string[]; unique: boolean }
): string {
  const qualified =
    driver === 'postgres' && schemaName && schemaName !== 'public'
      ? `${quoteIdent(schemaName, driver)}.${quoteIdent(tableName, driver)}`
      : quoteIdent(tableName, driver)
  const cols = index.columns.map((c) => quoteIdent(c, driver)).join(', ')
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(index.name, driver)} ON ${qualified} (${cols});`
}

export function buildDropIndex(
  driver: Driver,
  schemaName: string,
  tableName: string,
  indexName: string
): string {
  // MySQL scopes DROP INDEX to a table; the others address it by name alone
  if (driver === 'mysql') {
    return `DROP INDEX ${quoteIdent(indexName, driver)} ON ${quoteIdent(tableName, driver)};`
  }
  const qualified =
    driver === 'postgres' && schemaName && schemaName !== 'public'
      ? `${quoteIdent(schemaName, driver)}.${quoteIdent(indexName, driver)}`
      : quoteIdent(indexName, driver)
  return `DROP INDEX ${qualified};`
}
