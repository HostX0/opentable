'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCreateIndex,
  buildCreateTable,
  buildDropIndex,
  quoteIdent
} = require('../.test-dist/shared/sql.js')
const {
  buildAlterPlan,
  rewriteSqliteIndexDefinition
} = require('../.test-dist/shared/alter.js')

function column(name, type, overrides = {}) {
  return {
    id: name,
    name,
    type,
    nullable: true,
    primaryKey: false,
    unique: false,
    defaultValue: '',
    ...overrides
  }
}

test('quoteIdent safely escapes identifiers for each dialect', () => {
  assert.equal(quoteIdent('odd"name', 'postgres'), '"odd""name"')
  assert.equal(quoteIdent('odd`name', 'mysql'), '`odd``name`')
  assert.equal(quoteIdent('odd"name', 'sqlite'), '"odd""name"')
})

test('MySQL CREATE TABLE emits real table-level foreign keys', () => {
  const sql = buildCreateTable(
    'mysql',
    '',
    'orders',
    [
      column('id', 'BIGINT', { primaryKey: true, nullable: false }),
      column('user_id', 'BIGINT', {
        references: {
          table: 'users',
          column: 'id',
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION'
        }
      })
    ]
  )

  assert.match(sql, /PRIMARY KEY \(`id`\)/)
  assert.match(sql, /FOREIGN KEY \(`user_id`\) REFERENCES `users` \(`id`\) ON DELETE CASCADE/)
  assert.doesNotMatch(sql, /`user_id` BIGINT REFERENCES/)
})

test('SQLite keeps the primary key selected by table constraints inline', () => {
  const sql = buildCreateTable(
    'sqlite',
    'main',
    'items',
    [
      column('old_id', 'INTEGER', { primaryKey: false, nullable: false }),
      column('id', 'INTEGER', { primaryKey: false, nullable: false })
    ],
    { primaryKey: ['id'] }
  )

  assert.match(sql, /"id" INTEGER PRIMARY KEY/)
  assert.doesNotMatch(sql, /"old_id" INTEGER PRIMARY KEY/)
})

test('named table constraints are retained in CREATE TABLE', () => {
  const sql = buildCreateTable(
    'sqlite',
    'main',
    'orders',
    [column('user_id', 'INTEGER')],
    {
      uniques: [{ name: 'orders_user_uq', columns: ['user_id'] }],
      foreignKeys: [
        {
          name: 'orders_user_fk',
          columns: ['user_id'],
          refTable: 'users',
          refColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'SET DEFAULT'
        }
      ]
    }
  )
  assert.match(sql, /CONSTRAINT "orders_user_uq" UNIQUE \("user_id"\)/)
  assert.match(sql, /CONSTRAINT "orders_user_fk" FOREIGN KEY/)
  assert.match(sql, /ON DELETE CASCADE ON UPDATE SET DEFAULT/)
})

test('index builders follow dialect-specific qualification rules', () => {
  assert.equal(
    buildCreateIndex('postgres', 'audit', 'events', {
      name: 'events_created_idx',
      columns: ['created_at'],
      unique: false
    }),
    'CREATE INDEX "events_created_idx" ON "audit"."events" ("created_at");'
  )
  assert.equal(
    buildDropIndex('mysql', '', 'events', 'events_created_idx'),
    'DROP INDEX `events_created_idx` ON `events`;'
  )
})

test('PostgreSQL alter plans keep rename and type changes explicit', () => {
  const before = [
    column('age', 'integer', {
      originalName: 'age',
      nullable: true
    })
  ]
  const after = [
    column('age_years', 'bigint', {
      originalName: 'age',
      nullable: false
    })
  ]

  const plan = buildAlterPlan({
    driver: 'postgres',
    schemaName: 'public',
    originalName: 'people',
    originalColumns: before,
    nextName: 'people',
    nextColumns: after
  })

  assert.equal(plan.rebuild, false)
  assert.ok(plan.statements.some((s) => s.sql.includes('RENAME COLUMN "age" TO "age_years"')))
  assert.ok(plan.statements.some((s) => s.sql.includes('ALTER COLUMN "age_years" TYPE bigint')))
  assert.ok(plan.statements.some((s) => s.sql.includes('ALTER COLUMN "age_years" SET NOT NULL')))
  assert.ok(plan.warnings.some((w) => w.includes('NOT NULL')))
})

