'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseQueryPlan } = require('../.test-dist/shared/queryPlan.js')

function set(columns, rows) {
  return { columns, rows, rowCount: rows.length }
}

test('PostgreSQL plans flag large sequential scans and retain the plan tree', () => {
  const raw = JSON.stringify([
    {
      Plan: {
        'Node Type': 'Sort',
        'Plan Rows': 50000,
        'Total Cost': 9000,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            'Plan Rows': 300000,
            'Total Cost': 8000,
            Filter: '(status = 1)'
          }
        ]
      }
    }
  ])
  const plan = parseQueryPlan('postgres', set(['QUERY PLAN'], [[raw]]))
  assert.equal(plan.driver, 'postgres')
  assert.equal(plan.root.operation, 'Sort')
  assert.equal(plan.root.children[0].relation, 'orders')
  assert.ok(plan.findings.some((f) => f.title.includes('Sequential scan on orders')))
  assert.ok(plan.findings.some((f) => f.title === 'Large sort in the plan'))
  assert.equal(plan.executed, false)
})

test('MySQL plans flag access_type ALL and expose chosen indexes', () => {
  const raw = JSON.stringify({
    query_block: {
      nested_loop: [
        {
          table: {
            table_name: 'customers',
            access_type: 'ALL',
            rows_examined_per_scan: 150000,
            attached_condition: 'customers.active = 1'
          }
        },
        {
          table: {
            table_name: 'orders',
            access_type: 'ref',
            key: 'orders_customer_id_idx',
            rows_examined_per_scan: 4
          }
        }
      ]
    }
  })
  const plan = parseQueryPlan('mysql', set(['EXPLAIN'], [[raw]]))
  assert.equal(plan.root.operation, 'query')
  assert.equal(plan.root.children[1].index, 'orders_customer_id_idx')
  assert.ok(plan.findings.some((f) => f.title.includes('Full table scan on customers')))
})

test('SQLite plans distinguish indexed search from full scan and temporary sorting', () => {
  const plan = parseQueryPlan(
    'sqlite',
    set(
      ['id', 'parent', 'notused', 'detail'],
      [
        [2, 0, 0, 'SCAN users'],
        [5, 0, 0, 'SEARCH orders USING INDEX orders_user_idx (user_id=?)'],
        [9, 0, 0, 'USE TEMP B-TREE FOR ORDER BY']
      ]
    )
  )
  assert.ok(plan.findings.some((f) => f.title === 'Full scan on users'))
  assert.ok(plan.findings.some((f) => f.title === 'Temporary B-tree'))
  assert.ok(!plan.findings.some((f) => f.title.includes('Full scan on orders')))
})
