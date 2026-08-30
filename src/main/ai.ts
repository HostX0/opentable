import type {
  AiProvider,
  AiResult,
  ChatMessage,
  ChatQuery,
  ChatTurn,
  DbSchema,
  Driver
} from '../shared/types'
import { splitStatements } from '../shared/sqlscan'
import { runQuery } from './db'
import { canAutoRun } from './sqlutil'
import { getAiConfig } from './store'

const DEFAULT_ENDPOINT: Record<AiProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  'openai-compatible': 'http://localhost:11434/v1/chat/completions'
}

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

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
  error?: { message?: string }
}

/**
 * Normalises a base URL into a full endpoint. People paste the root of their
 * Ollama or vLLM server far more often than the exact path, so accept both.
 */
function endpointFor(provider: AiProvider, baseUrl: string): string {
  if (!baseUrl) return DEFAULT_ENDPOINT[provider]
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/(messages|chat\/completions)$/.test(trimmed)) return trimmed
  if (provider === 'anthropic') {
    return /\/v1$/.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`
  }
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`
}

/**
 * One call to whichever provider is configured.
 *
 * The two wire formats differ in three ways that all have to be handled:
 * the auth header, where the system prompt lives, and the response shape.
 */
/** Called with each token as it arrives, when the caller wants streaming. */
export type Delta = (text: string) => void

/**
 * Reads a server-sent-event stream, calling `onDelta` per token.
 *
 * The two providers frame deltas differently:
 *   Anthropic  {"type":"content_block_delta","delta":{"text":"…"}}
 *   OpenAI     {"choices":[{"delta":{"content":"…"}}]}   terminated by [DONE]
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  isAnthropic: boolean,
  onDelta: Delta
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let full = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line; keep any partial tail
    const frames = buffered.split('\n\n')
    buffered = frames.pop() ?? ''

    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload)
          const text = isAnthropic
            ? json?.delta?.text
            : json?.choices?.[0]?.delta?.content
          if (typeof text === 'string' && text) {
            full += text
            onDelta(text)
          }
        } catch {
          // a frame split across reads; the next chunk completes it
        }
      }
    }
  }
  return full
}

async function callModel(
  system: string,
  messages: ChatMessage[],
  onDelta?: Delta
): Promise<AiResult> {
  const { provider, baseUrl, model, key } = getAiConfig()

  // Local servers need no credential, so only Anthropic hard-requires one.
  if (provider === 'anthropic' && !key) {
    return { ok: false, error: 'Add an Anthropic API key in Settings to use AI features.' }
  }

  const url = endpointFor(provider, baseUrl)
  const isAnthropic = provider === 'anthropic'

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = key ?? ''
    headers['anthropic-version'] = '2023-06-01'
  } else if (key) {
    headers.authorization = `Bearer ${key}`
  }

  const body = {
    ...(isAnthropic
      ? { model, max_tokens: 1500, system, messages }
      : { model, max_tokens: 1500, messages: [{ role: 'system', content: system }, ...messages] }),
    ...(onDelta ? { stream: true } : {})
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })

    if (!res.ok) {
      // errors come back as JSON even when streaming was requested
      const failed = (await res.json().catch(() => ({}))) as AnthropicResponse & OpenAiResponse
      return { ok: false, error: failed.error?.message ?? `API error ${res.status} from ${url}` }
    }

    if (onDelta && res.body) {
      const streamed = (await readStream(res.body, isAnthropic, onDelta)).trim()
      if (!streamed) return { ok: false, error: 'Empty response from the model.' }
      return { ok: true, sql: streamed }
    }

    const data = (await res.json()) as AnthropicResponse & OpenAiResponse
    const text = isAnthropic
      ? (data.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n')
          .trim()
      : (data.choices?.[0]?.message?.content ?? '').trim()

    if (!text) return { ok: false, error: 'Empty response from the model.' }
    return { ok: true, sql: text }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // a refused connection to a local server is the single most likely failure
    if (/ECONNREFUSED|fetch failed/i.test(detail) && !isAnthropic) {
      return { ok: false, error: `Could not reach ${url}. Is the server running?` }
    }
    return { ok: false, error: detail }
  }
}

/** Single-turn helper for the existing generate / explain / fix features. */
async function callClaude(system: string, user: string): Promise<AiResult> {
  return callModel(system, [{ role: 'user', content: user }])
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

/* ————————————————————— chat ————————————————————— */

/** Enough hops to look something up, refine it, and answer. */
const MAX_STEPS = 6
/** Rows fed back to the model. Large results waste context and prove nothing. */
const CHAT_ROW_LIMIT = 200
/** Rows actually shown to the model, of those fetched. */
const ROWS_IN_PROMPT = 40

function chatSystem(schema: DbSchema, driver: Driver): string {
  return [
    `You are a database assistant working against a ${dialectName(driver)} database.`,
    'You can run queries yourself to answer questions about the real data.',
    '',
    'Protocol:',
    '- To run a query, reply with ONE ```sql fenced block and nothing else.',
    '  You will get the results back and can then continue.',
    '- Read-only SELECTs run immediately.',
    '- Anything that changes data or structure is shown to the user for approval',
    '  first. Write it when they ask for it — just expect a pause.',
    '- When you can answer, reply in prose with NO sql block. Be concise and',
    '  concrete: cite the numbers you actually retrieved.',
    '- Never invent table or column names. Use only the schema below.',
    '- If a question cannot be answered from this database, say so plainly.',
    '',
    `Schema:\n\n${schemaSketch(schema)}`
  ].join('\n')
}

/** Compact rendering of a result set for the model. */
function renderRows(columns: string[], rows: unknown[][], rowCount: number): string {
  if (rows.length === 0) return 'No rows.'
  const shown = rows.slice(0, ROWS_IN_PROMPT)
  const head = columns.join(' | ')
  const body = shown
    .map((r) => r.map((v) => (v === null || v === undefined ? 'NULL' : String(v))).join(' | '))
    .join('\n')
  const more = rowCount > shown.length ? `\n… ${rowCount - shown.length} more rows` : ''
  return `${head}\n${body}${more}`
}

function extractSql(text: string): string | null {
  const fence = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text)
  return fence ? fence[1].trim() : null
}

