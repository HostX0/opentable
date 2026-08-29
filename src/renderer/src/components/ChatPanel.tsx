import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatEntry, ChatMessage, ChatQuery, ChatSession, ChatTurn } from '../../../shared/types'
import {
  IconAi,
  IconClose,
  IconCollapse,
  IconEdit,
  IconExpand,
  IconHistory,
  IconPlus,
  IconSend,
  IconTrash
} from './icons'
import Markdown from './Markdown'

interface Props {
  connectionId: string | null
  connectionName: string
  onClose: () => void
  onOpenSettings: () => void
  /** Drops a query into the editor so it can be run and edited normally. */
  onInsert: (sql: string) => void
}

const MIN_W = 320
const MAX_W = 900
const DEFAULT_W = 380
const WIDTH_KEY = 'opentable.chat.width'

/** localStorage can throw in some contexts, and a bad width must not break the panel. */
function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    return v >= MIN_W && v <= MAX_W ? v : DEFAULT_W
  } catch {
    return DEFAULT_W
  }
}

function storeWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(w))
  } catch {
    /* private window, or storage disabled */
  }
}

const newSession = (connectionId: string | null, connectionName: string): ChatSession => ({
  id: crypto.randomUUID(),
  title: 'New chat',
  connectionId,
  connectionName,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  entries: [],
  transcript: []
})

/** First thing the user said, trimmed — good enough to recognise later. */
function titleFrom(entries: ChatEntry[]): string {
  const first = entries.find((e) => e.kind === 'you')
  if (!first || first.kind !== 'you') return 'New chat'
  const t = first.text.trim().replace(/\s+/g, ' ')
  return t.length > 44 ? t.slice(0, 44) + '…' : t
}

