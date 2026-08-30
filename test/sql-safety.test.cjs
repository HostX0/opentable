'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { mainStatementWord, splitStatements } = require('../.test-dist/shared/sqlscan.js')
const {
  canAutoRun,
  isDestructive,
  isUnscopedWrite
} = require('../.test-dist/main/sqlutil.js')

test('splitStatements ignores semicolons in SQL literals and quoted identifiers', () => {
  assert.deepEqual(splitStatements("SELECT 'a;''b' AS value; SELECT 2;"), [
    "SELECT 'a;''b' AS value",
    'SELECT 2'
  ])
  assert.deepEqual(splitStatements('SELECT "odd;""name" FROM t; SELECT 2;'), [
    'SELECT "odd;""name" FROM t',
    'SELECT 2'
  ])
  assert.deepEqual(splitStatements('SELECT [odd;name] FROM t; SELECT 2;'), [
    'SELECT [odd;name] FROM t',
    'SELECT 2'
  ])
})

test('splitStatements understands PostgreSQL dollar quotes', () => {
  assert.deepEqual(splitStatements('SELECT $$semi; DELETE FROM users;$$ AS body; SELECT 2;'), [
    'SELECT $$semi; DELETE FROM users;$$ AS body',
    'SELECT 2'
  ])
  assert.deepEqual(
    splitStatements('SELECT $body$begin; perform 1; end$body$ AS body; SELECT 2;'),
    ['SELECT $body$begin; perform 1; end$body$ AS body', 'SELECT 2']
  )
})

test('splitStatements ignores nested comments and drops comment-only tails', () => {
  assert.deepEqual(
    splitStatements('SELECT 1 /* outer ; /* inner ; */ still ; */; -- trailing note'),
    ['SELECT 1 /* outer ; /* inner ; */ still ; */']
  )
  assert.deepEqual(splitStatements('SELECT 1; /* only a comment ; */'), ['SELECT 1'])
})

test('hash operators are never hidden as comments in the shared scanner', () => {
  assert.deepEqual(splitStatements("SELECT data #>> '{a}' FROM t; DROP TABLE t;"), [
    "SELECT data #>> '{a}' FROM t",
    'DROP TABLE t'
  ])
})

test('ambiguous backslash quoting fails closed instead of hiding a statement', () => {
  const statements = splitStatements("SELECT 'x\\'; DROP TABLE users;")
  assert.equal(statements.length, 2)
  assert.equal(canAutoRun(statements).autoRun, false)
})

test('mainStatementWord finds the outer verb after CTEs', () => {
  assert.equal(mainStatementWord('WITH x AS (SELECT 1) SELECT * FROM x')?.value, 'select')
  assert.equal(mainStatementWord('WITH x AS (SELECT 1) UPDATE t SET n = 1')?.value, 'update')
})

test('isDestructive sees leading comments and data-changing CTEs without flagging functions', () => {
  assert.equal(isDestructive('/* generated */ DELETE FROM users WHERE id = 1'), true)
  assert.equal(
    isDestructive('WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone'),
    true
  )
  assert.equal(isDestructive("SELECT 'delete from users' AS example"), false)
  assert.equal(isDestructive("SELECT replace(name, 'a', 'b') FROM users"), false)
  assert.equal(isDestructive('WITH x AS (SELECT 1) SELECT * FROM x'), false)
})

test('isUnscopedWrite only accepts a real top-level WHERE', () => {
  assert.equal(isUnscopedWrite("UPDATE users SET note = 'where'"), true)
  assert.equal(isUnscopedWrite('UPDATE users SET n = (SELECT 1 WHERE true)'), true)
  assert.equal(isUnscopedWrite('/* note */ DELETE FROM users'), true)
  assert.equal(isUnscopedWrite('UPDATE users SET n = 1 WHERE id = 7'), false)
  assert.equal(
    isUnscopedWrite('WITH ids AS (SELECT id FROM users WHERE active) DELETE FROM users WHERE id IN (SELECT id FROM ids)'),
    false
  )
})

test('AI auto-run allows only a single plainly read-only SELECT', () => {
  assert.equal(canAutoRun(splitStatements('SELECT 1')).autoRun, true)
  assert.equal(canAutoRun(splitStatements('WITH x AS (SELECT 1) SELECT * FROM x')).autoRun, true)
  assert.equal(canAutoRun(splitStatements('SELECT $$delete from users$$ AS text')).autoRun, true)
  assert.equal(canAutoRun(splitStatements("SELECT 'drop table users' AS text")).autoRun, true)
  assert.equal(canAutoRun(splitStatements("SELECT replace(name, 'a', 'b') FROM users")).autoRun, true)

  assert.equal(
    canAutoRun(splitStatements('WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone')).autoRun,
    false
  )
  assert.equal(canAutoRun(splitStatements('SELECT * INTO users_backup FROM users')).autoRun, false)
  assert.equal(canAutoRun(splitStatements('SELECT * FROM users FOR UPDATE')).autoRun, false)
  assert.equal(canAutoRun(splitStatements("SELECT nextval('orders_id_seq')")).autoRun, false)
  assert.equal(canAutoRun(splitStatements('SELECT pg_advisory_lock(42)')).autoRun, false)
  assert.equal(canAutoRun(splitStatements('SELECT 1; DROP TABLE users')).autoRun, false)
})
