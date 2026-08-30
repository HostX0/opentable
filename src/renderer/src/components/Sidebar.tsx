import { useEffect, useMemo, useRef, useState } from 'react'
import DropMenu, { type MenuItem } from './DropMenu'
import type { ConnectionSummary, DbSchema } from '../../../shared/types'
import {
  IconChevron,
  IconDatabase,
  IconEdit,
  IconMore,
  IconMysql,
  IconPlus,
  IconPostgres,
  IconRefresh,
  IconSearch,
  IconSqlite,
  IconTable,
  IconView
} from './icons'

export type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'lost' | 'error'

interface Props {
  connections: ConnectionSummary[]
  activeId: string | null
  states: Record<string, ConnState>
  schema: DbSchema | null
  schemaError: string | null
  databases: string[]
  onSelect: (id: string) => void
  onEdit: (conn: ConnectionSummary) => void
  onNew: () => void
  onOpenTable: (schemaName: string, table: string) => void
  onOpenStructure: (schemaName: string, table: string) => void
  onRefreshSchema: () => void
  onSwitchDatabase: (database: string) => void
  onNewDatabase: () => void
  onNewTable: () => void
  footer?: React.ReactNode
}

function DatabasePicker({
  current,
  databases,
  onPick
}: {
  current: string
  databases: string[]
  onPick: (db: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="db-picker" ref={ref}>
      <button
        className={`db-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={current || 'Select a database'}
      >
        <IconDatabase className="db-glyph" />
        <span className="db-current">{current || 'Select a database'}</span>
        <IconChevron className="db-caret" />
      </button>
      {open && (
        <div className="db-menu">
          {databases.map((d) => (
            <button
              key={d}
              className={`db-option ${d === current ? 'on' : ''}`}
              onClick={() => {
                setOpen(false)
                if (d !== current) onPick(d)
              }}
            >
              <span className="db-option-name">{d}</span>
              {d === current && <span className="db-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Sidebar({
  connections,
  activeId,
  states,
  schema,
  schemaError,
  databases,
  onSelect,
  onEdit,
  onNew,
  onOpenTable,
  onOpenStructure,
  onRefreshSchema,
  onSwitchDatabase,
  onNewDatabase,
  onNewTable,
  footer
}: Props): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{
    table: DbSchema['tables'][number]
    point: { x: number; y: number }
  } | null>(null)

  const filtered = useMemo(() => {
    if (!schema) return []
    const q = filter.trim().toLowerCase()
    return q ? schema.tables.filter((t) => t.name.toLowerCase().includes(q)) : schema.tables
  }, [schema, filter])

  const activeState = activeId ? states[activeId] : undefined

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <span className="wordmark">
          OpenTable<span className="dot">.</span>
        </span>
      </div>
      <div className="sidebar-scroll">
        <div className="side-label">
          <span>Connections</span>
          <button className="icon-btn" title="New connection" onClick={onNew}>
            <IconPlus />
          </button>
        </div>

        {connections.length === 0 && (
          <p className="side-empty">No connections yet. Add one to get started.</p>
        )}

        {connections.map((c) => {
          const st = states[c.id] ?? 'idle'
          const DriverIcon =
            c.driver === 'postgres' ? IconPostgres : c.driver === 'mysql' ? IconMysql : IconSqlite
          return (
            <button
              key={c.id}
              className={`conn-item ${activeId === c.id ? 'active' : ''} ${st} env-${c.environment ?? 'local'}`}
              onClick={() => onSelect(c.id)}
              title={
                c.driver === 'sqlite'
                  ? `${c.name} — ${c.filePath ?? ''}`
                  : `${c.name} — ${c.user}@${c.host}:${c.port}`
              }
            >
              <span className="conn-mark">
                <DriverIcon className="conn-driver-icon" />
              </span>
              <span className="conn-name">{c.name}</span>
              {c.environment === 'production' && (
                <span className="env-tag prod" title="Production">
                  prod
                </span>
              )}
              {st === 'error' && <span className="conn-note">failed</span>}
              <span
                className="conn-edit"
                title="Edit connection"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(c)
                }}
              >
                <IconEdit />
              </span>
            </button>
          )
        })}

        {activeState === 'connected' && (
          <>
            <div className="side-label">
              <span>Database</span>
              <button className="icon-btn" title="New database" onClick={onNewDatabase}>
                <IconPlus />
              </button>
            </div>
            <DatabasePicker
              current={schema?.database ?? ''}
              databases={databases}
              onPick={onSwitchDatabase}
            />
          </>
        )}

        {activeState === 'connected' && schemaError && <p className="side-error">{schemaError}</p>}

        {activeState === 'connected' && schema && (
          <>
            <div className="side-label">
              <span>Tables</span>
              <span className="label-count">{schema.tables.length}</span>
              <button className="icon-btn" title="New table" onClick={onNewTable}>
                <IconPlus />
              </button>
              <button className="icon-btn" title="Refresh schema" onClick={onRefreshSchema}>
                <IconRefresh />
              </button>
            </div>

            {schema.tables.length === 0 && (
              <p className="side-empty">
                No tables in {schema.database ? <b>{schema.database}</b> : 'this database'} yet.{' '}
                <button className="inline-link" onClick={onNewTable}>
                  Create one
                </button>
                .
              </p>
            )}

            {schema.tables.length > 0 && (
              <div className="filter-wrap">
                <IconSearch className="filter-icon" />
                <input
                  className="table-filter"
                  placeholder="Filter tables"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
            )}

            {filtered.map((t) => (
              <button
                key={`${t.schema}.${t.name}`}
                className="table-item"
                title={`${t.schema}.${t.name} — ${t.columns.length} columns`}
                onClick={() => onOpenTable(t.schema, t.name)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ table: t, point: { x: e.clientX, y: e.clientY } })
                }}
              >
                {t.kind === 'view' ? (
                  <IconView className="t-glyph" />
                ) : (
                  <IconTable className="t-glyph" />
                )}
                <span className="t-name">{t.name}</span>
                <span className="t-count">{t.columns.length}</span>
                <span
                  className="t-more"
                  title="More actions"
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu({ table: t, point: { x: r.right - 4, y: r.bottom + 4 } })
                  }}
                >
                  <IconMore />
                </span>
              </button>
            ))}

            {schema.tables.length > 0 && filtered.length === 0 && (
              <p className="side-empty">No tables match “{filter}”.</p>
            )}
          </>
        )}
      </div>
      {footer && <div className="sidebar-foot">{footer}</div>}

      {menu && (
        <DropMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          items={buildTableMenu(menu.table, onOpenTable, onOpenStructure)}
        />
      )}
    </aside>
  )
}

function buildTableMenu(
  t: DbSchema['tables'][number],
  onOpenTable: (schema: string, table: string) => void,
  onOpenStructure: (schema: string, table: string) => void
): MenuItem[] {
  const qualified =
    t.schema && t.schema !== 'public' && t.schema !== 'main' ? `${t.schema}.${t.name}` : t.name
  return [
    { label: 'Open data', onSelect: () => onOpenTable(t.schema, t.name) },
    { label: 'View structure', onSelect: () => onOpenStructure(t.schema, t.name) },
    {
      label: 'Copy name',
      separatorBefore: true,
      onSelect: () => navigator.clipboard.writeText(t.name)
    },
    {
      label: 'Copy SELECT statement',
      onSelect: () => navigator.clipboard.writeText(`SELECT * FROM ${qualified} LIMIT 100;`)
    }
  ]
}
