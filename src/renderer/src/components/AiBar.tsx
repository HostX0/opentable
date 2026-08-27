import { useCallback, useEffect, useRef, useState } from 'react'
import { IconAi } from './icons'

export type AiAction = 'ask' | 'explain'

interface Props {
  connectionId: string | null
  hasKey: boolean
  /** SQL in the active tab — the subject of Explain, and the Undo target */
  currentSql: string
  action: AiAction
  /** Replaces the editor contents */
  onInsert: (sql: string) => void
  onOpenSettings: () => void
  onClose: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'applied'; previous: string; note?: string }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string }

/**
 * A single line above the editor. Asking writes the result straight into the
 * editor rather than into a preview pane, so there is only ever one copy of the
 * query on screen.
 */
export default function AiBar({
  connectionId,
  hasKey,
  currentSql,
  action,
  onInsert,
  onOpenSettings,
  onClose
}: Props): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)

  const explain = useCallback(async (): Promise<void> => {
    const sql = currentSql.trim()
    if (!connectionId || !sql) {
      setPhase({ kind: 'error', text: 'Write a query first, then ask for an explanation.' })
      return
    }
    setPhase({ kind: 'busy' })
    const res = await window.opentable.ai.explain(connectionId, sql)
    setPhase(
      res.ok
        ? { kind: 'note', text: res.explanation ?? 'No explanation returned.' }
        : { kind: 'error', text: res.error ?? 'Could not explain this query' }
    )
  }, [connectionId, currentSql])

  useEffect(() => {
    if (action === 'explain' && hasKey) void explain()
    else inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, hasKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ask = async (): Promise<void> => {
    const q = question.trim()
    if (!connectionId || !q || phase.kind === 'busy') return
    const previous = currentSql
    setPhase({ kind: 'busy' })
    const res = await window.opentable.ai.generate(connectionId, q)
    if (res.ok && res.sql) {
      onInsert(res.sql)
      setPhase({ kind: 'applied', previous, note: res.explanation })
    } else {
      setPhase({ kind: 'error', text: res.error ?? 'Could not generate a query' })
    }
  }

  const undo = (): void => {
    if (phase.kind !== 'applied') return
    onInsert(phase.previous)
    // clear the spent question so the strip returns to a genuinely fresh state
    setQuestion('')
    setPhase({ kind: 'idle' })
    inputRef.current?.focus()
  }

  if (!hasKey) {
    return (
      <div className="ai-strip">
        <IconAi className="ai-glyph" />
        <span className="ai-line">
          Add an Anthropic API key to write, explain and fix queries with AI.
        </span>
        <button className="tool-btn" onClick={onOpenSettings}>
          Settings
        </button>
        <button className="ai-dismiss" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
    )
  }

  /* ——— after a generate: the SQL is already in the editor ——— */
  if (phase.kind === 'applied') {
    return (
      <div className="ai-strip applied">
        <IconAi className="ai-glyph" />
        <span className="ai-line">{phase.note ?? 'Written into the editor.'}</span>
        <button className="tool-btn" onClick={undo}>
          Undo
        </button>
        <button className="tool-btn solid" onClick={onClose}>
          Keep
        </button>
      </div>
    )
  }

  /* ——— an explanation, or an error ——— */
  if (phase.kind === 'note' || phase.kind === 'error') {
    return (
      <div className={`ai-strip ${phase.kind === 'error' ? 'bad' : ''}`}>
        <IconAi className="ai-glyph" />
        <span className="ai-line">{phase.text}</span>
        {phase.kind === 'error' && (
          <button className="tool-btn" onClick={() => setPhase({ kind: 'idle' })}>
            Try again
          </button>
        )}
        <button className="ai-dismiss" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
    )
  }

  /* ——— asking ——— */
  return (
    <div className="ai-strip">
      <IconAi className={`ai-glyph ${phase.kind === 'busy' ? 'thinking' : ''}`} />
      {phase.kind === 'busy' ? (
        <span className="ai-line muted">
          Thinking<span className="ellipsis" />
        </span>
      ) : (
        <>
          <input
            ref={inputRef}
            value={question}
            placeholder="Ask for a query — “top 10 customers by revenue this year”"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
          />
          <span className="ai-hint">
            {question.trim() ? <kbd>↵</kbd> : <button className="ai-link" onClick={explain}>explain current query</button>}
          </span>
        </>
      )}
      <button className="ai-dismiss" onClick={onClose} title="Close">
        ✕
      </button>
    </div>
  )
}