test('PostgreSQL primary-key edits use the introspected constraint name', () => {
  const before = [column('id', 'bigint', { originalName: 'id', primaryKey: true, nullable: false })]
  const after = [column('code', 'text', { originalName: 'code', primaryKey: true, nullable: false })]
  const original = [...before, column('code', 'text', { originalName: 'code', nullable: false })]

  const plan = buildAlterPlan({
    driver: 'postgres',
    schemaName: 'public',
    originalName: 'people',
    primaryKeyName: 'people_identity_key',
    originalColumns: original,
    nextName: 'people',
    nextColumns: after
  })

  assert.ok(plan.statements.some((s) => s.sql.includes('DROP CONSTRAINT "people_identity_key"')))
  assert.ok(plan.statements.some((s) => s.sql.includes('ADD PRIMARY KEY ("code")')))
})

test('renaming a primary-key column does not rebuild the primary key', () => {
  const before = [column('id', 'integer', { originalName: 'id', primaryKey: true, nullable: false })]
  const after = [column('record_id', 'integer', { originalName: 'id', primaryKey: true, nullable: false })]
  const plan = buildAlterPlan({
    driver: 'postgres',
    schemaName: 'public',
    originalName: 'records',
    originalColumns: before,
    nextName: 'records',
    nextColumns: after
  })
  assert.equal(plan.statements.filter((s) => s.kind === 'primary-key').length, 0)
  assert.ok(plan.statements.some((s) => s.kind === 'rename-column'))
})

test('MySQL drops dependent indexes before dropping a column', () => {
  const before = [column('legacy', 'INT', { originalName: 'legacy' })]
  const plan = buildAlterPlan({
    driver: 'mysql',
    schemaName: '',
    originalName: 'people',
    originalColumns: before,
    nextName: 'people',
    nextColumns: [],
    nextIndexes: [
      {
        id: 'db:legacy_idx',
        name: 'legacy_idx',
        originalName: 'legacy_idx',
        columns: ['legacy'],
        unique: false,
        primary: false
      }
    ]
  })
  const dropIndex = plan.statements.findIndex((s) => s.kind === 'drop-index')
  const dropColumn = plan.statements.findIndex((s) => s.kind === 'drop-column')
  assert.ok(dropIndex >= 0 && dropIndex < dropColumn)
})

test('MySQL column renames restate the full definition with CHANGE COLUMN', () => {
  const before = [column('old_name', 'VARCHAR(255)', { originalName: 'old_name' })]
  const after = [column('new_name', 'VARCHAR(255)', { originalName: 'old_name' })]

  const plan = buildAlterPlan({
    driver: 'mysql',
    schemaName: '',
    originalName: 'people',
    originalColumns: before,
    nextName: 'people',
    nextColumns: after
  })

  assert.equal(plan.statements.length, 1)
  assert.match(plan.statements[0].sql, /CHANGE COLUMN `old_name` `new_name` VARCHAR\(255\)/)
})

test('SQLite type changes route through a transactional rebuild', () => {
  const before = [column('value', 'TEXT', { originalName: 'value' })]
  const after = [column('value', 'INTEGER', { originalName: 'value' })]

  const plan = buildAlterPlan({
    driver: 'sqlite',
    schemaName: 'main',
    originalName: 'settings',
    originalColumns: before,
    nextName: 'settings',
    nextColumns: after
  })

  assert.equal(plan.rebuild, true)
  assert.ok(plan.statements.some((s) => s.sql === 'BEGIN TRANSACTION;'))
  assert.ok(plan.statements.some((s) => s.sql === 'DROP TABLE "settings";'))
  assert.ok(plan.statements.some((s) => s.sql === 'COMMIT;'))
  assert.ok(plan.warnings.some((w) => w.includes('table is rebuilt')))
})

