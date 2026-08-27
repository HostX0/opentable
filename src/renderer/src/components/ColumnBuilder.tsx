import { useCallback, useEffect, useRef, useState } from 'react'
import type { Driver, SchemaTable } from '../../../shared/types'
import { COLUMN_TYPES, FK_ACTIONS, isAutoIncrement, type ColumnDef } from '../../../shared/sql'
import { IconGrip, IconLink, IconPlus, IconTrash } from './icons'

export interface ColumnIssue {
  index: number
  message: string
}

interface Props<T extends ColumnDef> {
  driver: Driver
  tables: SchemaTable[]
  columns: T[]
  issues: ColumnIssue[]
  onChange: (next: T[]) => void
  makeBlank: () => T
  /** reordering is meaningless for ALTER, which cannot move columns */
  allowReorder?: boolean
  /** the primary key of an existing table cannot be changed by ALTER */
  lockKeys?: boolean
}

/** Shared column grid used by both the new-table builder and the table editor. */
export default function ColumnBuilder<T extends ColumnDef>({
  driver,
  tables,
  columns,
  issues,
  onChange,
  makeBlank,
  allowReorder = true,
  lockKeys = false
}: Props<T>): React.JSX.Element {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const dropAtRef = useRef<number | null>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const focusLast = useRef(false)
  const lastNameRef = useRef<HTMLInputElement>(null)

  const patch = (i: number, next: Partial<ColumnDef>): void => {
    onChange(columns.map((c, n) => (n === i ? { ...c, ...next } : c)) as T[])
  }

  const addColumn = useCallback((): void => {
    focusLast.current = true
    onChange([...columns, makeBlank()])
  }, [columns, makeBlank, onChange])

  useEffect(() => {
    if (focusLast.current) {
      focusLast.current = false
      lastNameRef.current?.focus()
    }
  }, [columns.length])

  const moveColumn = useCallback(
    (from: number, insertAt: number): void => {
      const target = insertAt > from ? insertAt - 1 : insertAt
      if (target === from || from < 0 || target < 0 || target >= columns.length) return
      const next = [...columns]
      const [moved] = next.splice(from, 1)
      next.splice(target, 0, moved)
      onChange(next)
    },
    [columns, onChange]
  )

  const startDrag = (index: number, e: React.MouseEvent): void => {
    if (!allowReorder) return
    e.preventDefault()
    setDragFrom(index)
    setDropAt(index)
    dropAtRef.current = index
  }

  useEffect(() => {
    if (dragFrom === null) return
    const move = (e: MouseEvent): void => {
      let gap = columns.length
      for (let n = 0; n < columns.length; n++) {
        const el = rowRefs.current[n]
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) {
          gap = n
          break
        }
      }
      dropAtRef.current = gap
      setDropAt(gap)
    }
    const up = (): void => {
      const gap = dropAtRef.current
      if (gap !== null) moveColumn(dragFrom, gap)
      setDragFrom(null)
      setDropAt(null)
      dropAtRef.current = null
    }
    document.body.classList.add('dragging-row')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      document.body.classList.remove('dragging-row')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragFrom, columns.length, moveColumn])

  const removeColumn = (i: number): void => {
    onChange(columns.filter((_, n) => n !== i) as T[])
  }

  const issueFor = (i: number): string | undefined => issues.find((x) => x.index === i)?.message

  return (
    <div className="builder-columns">
        <div className="col-head">
          <span />
          <span>Column</span>
          <span>Type</span>
          <span className="col-flag">Null</span>
          <span className="col-flag">Key</span>
          <span className="col-flag">Uniq</span>
          <span>Default</span>
          <span />
          <span />
        </div>

        {columns.map((c, i) => {
          const auto = isAutoIncrement(c.type)
          const bad = issueFor(i)
          return (
            <div
              className="col-group"
              key={c.id ?? i}
              ref={(el) => {
                rowRefs.current[i] = el
              }}
            >
              {dropAt === i && dragFrom !== null && <div className="drop-line" />}
              <div className={`col-row ${dragFrom === i ? 'lifted' : ''}`}>
              <button
                className="col-grip"
                title="Drag to reorder, or use the arrow keys"
                aria-label={`Reorder column ${i + 1}`}
                onMouseDown={(e) => startDrag(i, e)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    moveColumn(i, i - 1)
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    moveColumn(i, i + 2)
                  }
                }}
              >
                <IconGrip />
              </button>

              <span className="col-cell">
                <input
                  ref={i === columns.length - 1 ? lastNameRef : undefined}
                  value={c.name}
                  onChange={(e) => patch(i, { name: e.target.value })}
                  placeholder="name"
                  className={bad ? 'bad' : undefined}
                  title={bad}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && i === columns.length - 1 && c.name.trim()) addColumn()
                  }}
                />
              </span>

              {/* editable combo: pick a common type or type your own */}
              <span className="col-cell">
                <input
                  list={`types-${driver}`}
                  value={c.type}
                  onChange={(e) => patch(i, { type: e.target.value })}
                  placeholder="type"
                />
              </span>

              <span className="col-flag">
                <input
                  type="checkbox"
                  checked={c.nullable && !c.primaryKey}
                  disabled={c.primaryKey}
                  onChange={(e) => patch(i, { nullable: e.target.checked })}
                  title={c.primaryKey ? 'Primary keys cannot be NULL' : 'Allow NULL'}
                />
              </span>
              <span className="col-flag">
                <input
                  type="checkbox"
                  checked={c.primaryKey}
                  disabled={lockKeys}
                  onChange={(e) =>
                    patch(i, {
                      primaryKey: e.target.checked,
                      nullable: false,
                      unique: e.target.checked ? false : c.unique
                    })
                  }
                  title="Primary key"
                />
              </span>
              <span className="col-flag">
                <input
                  type="checkbox"
                  checked={c.unique && !c.primaryKey}
                  disabled={c.primaryKey}
                  onChange={(e) => patch(i, { unique: e.target.checked })}
                  title={c.primaryKey ? 'Primary keys are already unique' : 'Unique'}
                />
              </span>

              <span className="col-cell">
                <input
                  value={c.defaultValue}
                  onChange={(e) => patch(i, { defaultValue: e.target.value })}
                  placeholder={auto ? 'auto' : "e.g. 0 or 'text'"}
                  disabled={auto}
                />
              </span>

              <button
                className={`col-link ${c.references ? 'on' : ''}`}
                title={c.references ? 'Edit link to another table' : 'Link to another table'}
                onClick={() =>
                  patch(i, {
                    references: c.references
                      ? undefined
                      : {
                          table: tables[0]?.name ?? '',
                          column:
                            tables[0]?.columns.find((x) => x.isPrimary)?.name ??
                            tables[0]?.columns[0]?.name ??
                            '',
                          onDelete: 'NO ACTION',
                          onUpdate: 'NO ACTION'
                        }
                  })
                }
              >
                <IconLink />
              </button>

              <button
                className="col-del"
                title={columns.length === 1 ? 'A table needs at least one column' : 'Remove column'}
                onClick={() => removeColumn(i)}
                disabled={columns.length === 1}
              >
                <IconTrash />
              </button>
            </div>

            {c.references && (
              <div className="fk-row" key={`fk-${i}`}>
                <span className="fk-label">references</span>
                <select
                  value={c.references.table}
                  onChange={(e) => {
                    const t = tables.find((x) => x.name === e.target.value)
                    patch(i, {
                      references: {
                        ...c.references!,
                        table: e.target.value,
                        column:
                          t?.columns.find((x) => x.isPrimary)?.name ?? t?.columns[0]?.name ?? ''
                      }
                    })
                  }}
                >
                  {tables.length === 0 && <option value="">no tables yet</option>}
                  {tables.map((t) => (
                    <option key={`${t.schema}.${t.name}`} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <select
                  value={c.references.column}
                  onChange={(e) =>
                    patch(i, { references: { ...c.references!, column: e.target.value } })
                  }
                >
                  {(tables.find((t) => t.name === c.references!.table)?.columns ?? []).map((col) => (
                    <option key={col.name} value={col.name}>
                      {col.name}
                    </option>
                  ))}
                </select>
                <span className="fk-label">on delete</span>
                <select
                  value={c.references.onDelete}
                  onChange={(e) =>
                    patch(i, {
                      references: { ...c.references!, onDelete: e.target.value as never }
                    })
                  }
                >
                  {FK_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a.toLowerCase()}
                    </option>
                  ))}
                </select>
                <span className="fk-label">on update</span>
                <select
                  value={c.references.onUpdate}
                  onChange={(e) =>
                    patch(i, {
                      references: { ...c.references!, onUpdate: e.target.value as never }
                    })
                  }
                >
                  {FK_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a.toLowerCase()}
                    </option>
                  ))}
                </select>
                <button className="fk-clear" onClick={() => patch(i, { references: undefined })}>
                  Remove link
                </button>
              </div>
            )}
          </div>
          )
        })}

        {dropAt === columns.length && dragFrom !== null && <div className="drop-line" />}

        <datalist id={`types-${driver}`}>
          {COLUMN_TYPES[driver].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

      <button className="col-add" onClick={addColumn}>
        <IconPlus /> Add column
      </button>
    </div>
  )
}

