import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionSummary, DbSchema, HistoryEntry, SavedQuery } from '../../../shared/types'
import { IconDatabase, IconHistory, IconSearch, IconStar, IconTable, IconView } from './icons'

export interface Command {
  id: string
  group: string
  label: string
  hint?: string
  icon?: React.JSX.Element
  run: () => void
}

interface Props {
  connections: ConnectionSummary[]
  schema: DbSchema | null
  history: HistoryEntry[]
  saved: SavedQuery[]
  actions: Command[]
  onSelectConnection: (id: string) => void
  onOpenTable: (schema: string, table: string) => void
  onUseSql: (sql: string) => void
  onClose: () => void
}

export default function CommandPalette({
  connections,
  schema,
  history,
  saved,
  actions,
  onSelectConnection,
  onOpenTable,
  onUseSql,
  onClose
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [...actions]

    for (const c of connections) {
      out.push({
        id: `conn:${c.id}`,
        group: 'Connections',
        label: c.name,
        hint: c.driver === 'sqlite' ? 'SQLite' : `${c.user}@${c.host}`,
        icon: <IconDatabase />,
        run: () => onSelectConnection(c.id)
      })
    }

    for (const t of schema?.tables ?? []) {
      out.push({
        id: `tbl:${t.schema}.${t.name}`,
        group: 'Tables',
        label: t.name,
        hint: `${t.columns.length} columns`,
        icon: t.kind === 'view' ? <IconView /> : <IconTable />,
        run: () => onOpenTable(t.schema, t.name)
      })
    }

    for (const s of saved) {
      out.push({
        id: `saved:${s.id}`,
        group: 'Saved',
        label: s.name,
        hint: s.sql.slice(0, 60).replace(/\s+/g, ' '),
        icon: <IconStar />,
        run: () => onUseSql(s.sql)
      })
    }

    const seen = new Set<string>()
    for (const h of history) {
      const key = h.sql.trim().replace(/\s+/g, ' ')
      if (seen.has(key) || !key) continue
      seen.add(key)
      out.push({
        id: `hist:${h.id}`,
        group: 'History',
        label: key.slice(0, 70),
        hint: new Date(h.ranAt).toLocaleString(),
        icon: <IconHistory />,
        run: () => onUseSql(h.sql)
      })
      if (seen.size > 40) break
    }

    return out
  }, [actions, connections, schema, saved, history, onSelectConnection, onOpenTable, onUseSql])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands.slice(0, 60)
    // simple subsequence scoring: exact substring beats scattered match
    const scored = commands
      .map((c) => {
        const hay = `${c.label} ${c.hint ?? ''} ${c.group}`.toLowerCase()
        const idx = hay.indexOf(q)
        if (idx >= 0) return { c, score: 1000 - idx }
        let qi = 0
        for (let i = 0; i < hay.length && qi < q.length; i++) {
          if (hay[i] === q[qi]) qi++
        }
        return qi === q.length ? { c, score: 100 } : null
      })
      .filter((x): x is { c: Command; score: number } => x !== null)
      .sort((a, b) => b.score - a.score)
    return scored.slice(0, 60).map((s) => s.c)
  }, [commands, query])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => Math.min(results.length - 1, a + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => Math.max(0, a - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = results[active]
        if (hit) {
          onClose()
          hit.run()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, active, onClose])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let lastGroup = ''

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <div className="palette-input">
          <IconSearch className="palette-glyph" />
          <input
            autoFocus
            value={query}
            placeholder="Search tables, connections, history…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">Nothing found.</div>}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className={`palette-item ${i === active ? 'active' : ''}`}
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => {
                    onClose()
                    c.run()
                  }}
                >
                  <span className="palette-icon">{c.icon}</span>
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
