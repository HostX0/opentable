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

/** A column in the editor, carrying where it came from so renames are detectable. */
export interface EditableColumn extends ColumnDef {
  /** name in the database; absent means this column is new */
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

/** An index as edited in the UI. */
export interface EditableIndex {
  id: string
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  /** present when it already exists in the database */
  originalName?: string
  dropped?: boolean
}

/** A foreign key as edited in the UI. */
export interface EditableForeignKey extends ForeignKeySpec {
  id: string
  originalName?: string
  dropped?: boolean
}

export interface AlterStatement {
  sql: string
  kind: AlterKind
  /** may destroy or truncate existing data */
  destructive: boolean
  description: string
}

export interface AlterPlan {
  statements: AlterStatement[]
  warnings: string[]
  /** SQLite could not express a change directly and the table is rebuilt */
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

/** Full column definition, used where a dialect wants the whole thing restated. */
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

/**
 * SQLite cannot change a column's type, nullability or default in place, so the
 * table is rebuilt: new table, copy the rows across, swap the names. Wrapped in
 * a transaction with foreign keys suspended, which is the documented procedure.
 */
function sqliteRebuild(
  tableName: string,
  finalName: string,
  columns: EditableColumn[],
  foreignKeys: EditableForeignKey[] = []
): AlterStatement[] {
  const tmp = `${tableName}__opentable_new`
  const pk = columns.filter((c) => c.primaryKey && c.name.trim()).map((c) => c.name.trim())
  const createTmp = buildCreateTable('sqlite', 'main', tmp, columns, {
    primaryKey: pk.length ? pk : undefined,
    foreignKeys: foreignKeys.filter((f) => !f.dropped)
  }).replace(/;$/, '')

  // only columns that already existed can carry data over
  const carried = columns.filter((c) => c.originalName)
  const targetCols = carried.map((c) => quoteIdent(c.name.trim(), 'sqlite')).join(', ')
  const sourceCols = carried.map((c) => quoteIdent(c.originalName!, 'sqlite')).join(', ')

  return [
    { sql: 'PRAGMA foreign_keys = off;', kind: 'rebuild', destructive: false, description: 'Suspend foreign keys' },
    { sql: 'BEGIN TRANSACTION;', kind: 'rebuild', destructive: false, description: 'Start transaction' },
    { sql: `${createTmp};`, kind: 'rebuild', destructive: false, description: 'Create the new table' },
    {
      sql: `INSERT INTO ${quoteIdent(tmp, 'sqlite')} (${targetCols}) SELECT ${sourceCols} FROM ${quoteIdent(tableName, 'sqlite')};`,
      kind: 'rebuild',
      destructive: false,
      description: 'Copy the existing rows'
    },
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
    },
    { sql: 'COMMIT;', kind: 'rebuild', destructive: false, description: 'Commit' },
    { sql: 'PRAGMA foreign_keys = on;', kind: 'rebuild', destructive: false, description: 'Restore foreign keys' }
  ]
}

export interface AlterInput {
  driver: Driver
  schemaName: string
  originalName: string
  originalColumns: EditableColumn[]
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
  const added = usable.filter((c) => !c.originalName)
  const renamed = usable.filter((c) => c.originalName && c.originalName !== c.name.trim())
  const modified = usable.filter((c) => {
    if (!c.originalName) return false
    const before = originalColumns.find((o) => o.originalName === c.originalName)
    return before ? changed(before, c) : false
  })

  const tableRenamed = nextName.trim() !== originalName

  /* ————— primary key ————— */
  const beforePk = originalColumns.filter((c) => c.primaryKey).map((c) => c.originalName!)
  const afterPk = usable.filter((c) => c.primaryKey).map((c) => c.name.trim())
  const pkChanged =
    beforePk.length !== afterPk.length || beforePk.some((n, i) => n !== afterPk[i])

  /* ————— indexes & foreign keys ————— */
  const droppedIndexes = nextIndexes.filter((i) => i.originalName && i.dropped && !i.primary)
  const addedIndexes = nextIndexes.filter((i) => !i.originalName && !i.dropped && i.name.trim())
  const droppedFks = nextForeignKeys.filter((f) => f.originalName && f.dropped)
  const addedFks = nextForeignKeys.filter((f) => !f.originalName && !f.dropped && f.refTable)

