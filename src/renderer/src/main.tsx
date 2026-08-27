import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import App from './App'

// Demo fallback when the renderer is opened outside Electron (plain browser):
// one fake connection with generated data, so the UI can be exercised end-to-end.
if (!window.opentable) {
  const demoConn = {
    id: 'demo',
    name: 'demo (browser)',
    driver: 'postgres' as const,
    host: 'localhost',
    port: 5432,
    user: 'demo',
    database: 'demo',
    environment: 'local' as const,
    hasPassword: false
  }
  const cols = [
    'id',
    'email',
    'full_name',
    'status',
    'total_orders',
    'lifetime_value',
    'created_at',
    'notes'
  ]
  const demoRows = Array.from({ length: 5000 }, (_, i) => [
    i + 1,
    `user${i + 1}@example.com`,
    `Customer Number ${i + 1}`,
    i % 3 === 0 ? 'active' : i % 3 === 1 ? 'inactive' : null,
    (i * 7) % 90,
    Math.round(i * 1234.567) / 100,
    new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
    i % 5 === 0 ? 'A long note field used to test overflow behaviour in the grid. ' : null
  ])
  const demoTables = ['customers', 'orders', 'products', 'invoices'].map((name) => ({
    schema: 'public',
    name,
    kind: 'table' as const,
    columns: cols.map((c) => ({
      name: c,
      dataType: c === 'id' ? 'integer' : 'text',
      nullable: c !== 'id',
      isPrimary: c === 'id'
    }))
  }))
  const notAvailable = { ok: false, error: 'Not available in browser preview' }
  window.opentable = {
    connections: {
      list: async () => [demoConn],
      save: async () => [demoConn],
      delete: async () => [demoConn],
      test: async () => ({ ok: true, serverVersion: 'demo' })
    },
    db: {
      connect: async () => ({ ok: true, serverVersion: 'PostgreSQL 16 (demo)' }),
      disconnect: async () => undefined,
      query: async () => ({
        ok: true,
        result: {
          sets: [
            {
              columns: cols,
              rows: demoRows,
              rowCount: demoRows.length,
              sourceTable: { schema: 'public', name: 'customers' },
              primaryKey: ['id']
            }
          ],
          elapsedMs: 12
        }
      }),
      cancel: async () => ({ ok: true }),
      schema: async () => ({ ok: true, schema: { database: 'demo', tables: demoTables } }),
      tableDetails: async (_id: string, schemaName: string, table: string) => ({
        ok: true,
        details: {
          schema: schemaName,
          name: table,
          kind: 'table' as const,
          columns: demoTables[0].columns,
          indexes: [
            { name: `${table}_pkey`, columns: ['id'], unique: true, primary: true },
            { name: `${table}_email_idx`, columns: ['email'], unique: true, primary: false }
          ],
          foreignKeys: [
            {
              name: `${table}_owner_fkey`,
              columns: ['id'],
              refSchema: 'public',
              refTable: 'orders',
              refColumns: ['customer_id']
            }
          ],
          rowCount: demoRows.length,
          ddl: `CREATE TABLE ${table} (\n  id integer PRIMARY KEY,\n  email text NOT NULL\n);`
        }
      }),
      databases: async () => ({ ok: true, databases: ['demo', 'analytics', 'staging'] }),
      useDatabase: async () => ({ ok: true }),
      applyChanges: async () => ({ ok: true, affected: 1, statements: [] }),
      alterTable: async () => ({ ok: true, applied: 1 })
    },
    safety: {
      check: async () => ({
        needsConfirm: false,
        isProduction: false,
        unscoped: [],
        connectionName: 'demo'
      })
    },
    history: {
      list: async () => [],
      clear: async () => undefined
    },
    saved: {
      list: async () => [],
      save: async () => [],
      delete: async () => []
    },
    settings: {
      get: async () => ({
        defaultRowLimit: 500,
        confirmDestructive: true,
        hasAiKey: true,
        aiModel: 'claude-sonnet-5'
      }),
      update: async () => ({
        defaultRowLimit: 500,
        confirmDestructive: true,
        hasAiKey: false,
        aiModel: 'claude-sonnet-5'
      })
    },
    ai: {
      generate: async () => {
        await new Promise((r) => setTimeout(r, 700))
        return {
          ok: true,
          sql: "SELECT c.full_name, SUM(o.total) AS revenue\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nGROUP BY c.full_name\nORDER BY revenue DESC\nLIMIT 10;",
          explanation: 'Sums each customer\u2019s order totals and returns the ten highest.'
        }
      },
      explain: async () => {
        await new Promise((r) => setTimeout(r, 600))
        return { ok: true, explanation: 'Reads every column from customers, capped at 100 rows.' }
      },
      fix: async () => notAvailable
    },
    ssh: {
      hosts: async () => [
        { alias: 'bastion', hostName: '10.0.0.4', port: 22, user: 'ubuntu', identityFile: '/Users/demo/.ssh/id_ed25519' },
        { alias: 'prod-jump', hostName: 'jump.example.com', port: 2222, user: 'deploy' }
      ]
    },
    files: {
      pickSqlite: async () => null,
      pickKey: async () => null,
      export: async () => ({ ok: false })
    },
    updates: {
      check: async () => ({ status: 'none' as const, version: '0.1.0' }),
      state: async () => ({ status: 'none' as const, version: '0.1.0' }),
      install: async () => undefined,
      onState: () => () => undefined
    },
    platform: 'darwin'
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
