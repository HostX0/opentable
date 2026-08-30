import type { Driver, SchemaColumn } from './types'
import {
  buildCreateIndex,
  buildCreateTable,
  buildDropIndex,
  foreignKeyClause,
  quoteIdent,
  type ColumnDef,
  type ForeignKeySpec
} from './sql'

export interface EditableColumn extends ColumnDef {
  originalName?: string
}

export type AlterKind =
  | 'rename-table'
  | 'add-column'
  | 'drop-column'
  | 'rename-column'
  | 'modify-column'
  | 'primary-key'
  | 'add-index'
  | 'drop-index'
  | 'add-foreign-key'
  | 'drop-foreign-key'
  | 'rebuild'

export interface EditableIndex {
  id: string
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  originalName?: string
  /** SQLite pragma index_list origin: c=create index, u=unique constraint, pk=primary key. */
  origin?: string
  /** Raw CREATE INDEX SQL when the server exposes it. */
  definition?: string
  dropped?: boolean
}

export interface EditableForeignKey extends ForeignKeySpec {
  id: string
  originalName?: string
  dropped?: boolean
}

export interface AlterStatement {
  sql: string
  kind: AlterKind
  destructive: boolean
  description: string
}

export interface AlterPlan {
  statements: AlterStatement[]
  warnings: string[]
  rebuild: boolean
}

export function toEditable(columns: SchemaColumn[]): EditableColumn[] {
  return columns.map((c) => ({
    id: `db:${c.name}`,
    name: c.name,
    originalName: c.name,
    type: c.dataType,
    nullable: c.nullable,
    primaryKey: c.isPrimary,
    unique: false,
    defaultValue: c.defaultValue ?? ''
  }))
}

function columnSpec(c: EditableColumn): string {
  const bits = [c.type]
  if (!c.nullable) bits.push('NOT NULL')
  if (c.defaultValue.trim()) bits.push(`DEFAULT ${c.defaultValue.trim()}`)
  return bits.join(' ')
}

function changed(before: EditableColumn, after: EditableColumn): boolean {
  return (
    before.type.trim().toLowerCase() !== after.type.trim().toLowerCase() ||
    before.nullable !== after.nullable ||
    (before.defaultValue ?? '').trim() !== (after.defaultValue ?? '').trim()
  )
}

function quoteWithStyle(name: string, quote: '"' | '`' | '['): string {
  if (quote === '[') return '[' + name.replace(/]/g, ']]') + ']'
  return quote + name.replace(new RegExp(quote, 'g'), quote + quote) + quote
}

function quotedTokenEnd(sql: string, start: number, quote: '"' | '`' | '['): number {
  const close = quote === '[' ? ']' : quote
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] === close) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

function stringEnd(sql: string, start: number): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

/**
 * SQLite stores exact CREATE INDEX SQL in sqlite_schema. Keep it exact across a
 * table rebuild while rewriting only the table token after ON and renamed
 * column identifiers after that point. Strings and the index name are untouched.
 */
export function rewriteSqliteIndexDefinition(
  definition: string,
  tableName: string,
  finalName: string,
  renames: Map<string, string>
): string {
  const sql = definition.trim().replace(/;\s*$/, '')
  let out = ''
  let i = 0
  let sawOn = false
  let tableSeen = false

  const replacementFor = (name: string, isFunction: boolean): string | null => {
    if (sawOn && !tableSeen && name.toLowerCase() === tableName.toLowerCase()) {
      tableSeen = true
      return finalName
    }
    if (tableSeen && !isFunction) {
      for (const [before, after] of renames) {
        if (name.toLowerCase() === before.toLowerCase()) return after
      }
    }
    return null
  }

  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") {
      const end = stringEnd(sql, i)
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const quote = ch as '"' | '`' | '['
      const end = quotedTokenEnd(sql, i, quote)
      const raw = sql.slice(i, end)
      const value =
        quote === '['
          ? raw.slice(1, -1).replace(/]]/g, ']')
          : raw.slice(1, -1).replace(new RegExp(`${quote}${quote}`, 'g'), quote)
      let j = end
      while (/\s/.test(sql[j] ?? '')) j++
      const replacement = replacementFor(value, tableSeen && sql[j] === '(')
      out += replacement ? quoteWithStyle(replacement, quote) : raw
      i = end
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i
      i++
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++
      const word = sql.slice(start, i)
      if (!sawOn && word.toLowerCase() === 'on') sawOn = true
      let j = i
      while (/\s/.test(sql[j] ?? '')) j++
      const replacement = replacementFor(word, tableSeen && sql[j] === '(')
      out += replacement ?? word
      continue
    }
    out += ch
    i++
  }
  return out + ';'
}

