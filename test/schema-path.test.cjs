'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  findRelationshipPath,
  buildRelationshipPathSql
} = require('../.test-dist/shared/schemaPath.js')

const relationships = [
  {
    name: 'orders_user_fk',
    sourceSchema: 'public',
    sourceTable: 'orders',
    sourceColumns: ['user_id'],
    targetSchema: 'public',
    targetTable: 'users',
    targetColumns: ['id']
  },
  {
    name: 'payments_order_fk',
    sourceSchema: 'public',
    sourceTable: 'payments',
    sourceColumns: ['order_id', 'tenant_id'],
    targetSchema: 'public',
    targetTable: 'orders',
    targetColumns: ['id', 'tenant_id']
  }
]

test('findRelationshipPath discovers the shortest path in either FK direction', () => {
  const path = findRelationshipPath(
    relationships,
    { schema: 'public', table: 'users' },
    { schema: 'public', table: 'payments' }
  )
  assert.equal(path.length, 2)
  assert.equal(path[0].toTable, 'orders')
  assert.equal(path[0].sourceToTarget, false)
  assert.equal(path[1].toTable, 'payments')
  assert.equal(path[1].sourceToTarget, false)
})

test('buildRelationshipPathSql produces a correct multi-hop composite JOIN', () => {
  const from = { schema: 'public', table: 'users' }
  const path = findRelationshipPath(relationships, from, {
    schema: 'public',
    table: 'payments'
  })
  const sql = buildRelationshipPathSql('postgres', from, path)
  assert.match(sql, /FROM "users" AS t0/)
  assert.match(sql, /JOIN "orders" AS t1/)
  assert.match(sql, /t0\."id" = t1\."user_id"/)
  assert.match(sql, /JOIN "payments" AS t2/)
  assert.match(sql, /t1\."id" = t2\."order_id"/)
  assert.match(sql, /t1\."tenant_id" = t2\."tenant_id"/)
})

test('unrelated tables return no path', () => {
  assert.equal(
    findRelationshipPath(relationships, { schema: 'public', table: 'users' }, { schema: 'public', table: 'logs' }),
    null
  )
})
