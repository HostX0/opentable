import type { AiResult, DbSchema, Driver } from '../shared/types'
import { getAiKey, getSettings } from './store'

const API_URL = 'https://api.anthropic.com/v1/messages'
const MAX_TABLES = 60

/** Compact the schema into a prompt-sized DDL sketch the model can reason over. */
function schemaSketch(schema: DbSchema): string {
  return schema.tables
    .slice(0, MAX_TABLES)
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const flags = [c.isPrimary ? 'PK' : '', c.nullable ? '' : 'NOT NULL']
            .filter(Boolean)
            .join(' ')
          return `    ${c.name} ${c.dataType}${flags ? ' ' + flags : ''}`
        })
        .join('\n')
      const label = t.kind === 'view' ? 'VIEW' : 'TABLE'
      return `${label} ${t.schema}.${t.name} (\n${cols}\n)`
    })
    .join('\n\n')
}

function dialectName(driver: Driver): string {
  if (driver === 'postgres') return 'PostgreSQL'
  if (driver === 'mysql') return 'MySQL'
  return 'SQLite'
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
  error?: { message?: string }
}

async function callClaude(system: string, user: string): Promise<AiResult> {
  const key = getAiKey()
  if (!key) {
    return { ok: false, error: 'Add an Anthropic API key in Settings to use AI features.' }
  }
  const { aiModel } = getSettings()

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: aiModel,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }]
      })
    })

    const data = (await res.json()) as AnthropicResponse
    if (!res.ok) {
      return { ok: false, error: data.error?.message ?? `API error ${res.status}` }
    }
    const text = (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
      .trim()
    if (!text) return { ok: false, error: 'Empty response from the model.' }
    return { ok: true, sql: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function stripFences(text: string): { sql: string; explanation?: string } {
  const fence = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) {
    const sql = fence[1].trim()
    const rest = text.replace(fence[0], '').trim()
    return { sql, explanation: rest || undefined }
  }
  return { sql: text.trim() }
}

/** Natural language question -> a runnable query for this database. */
export async function generateSql(
  question: string,
  schema: DbSchema,
  driver: Driver
): Promise<AiResult> {
  const system = [
    `You write ${dialectName(driver)} queries.`,
    'Rules:',
    '- Use ONLY tables and columns from the provided schema. Never invent names.',
    '- Return exactly one query inside a ```sql fenced block.',
    '- Prefer readable formatting and explicit column lists over SELECT *.',
    '- Add a LIMIT to exploratory SELECTs unless the user asks for totals.',
    '- After the code block, add one short sentence explaining the query.',
    '- If the schema cannot answer the question, say so instead of guessing.'
  ].join('\n')

  const user = [
    `Database schema:\n\n${schemaSketch(schema)}`,
    `\nQuestion: ${question}`
  ].join('\n')

  const res = await callClaude(system, user)
  if (!res.ok || !res.sql) return res
  const { sql, explanation } = stripFences(res.sql)
  return { ok: true, sql, explanation }
}

/** Plain-English description of what a query does. */
export async function explainSql(sql: string, schema: DbSchema, driver: Driver): Promise<AiResult> {
  const system = [
    `You explain ${dialectName(driver)} queries to developers.`,
    'Be concise: 2-4 sentences, plain prose, no code block, no preamble.',
    'Mention any performance or correctness risk you notice.'
  ].join('\n')
  const user = `Schema:\n\n${schemaSketch(schema)}\n\nExplain this query:\n\n${sql}`
  const res = await callClaude(system, user)
  if (!res.ok) return res
  return { ok: true, explanation: res.sql }
}

/** Suggest a fix for a query that errored. */
export async function fixSql(
  sql: string,
  errorText: string,
  schema: DbSchema,
  driver: Driver
): Promise<AiResult> {
  const system = [
    `You repair broken ${dialectName(driver)} queries.`,
    'Return the corrected query in one ```sql block, then one sentence on what was wrong.',
    'Use only schema names that exist.'
  ].join('\n')
  const user = [
    `Schema:\n\n${schemaSketch(schema)}`,
    `\nQuery:\n${sql}`,
    `\nDatabase error:\n${errorText}`
  ].join('\n')
  const res = await callClaude(system, user)
  if (!res.ok || !res.sql) return res
  const { sql: fixed, explanation } = stripFences(res.sql)
  return { ok: true, sql: fixed, explanation }
}