async function execute(connectionId: string, sql: string): Promise<ChatQuery> {
  const statements = splitStatements(sql)
  const verdict = canAutoRun(statements)
  const base: ChatQuery = { sql, autoRun: verdict.autoRun, reason: verdict.reason, status: 'ran' }
  try {
    const res = await runQuery(connectionId, sql, { rowLimit: CHAT_ROW_LIMIT })
    const set = res.sets[res.sets.length - 1]
    return {
      ...base,
      status: 'ran',
      columns: set?.columns ?? [],
      rows: set?.rows ?? [],
      rowCount: set?.rowCount ?? 0
    }
  } catch (err) {
    return { ...base, status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

function resultMessage(q: ChatQuery): ChatMessage {
  if (q.status === 'failed') {
    return { role: 'user', content: `Query failed: ${q.error}\n\nTry a different approach.` }
  }
  if (q.status === 'declined') {
    return {
      role: 'user',
      content: 'The user declined to run that query. Do not retry it; answer without it or ask what they would prefer.'
    }
  }
  return {
    role: 'user',
    content: `Result (${q.rowCount ?? 0} rows):\n${renderRows(q.columns ?? [], q.rows ?? [], q.rowCount ?? 0)}`
  }
}

/**
 * Runs the assistant until it answers, needs approval, or hits MAX_STEPS.
 * Stateless: the whole transcript goes in and comes back out.
 */
export async function chat(
  connectionId: string,
  transcript: ChatMessage[],
  schema: DbSchema,
  driver: Driver,
  onDelta?: Delta
): Promise<ChatTurn> {
  const system = chatSystem(schema, driver)
  const queries: ChatQuery[] = []
  const convo = [...transcript]

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await callModel(system, convo, onDelta)
    if (!res.ok) return { reply: '', queries, transcript: convo, error: res.error }

    const text = res.sql ?? ''
    const sql = extractSql(text)

    if (!sql) {
      convo.push({ role: 'assistant', content: text })
      return { reply: text, queries, transcript: convo }
    }

    convo.push({ role: 'assistant', content: text })

    const verdict = canAutoRun(splitStatements(sql))
    if (!verdict.autoRun) {
      const pending: ChatQuery = {
        sql,
        autoRun: false,
        reason: verdict.reason,
        status: 'awaiting-approval'
      }
      return { reply: '', queries, pending, transcript: convo }
    }

    const done = await execute(connectionId, sql)
    queries.push(done)
    convo.push(resultMessage(done))
  }

  return {
    reply: '',
    queries,
    transcript: convo,
    error: `Stopped after ${MAX_STEPS} queries without reaching an answer.`
  }
}

/** Continues a turn that stopped for approval. */
export async function resolvePending(
  connectionId: string,
  transcript: ChatMessage[],
  sql: string,
  approved: boolean,
  schema: DbSchema,
  driver: Driver,
  onDelta?: Delta
): Promise<ChatTurn> {
  const outcome: ChatQuery = approved
    ? await execute(connectionId, sql)
    : { sql, autoRun: false, status: 'declined' }

  const convo = [...transcript, resultMessage(outcome)]
  const next = await chat(connectionId, convo, schema, driver, onDelta)
  return { ...next, queries: [outcome, ...next.queries] }
}