  /* ————— SQLite: several changes have no in-place form ————— */
  const sqliteNeedsRebuild =
    driver === 'sqlite' && (modified.length > 0 || pkChanged || droppedFks.length > 0 || addedFks.length > 0)

  if (sqliteNeedsRebuild) {
    const reasons: string[] = []
    if (modified.length > 0) reasons.push('changing a column type, nullability or default')
    if (pkChanged) reasons.push('changing the primary key')
    if (addedFks.length || droppedFks.length) reasons.push('changing foreign keys')
    warnings.push(
      `SQLite cannot do ${reasons.join(' or ')} in place, so the table is rebuilt and the rows copied across.`
    )
    const rebuilt = sqliteRebuild(
      originalName,
      nextName.trim() || originalName,
      usable,
      nextForeignKeys
    )
    // indexes live outside the table, so they are re-applied after the swap
    for (const ix of droppedIndexes) {
      rebuilt.push({
        sql: buildDropIndex(driver, schemaName, nextName.trim() || originalName, ix.originalName!),
        kind: 'drop-index',
        destructive: false,
        description: `Drop index ${ix.originalName}`
      })
    }
    for (const ix of addedIndexes) {
      rebuilt.push({
        sql: buildCreateIndex(driver, schemaName, nextName.trim() || originalName, ix),
        kind: 'add-index',
        destructive: false,
        description: `Create index ${ix.name}`
      })
    }
    return { statements: rebuilt, warnings, rebuild: true }
  }

  /* ————— columns ————— */
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
      warnings.push(
        `${c.name} is NOT NULL with no default — this fails if the table already has rows.`
      )
    }
    statements.push({
      sql: `ALTER TABLE ${qualified} ADD COLUMN ${quoteIdent(c.name.trim(), driver)} ${spec};`,
      kind: 'add-column',
      destructive: false,
      description: `Add ${c.name}`
    })
  }

  if (driver === 'mysql') {
    // MySQL restates the whole definition; CHANGE also covers the rename
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
          if (!c.nullable) {
            warnings.push(`Setting ${c.name} NOT NULL fails if any existing row is NULL.`)
          }
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

  /* ————— primary key ————— */
  if (pkChanged && driver !== 'sqlite') {
    const cols = afterPk.map((c) => quoteIdent(c, driver)).join(', ')
    if (driver === 'mysql') {
      statements.push({
        sql: afterPk.length
          ? `ALTER TABLE ${qualified} DROP PRIMARY KEY, ADD PRIMARY KEY (${cols});`
          : `ALTER TABLE ${qualified} DROP PRIMARY KEY;`,
        kind: 'primary-key',
        destructive: true,
        description: afterPk.length ? `Set the primary key to ${afterPk.join(', ')}` : 'Drop the primary key'
      })
    } else {
      if (beforePk.length > 0) {
        statements.push({
          sql: `ALTER TABLE ${qualified} DROP CONSTRAINT ${quoteIdent(`${originalName}_pkey`, driver)};`,
          kind: 'primary-key',
          destructive: true,
          description: 'Drop the existing primary key'
        })
      }
      if (afterPk.length > 0) {
        statements.push({
          sql: `ALTER TABLE ${qualified} ADD PRIMARY KEY (${cols});`,
          kind: 'primary-key',
          destructive: false,
          description: `Set the primary key to ${afterPk.join(', ')}`
        })
      }
    }
    warnings.push('Changing the primary key fails if the new columns are not unique or contain NULL.')
  }

  /* ————— foreign keys ————— */
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

  /* ————— indexes ————— */
  for (const ix of droppedIndexes) {
    statements.push({
      sql: buildDropIndex(driver, schemaName, originalName, ix.originalName!),
      kind: 'drop-index',
      destructive: false,
      description: `Drop index ${ix.originalName}`
    })
  }
  for (const ix of addedIndexes) {
    statements.push({
      sql: buildCreateIndex(driver, schemaName, originalName, ix),
      kind: 'add-index',
      destructive: false,
      description: `Create ${ix.unique ? 'unique ' : ''}index ${ix.name}`
    })
  }

  /* ————— table rename last, so the statements above use the old name ————— */
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