function relative(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function rowSummary(q: ChatQuery): string {
  if (q.status === 'failed') return 'failed'
  if (q.status === 'declined') return 'not run'
  if (q.status === 'awaiting-approval') return 'needs approval'
  const n = q.rowCount ?? 0
  return `${n} ${n === 1 ? 'row' : 'rows'}`
}

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
        <button
          className="btn-mini"
          title="Put this in the editor"
          onClick={() => onInsert(query.sql)}
        >
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

function SessionList({
  sessions,
  activeId,
  onPick,
  onDelete,
  onNew
}: {
  sessions: ChatSession[]
  activeId: string
  onPick: (s: ChatSession) => void
  onDelete: (id: string) => void
  onNew: () => void
}): React.JSX.Element {
  return (
    <div className="chat-sessions">
      <button className="chat-session-new" onClick={onNew}>
        <IconPlus /> New chat
      </button>
      {sessions.length === 0 && <p className="chat-sessions-empty">No saved chats yet.</p>}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={`chat-session ${s.id === activeId ? 'active' : ''}`}
          onClick={() => onPick(s)}
        >
          <span className="chat-session-title">{s.title}</span>
          <span className="chat-session-meta">
            {s.connectionName || 'no connection'} · {relative(s.updatedAt)}
          </span>
          <button
            className="chat-session-del"
            title="Delete this chat"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(s.id)
            }}
          >
            <IconTrash />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Conversational access to the database. Separate from the AI bar above the
 * editor: that writes one query into the editor, this holds a conversation and
 * runs its own queries to answer questions about real data.
 */
export default function ChatPanel({
  connectionId,
  connectionName,
  onClose,
  onOpenSettings,
  onInsert
}: Props): React.JSX.Element {
  const [session, setSession] = useState<ChatSession>(() =>
    newSession(connectionId, connectionName)
  )
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [pending, setPending] = useState<ChatQuery | null>(null)
  const [busy, setBusy] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [draft, setDraft] = useState('')
  const [full, setFull] = useState(false)
  const [showList, setShowList] = useState(false)
  const [width, setWidth] = useState(readWidth)

  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    void window.opentable.chats.list().then(setSessions)
  }, [])

  // tokens arrive on their own channel; the buffer is cleared when the turn lands
  useEffect(() => {
    return window.opentable.ai.onChatDelta((text) => setStreaming((s) => s + text))
  }, [])

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [session.entries, pending, busy, streaming])

  useEffect(() => {
    inputRef.current?.focus()
  }, [session.id])

  // grow the composer with its content instead of scrolling a two-line box
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [draft])

  /* ————— resizing ————— */

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (!dragging.current) return
      const next = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX))
      setWidth(next)
    }
    const up = (): void => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('resizing-col')
      setWidth((w) => {
        storeWidth(w)
        return w
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  /* ————— persistence ————— */

  const persist = useCallback(async (next: ChatSession): Promise<void> => {
    if (next.entries.length === 0) return
    const stamped = { ...next, title: titleFrom(next.entries), updatedAt: Date.now() }
    setSession(stamped)
    setSessions(await window.opentable.chats.save(stamped))
  }, [])

  const startNew = useCallback((): void => {
    setSession(newSession(connectionId, connectionName))
    setPending(null)
    setDraft('')
    setShowList(false)
    inputRef.current?.focus()
  }, [connectionId, connectionName])

  const openSession = useCallback((s: ChatSession): void => {
    setSession(s)
    setPending(null)
    setShowList(false)
  }, [])

  const removeSession = useCallback(
    async (id: string): Promise<void> => {
      setSessions(await window.opentable.chats.delete(id))
      if (id === session.id) startNew()
    },
    [session.id, startNew]
  )

  /* ————— conversation ————— */

  const absorb = useCallback(
    (base: ChatSession, turn: ChatTurn): ChatSession => {
      const entries: ChatEntry[] = [
        ...base.entries,
        ...turn.queries.map((q) => ({ kind: 'query' as const, query: q }))
      ]
      if (turn.reply.trim()) entries.push({ kind: 'assistant', text: turn.reply })
      if (turn.error) entries.push({ kind: 'error', text: turn.error })
      setPending(turn.pending ?? null)
      setStreaming('')
      return { ...base, entries, transcript: turn.transcript }
    },
    []
  )

  const send = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text || !connectionId || busy) return
    setDraft('')
    const withUser: ChatSession = {
      ...session,
      entries: [...session.entries, { kind: 'you', text }],
      transcript: [...session.transcript, { role: 'user', content: text } as ChatMessage]
    }
    setSession(withUser)
    setStreaming('')
    setBusy(true)
    const turn = await window.opentable.ai.chat(connectionId, withUser.transcript)
    await persist(absorb(withUser, turn))
    setBusy(false)
  }, [draft, connectionId, busy, session, absorb, persist])

  const resolve = useCallback(
    async (approved: boolean): Promise<void> => {
      if (!pending || !connectionId) return
      const sql = pending.sql
      setPending(null)
      setStreaming('')
      setBusy(true)
      const turn = await window.opentable.ai.chatResolve(
        connectionId,
        session.transcript,
        sql,
        approved
      )
      await persist(absorb(session, turn))
      setBusy(false)
    },
    [pending, connectionId, session, absorb, persist]
  )

  const empty = session.entries.length === 0 && !busy && !pending && !streaming

  return (
    <aside
      className={`chat-panel ${full ? 'full' : ''}`}
      style={full ? undefined : { width }}
    >
      {!full && (
        <div
          className="chat-resize"
          title="Drag to resize"
          onPointerDown={(e) => {
            e.preventDefault()
            dragging.current = true
            document.body.classList.add('resizing-col')
          }}
        />
      )}

      {full && (
        <div className="chat-rail">
          <SessionList
            sessions={sessions}
            activeId={session.id}
            onPick={openSession}
            onDelete={(id) => void removeSession(id)}
            onNew={startNew}
          />
        </div>
      )}

      <div className="chat-column">
        <header className="chat-head">
          <IconAi />
          <strong className="chat-title">{session.entries.length ? session.title : 'Chat'}</strong>
          {connectionName && <span className="chat-conn">{connectionName}</span>}
          <span className="spacer" />
          {!full && (
            <>
              <button
                className={`icon-btn ${showList ? 'on' : ''}`}
                title="Saved chats"
                onClick={() => setShowList((v) => !v)}
              >
                <IconHistory />
              </button>
              <button className="icon-btn" title="New chat" onClick={startNew}>
                <IconPlus />
              </button>
            </>
          )}
          <button
            className="icon-btn"
            title={full ? 'Exit full screen' : 'Full screen'}
            onClick={() => setFull((v) => !v)}
          >
            {full ? <IconCollapse /> : <IconExpand />}
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <IconClose />
          </button>
        </header>

        {showList && !full && (
          <div className="chat-drop">
            <SessionList
              sessions={sessions}
              activeId={session.id}
              onPick={openSession}
              onDelete={(id) => void removeSession(id)}
              onNew={startNew}
            />
          </div>
        )}

        <div className="chat-body" ref={bodyRef}>
          {empty && (
            <div className="chat-empty">
              <p>Ask anything about this database.</p>
              <ul>
                {[
                  'What is in this database?',
                  'How many rows are in each table?',
                  'Which tables reference the users table?'
                ].map((q) => (
                  <li key={q} onClick={() => setDraft(q)}>
                    {q}
                  </li>
                ))}
              </ul>
              <p className="chat-note">
                Read-only queries run automatically. Anything that writes asks you first.
              </p>
            </div>
          )}

          {session.entries.map((e, i) => {
            if (e.kind === 'query') return <QueryCard key={i} query={e.query} onInsert={onInsert} />
            if (e.kind === 'error')
              return (
                <div key={i} className="chat-msg error">
                  <span>{e.text}</span>
                  {/key|endpoint|reach|API/i.test(e.text) && (
                    <button className="btn-mini" onClick={onOpenSettings}>
                      Settings
                    </button>
                  )}
                </div>
              )
            return (
              <div key={i} className={`chat-msg ${e.kind}`}>
                {e.kind === 'assistant' ? <Markdown text={e.text} /> : e.text}
              </div>
            )
          })}

          {pending && (
            <div className="chat-approve">
              <div className="chat-approve-head">This needs your permission — {pending.reason}</div>
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

          {busy &&
            (streaming ? (
              <div className="chat-msg assistant streaming">
                <Markdown text={streaming} />
              </div>
            ) : (
              <div className="chat-typing">
                <span />
                <span />
                <span />
              </div>
            ))}
        </div>

        <div className="chat-input">
          <div className="chat-composer">
            <textarea
              ref={inputRef}
              rows={1}
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
              className="chat-send"
              title="Send"
              disabled={!connectionId || busy || !draft.trim()}
              onClick={() => void send()}
            >
              <IconSend />
            </button>
          </div>
          <div className="chat-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </div>
        </div>
      </div>
    </aside>
  )
}