function mappedName(name: string, renames: Map<string, string>): string {
  for (const [before, after] of renames) {
    if (name.toLowerCase() === before.toLowerCase()) return after
  }
  return name
}

function sqliteRebuild(
  tableName: string,
  finalName: string,
  columns: EditableColumn[],
  foreignKeys: EditableForeignKey[],
  indexes: EditableIndex[],
  warnings: string[]
): AlterStatement[] {
  const tmp = `${tableName}__opentable_new`
  const renames = new Map(
    columns
      .filter((c) => c.originalName && c.originalName !== c.name.trim())
      .map((c) => [c.originalName!, c.name.trim()] as const)
  )
  const pk = columns.filter((c) => c.primaryKey && c.name.trim()).map((c) => c.name.trim())

  const activeFks: ForeignKeySpec[] = foreignKeys
    .filter((f) => !f.dropped)
    .map((f) => ({
      name: f.name,
      columns: f.columns.map((c) => mappedName(c, renames)),
      refTable: f.refTable === tableName ? finalName : f.refTable,
      refColumns:
        f.refTable === tableName ? f.refColumns.map((c) => mappedName(c, renames)) : f.refColumns,
      onDelete: f.onDelete,
      onUpdate: f.onUpdate
    }))

  const uniqueConstraints = indexes
    .filter((i) => !i.dropped && !i.primary && i.origin === 'u')
    .filter((i) => i.columns.length > 0)
    .map((i) => ({ columns: i.columns.map((c) => mappedName(c, renames)) }))

  const createTmp = buildCreateTable('sqlite', 'main', tmp, columns, {
    primaryKey: pk.length ? pk : undefined,
    foreignKeys: activeFks,
    uniques: uniqueConstraints
  }).replace(/;$/, '')

  const carried = columns.filter((c) => c.originalName)
  const targetCols = carried.map((c) => quoteIdent(c.name.trim(), 'sqlite')).join(', ')
  const sourceCols = carried.map((c) => quoteIdent(c.originalName!, 'sqlite')).join(', ')

  const statements: AlterStatement[] = [
    {
      sql: 'PRAGMA foreign_keys = off;',
      kind: 'rebuild',
      destructive: false,
      description: 'Suspend foreign keys'
    },
    {
      sql: 'BEGIN TRANSACTION;',
      kind: 'rebuild',
      destructive: false,
      description: 'Start transaction'
    },
    {
      sql: `${createTmp};`,
      kind: 'rebuild',
      destructive: false,
      description: 'Create the new table'
    }
  ]

  if (carried.length > 0) {
    statements.push({
      sql: `INSERT INTO ${quoteIdent(tmp, 'sqlite')} (${targetCols}) SELECT ${sourceCols} FROM ${quoteIdent(tableName, 'sqlite')};`,
      kind: 'rebuild',
      destructive: false,
      description: 'Copy the existing rows'
    })
  } else {
    warnings.push('No existing columns remain, so existing rows cannot be copied into the rebuilt table.')
  }

  statements.push(
    {
      sql: `DROP TABLE ${quoteIdent(tableName, 'sqlite')};`,
      kind: 'rebuild',
      destructive: true,
      description: 'Drop the old table'
    },
    {
      sql: `ALTER TABLE ${quoteIdent(tmp, 'sqlite')} RENAME TO ${quoteIdent(finalName, 'sqlite')};`,
      kind: 'rebuild',
      destructive: false,
      description: 'Put the new table in its place'
    }
  )

  // A table rebuild drops every external index. Recreate every active explicit
  // index inside the same transaction; unique constraints were rebuilt above.
  for (const ix of indexes.filter((i) => !i.dropped && !i.primary && i.origin !== 'u')) {
    if (!ix.name.trim()) continue
    let sql = ''
    if (ix.definition?.trim()) {
      sql = rewriteSqliteIndexDefinition(ix.definition, tableName, finalName, renames)
    } else if (ix.columns.length > 0 && ix.columns.every(Boolean)) {
      sql = buildCreateIndex('sqlite', 'main', finalName, {
        ...ix,
        columns: ix.columns.map((c) => mappedName(c, renames))
      })
    } else {
      warnings.push(`Index ${ix.name} could not be recreated automatically because its definition is unavailable.`)
      continue
    }
    statements.push({
      sql,
      kind: 'add-index',
      destructive: false,
      description: `Recreate index ${ix.name}`
    })
  }

  statements.push(
    { sql: 'COMMIT;', kind: 'rebuild', destructive: false, description: 'Commit' },
    {
      sql: 'PRAGMA foreign_keys = on;',
      kind: 'rebuild',
      destructive: false,
      description: 'Restore foreign keys'
    }
  )
  return statements
}

