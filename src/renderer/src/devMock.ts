/**
 * A fake `window.opentable` so the renderer can be opened in a plain browser
 * during UI work, with no Electron and no database.
 *
 * Imported only under `import.meta.env.DEV`, so Vite drops it from the
 * production bundle entirely — an earlier version of this lived in main.tsx
 * and shipped to users, which is what this arrangement exists to prevent.
 */
import type { ChatMessage, ChatSession, ChatTurn } from '../../shared/types'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

const cols = ['id', 'email', 'full_name', 'status', 'total_orders', 'created_at']
const demoRows = Array.from({ length: 5000 }, (_, i) => [
  i + 1,
  `user${i + 1}@example.com`,
  `Customer ${i + 1}`,
  i % 3 === 0 ? 'active' : i % 3 === 1 ? 'inactive' : null,
  (i * 7) % 90,
  new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString()
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

/**
 * Scripted chat, so every visual state can be exercised without a model:
 * a read-only query that ran, then a write that stops for approval.
 */
async function fakeChat(_id: string, transcript: ChatMessage[]): Promise<ChatTurn> {
  await wait(700)
  const last = transcript[transcript.length - 1]?.content.toLowerCase() ?? ''
  const asksToWrite = /delete|drop|update|insert|remove/.test(last)

  if (asksToWrite) {
    const adding = /insert|add|create/.test(last)
    const sql = adding
      ? "INSERT INTO public.users (id, phone, name, created_at, avatar_url)\nVALUES (\n  'user_' || gen_random_uuid()::text,\n  '+1' || LPAD((random() * 9000000000)::bigint::text, 10, '0'),\n  'User ' || FLOOR(random() * 10000)::text,\n  now(),\n  'https://api.dicebear.com/7.x/avataaars/svg?seed=' || gen_random_uuid()::text\n);"
      : "DELETE FROM customers WHERE status = 'inactive'"
    return {
      reply: '',
      queries: [],
      pending: {
        sql,
        autoRun: false,
        reason: `${adding ? 'INSERT' : 'DELETE'} changes the database`,
        status: 'awaiting-approval'
      },
      transcript: [...transcript, { role: 'assistant', content: 'proposing a write' }]
    }
  }

  // emit the answer token by token so the preview shows the real streaming UI
  const answer = [
    'This is a multi-purpose application database with several distinct areas:',
    '',
    '**Admin Management:**',
    '- `admin_users` - Admin accounts with authentication (passwords, TOTP 2FA)',
    '- `admin_roles` - Role-based access control with permissions',
    '- `admin_audit_log` - Comprehensive audit trail of admin actions',
    '',
    '**User & Booking:**',
    '- `users` - Customer accounts (phone, name, avatar)',
    '- `orders` - Travel/booking orders with payment info and provider details',
    '',
    'The core use case appears to be a **travel booking platform** where customers',
    'create orders and manage passenger information.'
  ].join('\n')
  for (const word of answer.split(' ')) {
    devDelta?.(word + ' ')
    await wait(35)
  }

  return {
    reply: answer,
    queries: [
      {
        sql: 'SELECT status, count(*) FROM customers GROUP BY status',
        autoRun: true,
        status: 'ran',
        columns: ['status', 'count'],
        rows: [
          ['active', 1667],
          ['inactive', 1667],
          [null, 1666]
        ],
        rowCount: 3
      }
    ],
    transcript: [...transcript, { role: 'assistant', content: 'answered' }]
  }
}

/** Session store for the preview, in memory only. */
let devChats: ChatSession[] = []
let devDelta: ((text: string) => void) | null = null

export function installDevMock(): void {
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
          indexes: [{ name: `${table}_pkey`, columns: ['id'], unique: true, primary: true }],
          foreignKeys: [],
          rowCount: demoRows.length,
          ddl: `CREATE TABLE ${table} (\n  id integer PRIMARY KEY\n);`
        }
      }),
      databases: async () => ({ ok: true, databases: ['demo', 'analytics'] }),
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
    history: { list: async () => [], clear: async () => undefined },
    saved: { list: async () => [], save: async () => [], delete: async () => [] },
    settings: {
      get: async () => ({
        defaultRowLimit: 500,
        confirmDestructive: true,
        hasAiKey: true,
        aiProvider: 'anthropic' as const,
        aiBaseUrl: '',
        aiModel: 'claude-sonnet-5'
      }),
      update: async () => ({
        defaultRowLimit: 500,
        confirmDestructive: true,
        hasAiKey: true,
        aiProvider: 'anthropic' as const,
        aiBaseUrl: '',
        aiModel: 'claude-sonnet-5'
      })
    },
    ai: {
      generate: async () => {
        await wait(600)
        return { ok: true, sql: 'SELECT * FROM customers LIMIT 10;' }
      },
      explain: async () => {
        await wait(500)
        return { ok: true, explanation: 'Reads every column from customers, capped at 100 rows.' }
      },
      fix: async () => notAvailable,
      chat: fakeChat,
      onChatDelta: (cb: (text: string) => void) => {
        devDelta = cb
        return () => { devDelta = null }
      },
      chatResolve: async (_id: string, transcript: ChatMessage[], sql: string, approved: boolean) => {
        await wait(600)
        return {
          reply: approved ? 'Deleted 1,667 inactive customers.' : 'Left it alone.',
          queries: [
            approved
              ? { sql, autoRun: false, status: 'ran' as const, rowCount: 1667, columns: [], rows: [] }
              : { sql, autoRun: false, status: 'declined' as const }
          ],
          transcript
        }
      }
    },
    onDbState: () => () => undefined,
    chats: {
      list: async () => devChats,
      save: async (session: ChatSession) => {
        const i = devChats.findIndex((c) => c.id === session.id)
        if (i >= 0) devChats[i] = session
        else devChats.unshift(session)
        return [...devChats].sort((a, b) => b.updatedAt - a.updatedAt)
      },
      delete: async (id: string) => {
        devChats = devChats.filter((c) => c.id !== id)
        return devChats
      }
    },
    ssh: {
      hosts: async () => [{ alias: 'bastion', hostName: 'bastion.example.com', port: 22, user: 'ubuntu' }]
    },
    files: { pickSqlite: async () => null, pickKey: async () => null, export: async () => ({ ok: false }) },
    updates: {
      check: async () => ({ status: 'none' as const, version: '1.0.0' }),
      state: async () => ({ status: 'none' as const, version: '1.0.0' }),
      install: async () => undefined,
      onState: () => () => undefined
    },
    platform: 'darwin'
  }
}
