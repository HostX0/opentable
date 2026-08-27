import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DropMenu from './DropMenu'
import type { PendingChange, QueryResult, ResultSet } from '../../../shared/types'
import { IconChevron, IconDownload, IconSearch, IconTrash, IconUndo } from './icons'

const ROW_H = 25
const OVERSCAN = 12

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

/* ————————————————————— export helpers ————————————————————— */

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(set: ResultSet): string {
  return [set.columns.join(','), ...set.rows.map((r) => r.map(csvEscape).join(','))].join('\n')
}

function toJson(set: ResultSet): string {
  return JSON.stringify(
    set.rows.map((r) => Object.fromEntries(set.columns.map((c, i) => [c, r[i]]))),
    null,
    2
  )
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return "'" + String(v).replace(/'/g, "''") + "'"
}

function toSqlInserts(set: ResultSet): string {
  const table = set.sourceTable?.name ?? 'exported_rows'
  const cols = set.columns.join(', ')
  return set.rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`)
    .join('\n')
}

function toMarkdown(set: ResultSet): string {
  const head = `| ${set.columns.join(' | ')} |`
  const sep = `| ${set.columns.map(() => '---').join(' | ')} |`
  const body = set.rows
    .map((r) => `| ${r.map((v) => (v === null ? '' : String(v))).join(' | ')} |`)
    .join('\n')
  return [head, sep, body].join('\n')
}

/* ————————————————————— cell rendering ————————————————————— */

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

interface GridProps {
  set: ResultSet
  connectionId: string | null
  onChanged: () => void
  readOnly: boolean
}

interface DraftEdit {
  rowIndex: number
  column: string
  value: string
}

function ResultGrid({
  set,
  connectionId,
  onChanged,
  readOnly
}: GridProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(400)
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [filter, setFilter] = useState('')
  const [edits, setEdits] = useState<DraftEdit[]>([])
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const exportBtnRef = useRef<HTMLButtonElement>(null)

  const editable = !readOnly && Boolean(set.sourceTable && set.primaryKey?.length)

  /* ——— derived rows: filter then sort, keeping original indices ——— */
  const view = useMemo(() => {
    let idx = set.rows.map((_, i) => i)
    const q = filter.trim().toLowerCase()
    if (q) {
      idx = idx.filter((i) => set.rows[i].some((v) => cellText(v).toLowerCase().includes(q)))
    }
    if (sort) {
      const { col, dir } = sort
      idx = [...idx].sort((a, b) => {
        const av = set.rows[a][col]
        const bv = set.rows[b][col]
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        const an = typeof av === 'number' ? av : Number(av)
        const bn = typeof bv === 'number' ? bv : Number(bv)
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir
        return String(av).localeCompare(String(bv)) * dir
      })
    }
    return idx
  }, [set.rows, filter, sort])

  /* ——— virtualization ——— */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // filtering/sorting changes the row count — jump back to the top so the
  // viewport is never parked past the end of the new list
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
  }, [filter, sort])

  const total = view.length
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const visibleCount = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2
  const last = Math.min(total, first + visibleCount)
  const padTop = first * ROW_H
  const padBottom = Math.max(0, (total - last) * ROW_H)

  const editMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of edits) m.set(`${e.rowIndex}:${e.column}`, e.value)
    return m
  }, [edits])

  const valueAt = useCallback(
    (rowIndex: number, colIndex: number): unknown => {
      const key = `${rowIndex}:${set.columns[colIndex]}`
      if (editMap.has(key)) return editMap.get(key)
      return set.rows[rowIndex][colIndex]
    },
    [editMap, set.columns, set.rows]
  )

  const commitEdit = (rowIndex: number, colIndex: number, raw: string): void => {
    const column = set.columns[colIndex]
    const original = cellText(set.rows[rowIndex][colIndex])
    setEdits((prev) => {
      const rest = prev.filter((e) => !(e.rowIndex === rowIndex && e.column === column))
      if (raw === original) return rest
      return [...rest, { rowIndex, column, value: raw }]
    })
    setEditing(null)
  }

  const pendingCount = edits.length + deleted.size

  const discard = (): void => {
    setEdits([])
    setDeleted(new Set())
    setApplyError(null)
  }

  const buildChanges = (): PendingChange[] => {
    const pk = set.primaryKey ?? []
    const changes: PendingChange[] = []
    const identityFor = (rowIndex: number): { keys: Record<string, unknown> } => ({
      keys: Object.fromEntries(
        pk.map((k) => [k, set.rows[rowIndex][set.columns.indexOf(k)]])
      )
    })

    const byRow = new Map<number, Record<string, unknown>>()
    for (const e of edits) {
      if (deleted.has(e.rowIndex)) continue
      const bucket = byRow.get(e.rowIndex) ?? {}
      bucket[e.column] = e.value === '' ? null : e.value
      byRow.set(e.rowIndex, bucket)
    }
    for (const [rowIndex, values] of byRow) {
      changes.push({ kind: 'update', identity: identityFor(rowIndex), values })
    }
    for (const rowIndex of deleted) {
      changes.push({ kind: 'delete', identity: identityFor(rowIndex) })
    }
    return changes
  }

  const apply = async (): Promise<void> => {
    if (!connectionId || !set.sourceTable) return
    setApplying(true)
    setApplyError(null)
    const res = await window.opentable.db.applyChanges(connectionId, set.sourceTable, buildChanges())
    setApplying(false)
    if (res.ok) {
      discard()
      onChanged()
    } else {
      setApplyError(res.error ?? 'Could not save changes')
    }
  }

  const doExport = async (kind: 'csv' | 'json' | 'sql' | 'md'): Promise<void> => {
    setExportOpen(false)
    const name = set.sourceTable?.name ?? 'results'
    const body =
      kind === 'csv'
        ? toCsv(set)
        : kind === 'json'
          ? toJson(set)
          : kind === 'sql'
            ? toSqlInserts(set)
            : toMarkdown(set)
    await window.opentable.files.export(`${name}.${kind}`, body, kind)
  }

  const hasRows = set.columns.length > 0

  if (!hasRows) {
    return (
      <div className="result-set">
        <div className="result-meta">
          <span className="meta-main">
            {set.command ?? 'OK'} — {set.rowCount.toLocaleString()} row
            {set.rowCount === 1 ? '' : 's'} affected
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="result-set">
      <div className="result-toolbar">
        <span className="row-count">
          <b>{total.toLocaleString()}</b>
          {filter && <span className="of-total"> of {set.rowCount.toLocaleString()}</span>}
          <span className="unit"> row{total === 1 ? '' : 's'}</span>
        </span>

        {set.truncated && (
          <span className="tool-note" title="OpenTable added a LIMIT so a huge table cannot freeze the app. Raise it in Settings.">
            limited
          </span>
        )}

        {!editable && set.readOnlyReason && (
          <span
            className="tool-note"
            title="Editing needs a single table with a primary key, so each row can be targeted safely."
          >
            read-only · {set.readOnlyReason}
          </span>
        )}

        <label className="tool-search">
          <IconSearch />
          <input
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter && (
            <button className="tool-clear" onClick={() => setFilter('')} title="Clear filter">
              ✕
            </button>
          )}
        </label>

        <span className="spacer" />

        {pendingCount > 0 && (
          <span className="pending-group">
            <span className="pending-count">
              {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}
            </span>
            <button className="tool-btn" onClick={discard} title="Discard changes">
              Discard
            </button>
            <button className="tool-btn solid" onClick={apply} disabled={applying}>
              {applying ? 'Saving…' : 'Save'}
            </button>
          </span>
        )}

        <button
          ref={exportBtnRef}
          className={`tool-btn ${exportOpen ? 'on' : ''}`}
          onClick={() => setExportOpen((o) => !o)}
        >
          <IconDownload />
          Export
        </button>
        {exportOpen && (
          <DropMenu
            anchorRef={exportBtnRef}
            onClose={() => setExportOpen(false)}
            items={[
              { label: 'CSV', onSelect: () => doExport('csv') },
              { label: 'JSON', onSelect: () => doExport('json') },
              { label: 'SQL inserts', onSelect: () => doExport('sql') },
              { label: 'Markdown', onSelect: () => doExport('md') },
              {
                label: 'Copy to clipboard',
                separatorBefore: true,
                onSelect: () => navigator.clipboard.writeText(toCsv(set))
              }
            ]}
          />
        )}
      </div>

      {applyError && <div className="error-block inline">{applyError}</div>}

      <div
        className="grid-scroll"
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      >
        <table className="grid">
          <thead>
            <tr>
              <th className="rownum" />
              {set.columns.map((c, i) => {
                const isPk = set.primaryKey?.includes(c)
                return (
                  <th
                    key={i}
                    onClick={() =>
                      setSort((s) =>
                        s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }
                      )
                    }
                    title={`${c}${isPk ? ' (primary key)' : ''} — click to sort`}
                  >
                    <span className="th-inner">
                      {isPk && <span className="pk-dot" title="Primary key" />}
                      {c}
                      {sort?.col === i && (
                        <IconChevron className={`sort-caret ${sort.dir === -1 ? 'up' : ''}`} />
                      )}
                    </span>
                  </th>
                )
              })}
              {editable && <th className="rowact" />}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr style={{ height: padTop }} aria-hidden="true">
                <td colSpan={set.columns.length + (editable ? 2 : 1)} />
              </tr>
            )}
            {view.slice(first, last).map((rowIndex, n) => {
              const isDeleted = deleted.has(rowIndex)
              return (
                <tr key={rowIndex} className={isDeleted ? 'row-deleted' : undefined}>
                  <td className="rownum">{first + n + 1}</td>
                  {set.columns.map((col, ci) => {
                    const v = valueAt(rowIndex, ci)
                    const isEdited = editMap.has(`${rowIndex}:${col}`)
                    const isEditing = editing?.row === rowIndex && editing?.col === ci
                    if (isEditing) {
                      return (
                        <td key={ci} className="cell-editing">
                          {/* keeps the column at its original width while the
                              overlaid input is out of flow */}
                          <span className="cell-ghost">{cellText(v) || ' '}</span>
                          <input
                            autoFocus
                            defaultValue={cellText(v)}
                            // select the whole value so typing replaces it, like a spreadsheet
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => commitEdit(rowIndex, ci, e.target.value)}
                            onKeyDown={(e) => {
                              const input = e.currentTarget
                              if (e.key === 'Enter' || e.key === 'Tab') {
                                e.preventDefault()
                                e.stopPropagation()
                                const value = input.value
                                if (e.key === 'Tab') {
                                  const nextCol = e.shiftKey ? ci - 1 : ci + 1
                                  commitEdit(rowIndex, ci, value)
                                  if (nextCol >= 0 && nextCol < set.columns.length) {
                                    setEditing({ row: rowIndex, col: nextCol })
                                  }
                                } else {
                                  commitEdit(rowIndex, ci, value)
                                }
                              } else if (e.key === 'Escape') {
                                e.preventDefault()
                                e.stopPropagation()
                                setEditing(null)
                              }
                            }}
                          />
                        </td>
                      )
                    }
                    const isNull = v === null || v === undefined
                    const isNum = typeof v === 'number'
                    return (
                      <td
                        key={ci}
                        className={[
                          isNull ? 'null' : '',
                          isNum ? 'num' : '',
                          isEdited ? 'edited' : '',
                          editable && !isDeleted ? 'editable-cell' : ''
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onDoubleClick={() => editable && !isDeleted && setEditing({ row: rowIndex, col: ci })}
                        title={isNull ? 'NULL' : cellText(v)}
                      >
                        {isNull ? 'NULL' : cellText(v)}
                      </td>
                    )
                  })}
                  {editable && (
                    <td className="rowact">
                      <button
                        className="row-del"
                        title={isDeleted ? 'Keep row' : 'Delete row'}
                        onClick={() =>
                          setDeleted((prev) => {
                            const next = new Set(prev)
                            if (next.has(rowIndex)) next.delete(rowIndex)
                            else next.add(rowIndex)
                            return next
                          })
                        }
                      >
                        {isDeleted ? <IconUndo /> : <IconTrash />}
                      </button>
                    </td>
                  )}
                </tr>
              )
            })}
            {padBottom > 0 && (
              <tr style={{ height: padBottom }} aria-hidden="true">
                <td colSpan={set.columns.length + (editable ? 2 : 1)} />
              </tr>
            )}
          </tbody>
        </table>
        {total === 0 && <div className="grid-empty">No rows match “{filter}”.</div>}
      </div>

    </div>
  )
}

/* ————————————————————— container ————————————————————— */

interface Props {
  result: QueryResult | null
  error: string | null
  running: boolean
  hasConnection: boolean
  connectionId: string | null
  onRerun: () => void
  onCancel: () => void
  onFixWithAi?: () => void
  aiAvailable?: boolean
}

export default function ResultsView({
  result,
  error,
  running,
  hasConnection,
  connectionId,
  onRerun,
  onCancel,
  onFixWithAi,
  aiAvailable
}: Props): React.JSX.Element {
  if (running) {
    return (
      <div className="results">
        <div className="running-ind">
          <span>
            Running<span className="ellipsis" />
          </span>
          <button className="btn-mini" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="results">
        <div className="error-block">{error}</div>
        {aiAvailable && onFixWithAi && (
          <div className="error-actions">
            <button className="btn-mini" onClick={onFixWithAi}>
              Fix with AI
            </button>
          </div>
        )}
      </div>
    )
  }

  if (!result) {
    return (
      <div className="results">
        <div className="state">
          <div className="state-inner">
            {hasConnection ? (
              <>
                <h2>Ready when you are</h2>
                <p>
                  Write a query above and press <kbd>{IS_MAC ? '⌘⏎' : 'Ctrl ⏎'}</kbd> — or click a
                  table in the sidebar to peek inside.
                </p>
              </>
            ) : (
              <>
                <h2>No connection</h2>
                <p>
                  Pick a database from the sidebar, or press{' '}
                  <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd> to search everything.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="results">
      {result.sets.map((set, i) => (
        <ResultGrid
          key={i}
          set={set}
          connectionId={connectionId}
          onChanged={onRerun}
          readOnly={false}
        />
      ))}
    </div>
  )
}

