'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildCreateIndex,
  buildCreateTable,
  buildDropIndex,
  quoteIdent
} = require('../.test-dist/shared/sql.js')
const { buildAlterPlan } = require('../.test-dist/shared/alter.js')

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

test('SQLite keeps a single primary key inline', () => {
  const sql = buildCreateTable('sqlite', 'main', 'items', [
    column('id', 'INTEGER', { primaryKey: true, nullable: false }),
    column('name', 'TEXT')
  ])

  assert.match(sql, /"id" INTEGER PRIMARY KEY/)
  assert.doesNotMatch(sql, /PRIMARY KEY \("id"\)\s*\n/)
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