export interface AlterInput {
  driver: Driver
  schemaName: string
  originalName: string
  originalColumns: EditableColumn[]
  /** Actual constraint name from introspection. PostgreSQL does not require table_pkey. */
  primaryKeyName?: string
  nextName: string
  nextColumns: EditableColumn[]
  nextIndexes?: EditableIndex[]
  nextForeignKeys?: EditableForeignKey[]
}

export function buildAlterPlan(input: AlterInput): AlterPlan {
  const {
    driver,
    schemaName,
    originalName,
    originalColumns,
    primaryKeyName,
    nextName,
    nextColumns,
    nextIndexes = [],
    nextForeignKeys = []
  } = input
  const statements: AlterStatement[] = []
  const warnings: string[] = []

  const qualified =
    driver === 'postgres' && schemaName && schemaName !== 'public'
      ? `${quoteIdent(schemaName, driver)}.${quoteIdent(originalName, driver)}`
      : quoteIdent(originalName, driver)

  const usable = nextColumns.filter((c) => c.name.trim())
  const keptOriginals = new Set(usable.map((c) => c.originalName).filter(Boolean) as string[])
  const dropped = originalColumns.filter((c) => !keptOriginals.has(c.originalName!))
  const droppedNames = new Set(dropped.map((c) => c.originalName!.toLowerCase()))
  const added = usable.filter((c) => !c.originalName)
  const renamed = usable.filter((c) => c.originalName && c.originalName !== c.name.trim())
  const modified = usable.filter((c) => {
    if (!c.originalName) return false
    const before = originalColumns.find((o) => o.originalName === c.originalName)
    return before ? changed(before, c) : false
  })

  const tableRenamed = nextName.trim() !== originalName

  const beforePk = originalColumns.filter((c) => c.primaryKey).map((c) => c.originalName!)
  const afterPk = usable.filter((c) => c.primaryKey).map((c) => c.name.trim())
  // Compare stable column identities so merely renaming a PK column does not
  // cause a pointless drop/recreate; databases update constraints on rename.
  const afterPkOriginal = usable
    .filter((c) => c.primaryKey)
    .map((c) => c.originalName ?? `new:${c.name.trim()}`)
  const pkChanged =
    beforePk.length !== afterPkOriginal.length ||
    beforePk.some((n, i) => n !== afterPkOriginal[i])

  const dependsOnDroppedColumn = (columns: string[]): boolean =>
    columns.some((c) => droppedNames.has(c.toLowerCase()))

  const droppedIndexes = nextIndexes.filter(
    (i) => i.originalName && !i.primary && (i.dropped || dependsOnDroppedColumn(i.columns))
  )
  const addedIndexes = nextIndexes.filter((i) => !i.originalName && !i.dropped && i.name.trim())
  const droppedFks = nextForeignKeys.filter(
    (f) => f.originalName && (f.dropped || dependsOnDroppedColumn(f.columns))
  )
  const addedFks = nextForeignKeys.filter((f) => !f.originalName && !f.dropped && f.refTable)
  const droppedUniqueConstraint = droppedIndexes.some((i) => i.origin === 'u')

  const sqliteNeedsRebuild =
    driver === 'sqlite' &&
    (modified.length > 0 ||
      pkChanged ||
      droppedFks.length > 0 ||
      addedFks.length > 0 ||
      droppedUniqueConstraint)

  if (sqliteNeedsRebuild) {
    const reasons: string[] = []
    if (modified.length > 0) reasons.push('changing a column type, nullability or default')
    if (pkChanged) reasons.push('changing the primary key')
    if (addedFks.length || droppedFks.length) reasons.push('changing foreign keys')
    if (droppedUniqueConstraint) reasons.push('removing a UNIQUE constraint')
    warnings.push(
      `SQLite cannot do ${reasons.join(' or ')} in place, so the table is rebuilt and the rows copied across.`
    )
    return {
      statements: sqliteRebuild(
        originalName,
        nextName.trim() || originalName,
        usable,
        nextForeignKeys,
        nextIndexes,
        warnings
      ),
      warnings,
      rebuild: true
    }
  }

  // Constraints/indexes that depend on a removed column must go first. This is
  // especially important on MySQL, which otherwise rejects DROP COLUMN.
  for (const fk of droppedFks) {
    statements.push({
      sql:
        driver === 'mysql'
          ? `ALTER TABLE ${qualified} DROP FOREIGN KEY ${quoteIdent(fk.originalName!, driver)};`
          : `ALTER TABLE ${qualified} DROP CONSTRAINT ${quoteIdent(fk.originalName!, driver)};`,
      kind: 'drop-foreign-key',
      destructive: false,
      description: `Drop foreign key ${fk.originalName}`
    })
  }

  for (const ix of droppedIndexes) {
    statements.push({
      sql: buildDropIndex(driver, schemaName, originalName, ix.originalName!),
      kind: 'drop-index',
      destructive: false,
      description: `Drop index ${ix.originalName}`
    })
  }

  if (pkChanged && driver !== 'sqlite' && beforePk.length > 0) {
    statements.push({
      sql:
        driver === 'mysql'
          ? `ALTER TABLE ${qualified} DROP PRIMARY KEY;`
          : `ALTER TABLE ${qualified} DROP CONSTRAINT ${quoteIdent(primaryKeyName || `${originalName}_pkey`, driver)};`,
      kind: 'primary-key',
      destructive: true,
      description: 'Drop the existing primary key'
    })
  }

  for (const c of dropped) {
    statements.push({
      sql: `ALTER TABLE ${qualified} DROP COLUMN ${quoteIdent(c.originalName!, driver)};`,
      kind: 'drop-column',
      destructive: true,
      description: `Drop ${c.originalName} and everything in it`
    })
  }

  for (const c of added) {
    const spec = columnSpec(c)
    if (!c.nullable && !c.defaultValue.trim()) {
      warnings.push(`${c.name} is NOT NULL with no default — this fails if the table already has rows.`)
    }
    statements.push({
      sql: `ALTER TABLE ${qualified} ADD COLUMN ${quoteIdent(c.name.trim(), driver)} ${spec};`,
      kind: 'add-column',
      destructive: false,
      description: `Add ${c.name}`
    })
  }

  if (driver === 'mysql') {
    for (const c of usable) {
      if (!c.originalName) continue
      const isRenamed = c.originalName !== c.name.trim()
      const before = originalColumns.find((o) => o.originalName === c.originalName)
      const isModified = before ? changed(before, c) : false
      if (!isRenamed && !isModified) continue
      const spec = columnSpec(c)
      statements.push({
        sql: isRenamed
          ? `ALTER TABLE ${qualified} CHANGE COLUMN ${quoteIdent(c.originalName, driver)} ${quoteIdent(c.name.trim(), driver)} ${spec};`
          : `ALTER TABLE ${qualified} MODIFY COLUMN ${quoteIdent(c.name.trim(), driver)} ${spec};`,
        kind: isRenamed ? 'rename-column' : 'modify-column',
        destructive: isModified,
        description: isRenamed ? `Rename ${c.originalName} to ${c.name}` : `Change ${c.name}`
      })
    }
  } else {
    for (const c of renamed) {
      statements.push({
        sql: `ALTER TABLE ${qualified} RENAME COLUMN ${quoteIdent(c.originalName!, driver)} TO ${quoteIdent(c.name.trim(), driver)};`,
        kind: 'rename-column',
        destructive: false,
        description: `Rename ${c.originalName} to ${c.name}`
      })
    }

    if (driver === 'postgres') {
      for (const c of modified) {
        const before = originalColumns.find((o) => o.originalName === c.originalName)!
        const col = quoteIdent(c.name.trim(), driver)

        if (before.type.trim().toLowerCase() !== c.type.trim().toLowerCase()) {
          statements.push({
            sql: `ALTER TABLE ${qualified} ALTER COLUMN ${col} TYPE ${c.type} USING ${col}::${c.type};`,
            kind: 'modify-column',
            destructive: true,
            description: `Change ${c.name} from ${before.type} to ${c.type}`
          })
        }
        if (before.nullable !== c.nullable) {
          statements.push({
            sql: `ALTER TABLE ${qualified} ALTER COLUMN ${col} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`,
            kind: 'modify-column',
            destructive: !c.nullable,
            description: c.nullable ? `Allow NULL in ${c.name}` : `Require a value in ${c.name}`
          })
          if (!c.nullable) warnings.push(`Setting ${c.name} NOT NULL fails if any existing row is NULL.`)
        }
        if ((before.defaultValue ?? '').trim() !== (c.defaultValue ?? '').trim()) {
          statements.push({
            sql: c.defaultValue.trim()
              ? `ALTER TABLE ${qualified} ALTER COLUMN ${col} SET DEFAULT ${c.defaultValue.trim()};`
              : `ALTER TABLE ${qualified} ALTER COLUMN ${col} DROP DEFAULT;`,
            kind: 'modify-column',
            destructive: false,
            description: `Change the default for ${c.name}`
          })
        }
      }
    }
  }

  if (pkChanged && driver !== 'sqlite' && afterPk.length > 0) {
    const cols = afterPk.map((c) => quoteIdent(c, driver)).join(', ')
    statements.push({
      sql: `ALTER TABLE ${qualified} ADD PRIMARY KEY (${cols});`,
      kind: 'primary-key',
      destructive: false,
      description: `Set the primary key to ${afterPk.join(', ')}`
    })
    warnings.push('Changing the primary key fails if the new columns are not unique or contain NULL.')
  } else if (pkChanged && beforePk.length > 0) {
    warnings.push('Changing the primary key can affect foreign keys that reference this table.')
  }

  for (const fk of addedFks) {
    const name = fk.name?.trim() || `${nextName.trim() || originalName}_${fk.columns.join('_')}_fkey`
    statements.push({
      sql: `ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(name, driver)} ${foreignKeyClause(fk, driver)};`,
      kind: 'add-foreign-key',
      destructive: false,
      description: `Link ${fk.columns.join(', ')} to ${fk.refTable}`
    })
  }
  if (addedFks.length > 0) {
    warnings.push('Adding a foreign key fails if existing rows do not match the referenced table.')
  }

  for (const ix of addedIndexes) {
    statements.push({
      sql: buildCreateIndex(driver, schemaName, originalName, ix),
      kind: 'add-index',
      destructive: false,
      description: `Create ${ix.unique ? 'unique ' : ''}index ${ix.name}`
    })
  }

  if (tableRenamed && nextName.trim()) {
    statements.push({
      sql:
        driver === 'mysql'
          ? `RENAME TABLE ${qualified} TO ${quoteIdent(nextName.trim(), driver)};`
          : `ALTER TABLE ${qualified} RENAME TO ${quoteIdent(nextName.trim(), driver)};`,
      kind: 'rename-table',
      destructive: false,
      description: `Rename the table to ${nextName.trim()}`
    })
  }

  if (dropped.length > 0) {
    warnings.push(
      dropped.length === 1
        ? `Dropping ${dropped[0].originalName} permanently deletes its data.`
        : `Dropping ${dropped.length} columns permanently deletes their data.`
    )
  }

  return { statements, warnings, rebuild: false }
}
