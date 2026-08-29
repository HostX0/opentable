import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatQuery } from '../../../shared/types'
import { IconAi, IconClose, IconEdit } from './icons'

interface Props {
  connectionId: string | null
  connectionName: string
  onClose: () => void
  onOpenSettings: () => void
  /** Drops a query into the editor so it can be run and edited normally. */
  onInsert: (sql: string) => void
}

/** What the user sees, as opposed to the transcript the model sees. */
type Entry =
  | { kind: 'you'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'query'; query: ChatQuery }
  | { kind: 'error'; text: string }

function rowSummary(q: ChatQuery): string {
  if (q.status === 'failed') return 'failed'
  if (q.status === 'declined') return 'not run'
  if (q.status === 'awaiting-approval') return 'needs approval'
  const n = q.rowCount ?? 0
  return `${n} ${n === 1 ? 'row' : 'rows'}`
}

/** A result preview — deliberately small, the grid is for real inspection. */
function QueryCard({
  query,
  onInsert
}: {
  query: ChatQuery
  onInsert: (sql: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hasRows = (query.rows?.length ?? 0) > 0
  return (
    <div className={`chat-query ${query.status}`}>
      <div className="chat-query-head">
        <code>{query.sql}</code>
      </div>
      <div className="chat-query-foot">
        <span className="chat-query-meta">{rowSummary(query)}</span>
        {query.error && <span className="chat-query-error">{query.error}</span>}
        <span className="spacer" />
        {hasRows && (
          <button className="btn-mini" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Show'}
          </button>
        )}
        <button className="btn-mini" title="Put this in the editor" onClick={() => onInsert(query.sql)}>
          <IconEdit /> Editor
        </button>
      </div>
      {open && hasRows && (
        <div className="chat-result">
          <table>
            <thead>
              <tr>
                {(query.columns ?? []).map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(query.rows ?? []).slice(0, 20).map((row, i) => (
                <tr key={i}>
                  {row.map((v, j) => (
                    <td key={j}>{v === null || v === undefined ? 'NULL' : String(v)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/**
 * Conversational access to the database. Separate from the AI bar above the
 * editor: that writes one query into the editor, this holds a conversation and
 * runs its own read-only queries to answer questions about real data.
 */
export default function ChatPanel({
  connectionId,
  connectionName,
  onClose,
  onOpenSettings,
  onInsert
}: Props): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([])
  const [transcript, setTranscript] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState<ChatQuery | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [entries, pending, busy])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /** Folds a completed turn into what the user sees. */
  const absorb = useCallback(
    (turn: {
      reply: string
      queries: ChatQuery[]
      pending?: ChatQuery
      transcript: ChatMessage[]
      error?: string
    }) => {
      setTranscript(turn.transcript)
      setEntries((prev) => {
        const next = [...prev, ...turn.queries.map((q) => ({ kind: 'query' as const, query: q }))]
        if (turn.reply.trim()) next.push({ kind: 'assistant', text: turn.reply })
        if (turn.error) next.push({ kind: 'error', text: turn.error })
        return next
      })
      setPending(turn.pending ?? null)
    },
    []
  )

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || !connectionId || busy) return
    setDraft('')
    setEntries((prev) => [...prev, { kind: 'you', text }])
    setBusy(true)
    const next: ChatMessage[] = [...transcript, { role: 'user', content: text }]
    const turn = await window.opentable.ai.chat(connectionId, next)
    absorb(turn)
    setBusy(false)
  }, [draft, connectionId, busy, transcript, absorb])

  const resolve = useCallback(
    async (approved: boolean): Promise<void> => {
      if (!pending || !connectionId) return
      const sql = pending.sql
      setPending(null)
      setBusy(true)
      const turn = await window.opentable.ai.chatResolve(connectionId, transcript, sql, approved)
      absorb(turn)
      setBusy(false)
    },
    [pending, connectionId, transcript, absorb]
  )

  return (
    <aside className="chat-panel">
      <header className="chat-head">
        <IconAi />
        <strong>Chat</strong>
        <span className="chat-conn">{connectionName}</span>
        <span className="spacer" />
        <button className="icon-btn" title="Close" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      <div className="chat-body">
        {entries.length === 0 && !busy && (
          <div className="chat-empty">
            <p>Ask anything about this database.</p>
            <ul>
              <li onClick={() => setDraft('What is in this database?')}>
                What is in this database?
              </li>
              <li onClick={() => setDraft('How many rows are in each table?')}>
                How many rows are in each table?
              </li>
              <li onClick={() => setDraft('Which tables reference the users table?')}>
                Which tables reference the users table?
              </li>
            </ul>
            <p className="chat-note">
              Read-only queries run automatically. Anything that writes asks you first.
            </p>
          </div>
        )}

        {entries.map((e, i) => {
          if (e.kind === 'query') return <QueryCard key={i} query={e.query} onInsert={onInsert} />
          if (e.kind === 'error')
            return (
              <div key={i} className="chat-msg error">
                {e.text}
                {/key|endpoint|reach|API/i.test(e.text) && (
                  <button className="btn-mini" onClick={onOpenSettings}>
                    Settings
                  </button>
                )}
              </div>
            )
          return (
            <div key={i} className={`chat-msg ${e.kind}`}>
              {e.text}
            </div>
          )
        })}

        {pending && (
          <div className="chat-approve">
            <div className="chat-approve-head">
              This needs your permission — {pending.reason}
            </div>
            <code>{pending.sql}</code>
            <div className="chat-approve-actions">
              <button className="btn quiet" onClick={() => void resolve(false)}>
                Don&rsquo;t run
              </button>
              <button className="btn danger" onClick={() => void resolve(true)}>
                Run it
              </button>
            </div>
          </div>
        )}

        {busy && <div className="chat-msg busy">Working…</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          placeholder={connectionId ? 'Ask about your data…' : 'Connect to a database first'}
          disabled={!connectionId || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          className="btn primary"
          disabled={!connectionId || busy || !draft.trim()}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </aside>
  )
}
