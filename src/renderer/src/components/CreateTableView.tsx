import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Driver } from '../../../shared/types'
import { buildCreateTable, COLUMN_TYPES, isSafeIdent, type ColumnDef } from '../../../shared/sql'
import type { SchemaTable } from '../../../shared/types'
import ColumnBuilder from './ColumnBuilder'
import SqlPreview from './SqlPreview'

export interface TableDraft {
  name: string
  columns: ColumnDef[]
}

const blankColumn = (driver: Driver): ColumnDef => ({
  id: crypto.randomUUID(),
  name: '',
  type: COLUMN_TYPES[driver][0],
  nullable: true,
  primaryKey: false,
  unique: false,
  defaultValue: '',
  references: undefined
})

export function newTableDraft(driver: Driver): TableDraft {
  return {
    name: '',
    columns: [
      {
        id: crypto.randomUUID(),
        name: 'id',
        type:
          driver === 'postgres' ? 'serial' : driver === 'mysql' ? 'INT AUTO_INCREMENT' : 'INTEGER',
        nullable: false,
        primaryKey: true,
        unique: false,
        defaultValue: '',
        references: undefined
      },
      blankColumn(driver)
    ]
  }
}

interface Props {
  driver: Driver
  schemaName: string
  /** existing tables, so a column can be linked to one */
  tables: SchemaTable[]
  draft: TableDraft
  busy: boolean
  error: string | null
  onChange: (next: TableDraft) => void
  onCreate: (ddl: string, tableName: string) => void
  onCancel: () => void
}

interface FieldIssue {
  index: number
  field: 'name'
  message: string
}

export default function CreateTableView({
  driver,
  schemaName,
  tables,
  draft,
  busy,
  error,
  onChange,
  onCreate,
  onCancel
}: Props): React.JSX.Element {
  const { name, columns } = draft
  const [sqlHeight, setSqlHeight] = useState(200)
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  /* ——— validation, reported per field as well as in the header ——— */
  const named = useMemo(() => columns.filter((c) => c.name.trim()), [columns])

  const issues = useMemo(() => {
    const list: FieldIssue[] = []
    const seen = new Map<string, number>()
    columns.forEach((c, i) => {
      const raw = c.name.trim()
      if (!raw) return
      if (!isSafeIdent(raw)) {
        list.push({ index: i, field: 'name', message: 'Use letters, digits and _ only' })
        return
      }
      const key = raw.toLowerCase()
      if (seen.has(key)) list.push({ index: i, field: 'name', message: 'Duplicate column name' })
      else seen.set(key, i)
    })
    return list
  }, [columns])

  /** Blocks Create, but is not worth saying out loud — the empty field shows it. */
  const incomplete = !name.trim() || named.length === 0

  /** Worth surfacing: the user typed something that will not work. */
  const headline = useMemo(() => {
    if (name.trim() && !isSafeIdent(name.trim())) return 'Table name: letters, digits and _ only'
    if (issues.length > 0) return `${issues[0].message} (row ${issues[0].index + 1})`
    return null
  }, [name, issues])

  const valid = !incomplete && headline === null

  const ddl = useMemo(
    () => (name.trim() ? buildCreateTable(driver, schemaName, name.trim(), columns) : ''),
    [driver, schemaName, name, columns]
  )

  const submit = useCallback((): void => {
    if (valid && !busy) onCreate(ddl, name.trim())
  }, [valid, busy, onCreate, ddl, name])

  /* ——— ⌘⏎ creates, matching Run in the query editor ——— */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    }
    const el = rootRef.current
    el?.addEventListener('keydown', onKey)
    return () => el?.removeEventListener('keydown', onKey)
  }, [submit])

  /* ——— resizable split, same behaviour as the editor / results divider ——— */
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const box = rootRef.current?.getBoundingClientRect()
      if (!box) return
      const fromBottom = box.bottom - e.clientY
      setSqlHeight(Math.min(box.height - 180, Math.max(96, fromBottom)))
    }
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging])

  const issueFor = (i: number): string | undefined =>
    issues.find((x) => x.index === i)?.message

  return (
    <div className="results builder" ref={rootRef}>
      <div className="builder-head">
        <div className="field builder-name">
          <label htmlFor="tbl-name">Table name</label>
          <input
            id="tbl-name"
            autoFocus
            value={name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="customers"
            className={name.trim() && !isSafeIdent(name.trim()) ? 'bad' : undefined}
          />
        </div>
        <span className="spacer" />
        {headline && <span className="foot-hint">{headline}</span>}
        <button className="tool-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="tool-btn solid" disabled={!valid || busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create table'}
        </button>
      </div>

      {error && <div className="error-block inline">{error}</div>}

      <ColumnBuilder
        driver={driver}
        tables={tables}
        columns={columns}
        issues={issues}
        onChange={(next) => onChange({ ...draft, columns: next })}
        makeBlank={() => blankColumn(driver)}
      />

      <div
        className={`drag-handle ${dragging ? 'dragging' : ''}`}
        onMouseDown={() => setDragging(true)}
      />

      <div className="builder-sql" style={{ height: sqlHeight }}>
        <div className="builder-sql-bar">
          <span className="builder-sql-label">SQL</span>
          <span className="spacer" />
          <button
            className="btn-ghost"
            disabled={!ddl}
            onClick={() => {
              navigator.clipboard.writeText(ddl)
              setCopied(true)
              setTimeout(() => setCopied(false), 1600)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {ddl ? (
          <SqlPreview code={ddl} driver={driver} />
        ) : (
          <div className="builder-sql-empty">Name the table to see its SQL.</div>
        )}
      </div>
    </div>
  )
}