test('SQLite rebuild preserves FK actions, unique constraints and explicit indexes', () => {
  const before = [
    column('id', 'INTEGER', { originalName: 'id', primaryKey: true, nullable: false }),
    column('owner_id', 'INTEGER', { originalName: 'owner_id' })
  ]
  const after = [
    column('id', 'INTEGER', { originalName: 'id', primaryKey: true, nullable: false }),
    column('account_id', 'INTEGER', { originalName: 'owner_id', nullable: false })
  ]
  const plan = buildAlterPlan({
    driver: 'sqlite',
    schemaName: 'main',
    originalName: 'orders',
    originalColumns: before,
    nextName: 'orders',
    nextColumns: after,
    nextForeignKeys: [
      {
        id: 'db:fk_0',
        originalName: 'fk_0',
        name: 'fk_0',
        columns: ['owner_id'],
        refTable: 'users',
        refColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'SET DEFAULT'
      }
    ],
    nextIndexes: [
      {
        id: 'db:sqlite_autoindex_orders_1',
        name: 'sqlite_autoindex_orders_1',
        originalName: 'sqlite_autoindex_orders_1',
        columns: ['owner_id'],
        unique: true,
        primary: false,
        origin: 'u'
      },
      {
        id: 'db:orders_owner_active_idx',
        name: 'orders_owner_active_idx',
        originalName: 'orders_owner_active_idx',
        columns: ['owner_id'],
        unique: false,
        primary: false,
        origin: 'c',
        definition: "CREATE INDEX orders_owner_active_idx ON orders(owner_id) WHERE owner_id > 0"
      }
    ]
  })

  assert.equal(plan.rebuild, true)
  const all = plan.statements.map((s) => s.sql).join('\n')
  assert.match(all, /UNIQUE \("account_id"\)/)
  assert.match(all, /FOREIGN KEY \("account_id"\).*ON DELETE CASCADE ON UPDATE SET DEFAULT/)
  assert.match(all, /CREATE INDEX orders_owner_active_idx ON orders\(account_id\) WHERE account_id > 0;/)
  const indexAt = plan.statements.findIndex((s) => s.sql.includes('orders_owner_active_idx'))
  const commitAt = plan.statements.findIndex((s) => s.sql === 'COMMIT;')
  assert.ok(indexAt >= 0 && indexAt < commitAt)
})

test('dropping a SQLite UNIQUE autoindex uses a rebuild, never DROP INDEX', () => {
  const before = [column('email', 'TEXT', { originalName: 'email' })]
  const plan = buildAlterPlan({
    driver: 'sqlite',
    schemaName: 'main',
    originalName: 'users',
    originalColumns: before,
    nextName: 'users',
    nextColumns: before,
    nextIndexes: [
      {
        id: 'db:sqlite_autoindex_users_1',
        name: 'sqlite_autoindex_users_1',
        originalName: 'sqlite_autoindex_users_1',
        columns: ['email'],
        unique: true,
        primary: false,
        origin: 'u',
        dropped: true
      }
    ]
  })
  assert.equal(plan.rebuild, true)
  assert.ok(!plan.statements.some((s) => /DROP INDEX/.test(s.sql)))
})

test('SQLite index rewriting changes identifiers but never string literals', () => {
  const sql = rewriteSqliteIndexDefinition(
    "CREATE INDEX idx_note ON orders(owner_id) WHERE note = 'owner_id orders'",
    'orders',
    'orders_archive',
    new Map([['owner_id', 'account_id']])
  )
  assert.equal(
    sql,
    "CREATE INDEX idx_note ON orders_archive(account_id) WHERE note = 'owner_id orders';"
  )
})

test('adding a required column without a default is called out before execution', () => {
  const plan = buildAlterPlan({
    driver: 'postgres',
    schemaName: 'public',
    originalName: 'people',
    originalColumns: [],
    nextName: 'people',
    nextColumns: [column('email', 'text', { nullable: false })]
  })

  assert.ok(plan.warnings.some((w) => w.includes('NOT NULL with no default')))
})
