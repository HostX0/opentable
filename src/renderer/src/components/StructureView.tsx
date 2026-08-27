import { useMemo, useState } from 'react'
import type { Driver, SchemaTable, TableDetails } from '../../../shared/types'
import { COLUMN_TYPES, isSafeIdent } from '../../../shared/sql'
import {
  buildAlterPlan,
  toEditable,
  type EditableColumn,
  type EditableForeignKey,
  type EditableIndex
} from '../../../shared/alter'
import { ForeignKeyEditor, IndexEditor } from './ConstraintEditor'
import ColumnBuilder from './ColumnBuilder'
import SqlPreview from './SqlPreview'

interface Props {
  details: TableDetails
  driver: Driver
  tables: SchemaTable[]
  busy: boolean
  error: string | null
  onQuery: (sql: string) => void
  onApply: (statements: string[], destructive: boolean, summary: string[]) => void
}

type Pane = 'columns' | 'indexes' | 'keys' | 'ddl'

export default function StructureView({
  details,
  driver,
  tables,
  busy,
  error,
  onQuery,
  onApply
}: Props): React.JSX.Element {
  const [pane, setPane] = useState<Pane>('columns')
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(details.name)
  const [editColumns, setEditColumns] = useState<EditableColumn[]>([])
  const [editIndexes, setEditIndexes] = useState<EditableIndex[]>([])
  const [editFks, setEditFks] = useState<EditableForeignKey[]>([])

  const original = useMemo(() => toEditable(details.columns ?? []), [details])

  const beginEdit = (): void => {
    setEditName(details.name)
    setEditColumns(toEditable(details.columns ?? []))
    setEditIndexes(
      (details.indexes ?? []).map((i) => ({
        id: `db:${i.name}`,
        name: i.name,
        originalName: i.name,
        columns: i.columns ?? [],
        unique: i.unique,
        primary: i.primary
      }))
    )
    setEditFks(
      (details.foreignKeys ?? []).map((f) => ({
        id: `db:${f.name}`,
        originalName: f.name,
        name: f.name,
        columns: f.columns ?? [],
        refTable: f.refTable,
        refColumns: f.refColumns ?? [],
        onDelete: 'NO ACTION' as const,
        onUpdate: 'NO ACTION' as const
      }))
    )
    setPane('columns')
    setEditing(true)
  }

  const issues = useMemo(() => {
    const list: { index: number; message: string }[] = []
    const seen = new Map<string, number>()
    editColumns.forEach((c, i) => {
      const raw = c.name.trim()
      if (!raw) return
      if (!isSafeIdent(raw)) list.push({ index: i, message: 'Use letters, digits and _ only' })
      else if (seen.has(raw.toLowerCase())) list.push({ index: i, message: 'Duplicate column name' })
      else seen.set(raw.toLowerCase(), i)
    })
    return list
  }, [editColumns])

  const plan = useMemo(
    () =>
      editing
        ? buildAlterPlan({
            driver,
            schemaName: details.schema,
            originalName: details.name,
            originalColumns: original,
            nextName: editName,
            nextColumns: editColumns,
            nextIndexes: editIndexes,
            nextForeignKeys: editFks
          })
        : null,
    [editing, driver, details, original, editName, editColumns, editIndexes, editFks]
  )

  const planSql = plan?.statements.map((s) => s.sql).join('\n') ?? ''
  const hasChanges = (plan?.statements.length ?? 0) > 0
  const destructive = plan?.statements.some((s) => s.destructive) ?? false
  const canApply = hasChanges && issues.length === 0 && editName.trim().length > 0 && !busy

  const qualified =
    details.schema && details.schema !== 'public' && details.schema !== 'main'
      ? `${details.schema}.${details.name}`
      : details.name

  return (
    <div className="results structure">
      <div className="struct-head">
        <div className="struct-title">
          <h3>{details.name}</h3>
          <span className="struct-sub">
            {details.kind} · {(details.columns ?? []).length} columns
            {details.rowCount !== null && ` · ${details.rowCount.toLocaleString()} rows`}
          </span>
        </div>
        <span className="spacer" />
        {editing ? (
          <>
            {destructive && <span className="foot-hint warn">contains destructive changes</span>}
            {!hasChanges && <span className="foot-hint">no changes yet</span>}
            <button className="tool-btn" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
            <button
              className="tool-btn solid"
              disabled={!canApply}
              onClick={() =>
                onApply(
                  plan!.statements.map((x) => x.sql),
                  destructive,
                  plan!.statements.map((x) => x.description)
                )
              }
            >
              {busy ? 'Applying…' : 'Apply changes'}
            </button>
          </>
        ) : (
          <>
            <button className="tool-btn" onClick={() => onQuery(`SELECT * FROM ${qualified} LIMIT 100;`)}>
              Query this table
            </button>
            {details.kind === 'table' && (
              <button className="tool-btn solid" onClick={beginEdit}>
                Edit table
              </button>
            )}
          </>
        )}
      </div>

      {editing ? (
        <>
          {error && <div className="error-block inline">{error}</div>}

          <div className="edit-name-row">
            <div className="field">
              <label>Table name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className={editName.trim() && !isSafeIdent(editName.trim()) ? 'bad' : undefined}
              />
            </div>
            {plan?.warnings.map((w) => (
              <span key={w} className="edit-warning">
                {w}
              </span>
            ))}
          </div>

          <div className="struct-tabs">
            {(
              [
                ['columns', `Columns (${editColumns.length})`],
                ['indexes', `Indexes (${editIndexes.filter((i) => !i.dropped).length})`],
                ['keys', `Foreign keys (${editFks.filter((f) => !f.dropped).length})`]
              ] as [Pane, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={`struct-tab ${pane === key ? 'on' : ''}`}
                onClick={() => setPane(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="edit-pane">
            {pane === 'columns' && (
              <ColumnBuilder
                driver={driver}
                tables={tables}
                columns={editColumns}
                issues={issues}
                onChange={setEditColumns}
                makeBlank={() => ({
                  id: crypto.randomUUID(),
                  name: '',
                  type: COLUMN_TYPES[driver][0],
                  nullable: true,
                  primaryKey: false,
                  unique: false,
                  defaultValue: ''
                })}
                allowReorder={false}
              />
            )}

            {pane === 'indexes' && (
              <IndexEditor
                columnNames={editColumns.map((c) => c.name.trim()).filter(Boolean)}
                indexes={editIndexes}
                onChange={setEditIndexes}
              />
            )}

            {pane === 'keys' && (
              <ForeignKeyEditor
                columnNames={editColumns.map((c) => c.name.trim()).filter(Boolean)}
                tables={tables}
                foreignKeys={editFks}
                onChange={setEditFks}
              />
            )}
          </div>

          <div className="builder-sql edit-sql">
            <div className="builder-sql-bar">
              <span className="builder-sql-label">
                {hasChanges ? `${plan!.statements.length} statement${plan!.statements.length === 1 ? '' : 's'}` : 'SQL'}
              </span>
              <span className="spacer" />
              {hasChanges && (
                <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(planSql)}>
                  Copy
                </button>
              )}
            </div>
            {hasChanges ? (
              <SqlPreview code={planSql} driver={driver} />
            ) : (
              <div className="builder-sql-empty">
                Change a column above and the SQL to apply it appears here.
              </div>
            )}
          </div>
        </>
      ) : (
      <>
      <div className="struct-tabs">
        {(
          [
            ['columns', `Columns (${(details.columns ?? []).length})`],
            ['indexes', `Indexes (${(details.indexes ?? []).length})`],
            ['keys', `Foreign keys (${(details.foreignKeys ?? []).length})`],
            ['ddl', 'DDL']
          ] as [Pane, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`struct-tab ${pane === key ? 'on' : ''}`}
            onClick={() => setPane(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="struct-body">
        {pane === 'columns' && (
          <table className="grid struct-grid">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {(details.columns ?? []).map((c) => (
                <tr key={c.name}>
                  <td>
                    {c.isPrimary && <span className="pk-dot" title="Primary key" />}
                    {c.name}
                  </td>
                  <td className="muted">{c.dataType}</td>
                  <td className="muted">{c.nullable ? 'yes' : 'no'}</td>
                  <td className="muted">{c.defaultValue ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {pane === 'indexes' && (
          <table className="grid struct-grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>Unique</th>
              </tr>
            </thead>
            <tbody>
              {(details.indexes ?? []).map((ix, i) => (
                <tr key={ix.name ?? i}>
                  <td>
                    {ix.primary && <span className="pk-dot" />}
                    {ix.name}
                  </td>
                  <td className="muted">{(ix.columns ?? []).filter(Boolean).join(', ') || '—'}</td>
                  <td className="muted">{ix.unique ? 'yes' : 'no'}</td>
                </tr>
              ))}
              {(details.indexes ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No indexes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {pane === 'keys' && (
          <table className="grid struct-grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Columns</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {(details.foreignKeys ?? []).map((fk, i) => (
                <tr key={fk.name ?? i}>
                  <td>{fk.name}</td>
                  <td className="muted">{(fk.columns ?? []).filter(Boolean).join(', ') || '—'}</td>
                  <td className="muted">
                    <button
                      className="link"
                      onClick={() => onQuery(`SELECT * FROM ${fk.refTable} LIMIT 100;`)}
                    >
                      {fk.refTable}({(fk.refColumns ?? []).filter(Boolean).join(', ')})
                    </button>
                  </td>
                </tr>
              ))}
              {(details.foreignKeys ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No foreign keys.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {pane === 'ddl' && (
          <div className="ddl-pane">
            <button className="btn-ghost copy-ddl" onClick={() => navigator.clipboard.writeText(details.ddl)}>
              Copy
            </button>
            <pre>{details.ddl}</pre>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
}
