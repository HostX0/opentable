import type { SchemaTable } from '../../../shared/types'
import { FK_ACTIONS } from '../../../shared/sql'
import type { EditableForeignKey, EditableIndex } from '../../../shared/alter'
import { IconPlus, IconTrash, IconUndo } from './icons'

/** Multi-select over the table's own columns, used by indexes and foreign keys. */
function ColumnPicker({
  available,
  selected,
  onChange,
  disabled
}: {
  available: string[]
  selected: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const toggle = (name: string): void => {
    onChange(selected.includes(name) ? selected.filter((c) => c !== name) : [...selected, name])
  }
  return (
    <span className="col-picker">
      {available.map((name) => (
        <button
          key={name}
          type="button"
          disabled={disabled}
          className={`pick ${selected.includes(name) ? 'on' : ''}`}
          onClick={() => toggle(name)}
          title={selected.includes(name) ? `Remove ${name}` : `Add ${name}`}
        >
          {name}
        </button>
      ))}
    </span>
  )
}

/* ————————————————————————— indexes ————————————————————————— */

export function IndexEditor({
  columnNames,
  indexes,
  onChange
}: {
  columnNames: string[]
  indexes: EditableIndex[]
  onChange: (next: EditableIndex[]) => void
}): React.JSX.Element {
  const patch = (id: string, next: Partial<EditableIndex>): void =>
    onChange(indexes.map((i) => (i.id === id ? { ...i, ...next } : i)))

  return (
    <div className="constraint-editor">
      {indexes.map((ix) => (
        <div key={ix.id} className={`constraint-row ${ix.dropped ? 'removed' : ''}`}>
          <input
            value={ix.name}
            onChange={(e) => patch(ix.id, { name: e.target.value })}
            placeholder="index name"
            disabled={Boolean(ix.originalName) || ix.primary}
          />
          <ColumnPicker
            available={columnNames}
            selected={ix.columns}
            onChange={(columns) => patch(ix.id, { columns })}
            disabled={Boolean(ix.originalName) || ix.primary}
          />
          <label className="constraint-flag">
            <input
              type="checkbox"
              checked={ix.unique}
              disabled={Boolean(ix.originalName) || ix.primary}
              onChange={(e) => patch(ix.id, { unique: e.target.checked })}
            />
            unique
          </label>
          {ix.primary ? (
            <span className="constraint-note">primary key — edit it on the Columns tab</span>
          ) : (
            <button
              className="constraint-del"
              title={ix.dropped ? 'Keep this index' : 'Drop this index'}
              onClick={() =>
                ix.originalName
                  ? patch(ix.id, { dropped: !ix.dropped })
                  : onChange(indexes.filter((x) => x.id !== ix.id))
              }
            >
              {ix.dropped ? <IconUndo /> : <IconTrash />}
            </button>
          )}
        </div>
      ))}

      <button
        className="col-add"
        onClick={() =>
          onChange([
            ...indexes,
            { id: crypto.randomUUID(), name: '', columns: [], unique: false, primary: false }
          ])
        }
      >
        <IconPlus /> Add index
      </button>
    </div>
  )
}

/* ————————————————————————— foreign keys ————————————————————————— */

export function ForeignKeyEditor({
  columnNames,
  tables,
  foreignKeys,
  onChange
}: {
  columnNames: string[]
  tables: SchemaTable[]
  foreignKeys: EditableForeignKey[]
  onChange: (next: EditableForeignKey[]) => void
}): React.JSX.Element {
  const patch = (id: string, next: Partial<EditableForeignKey>): void =>
    onChange(foreignKeys.map((f) => (f.id === id ? { ...f, ...next } : f)))

  return (
    <div className="constraint-editor">
      {foreignKeys.map((fk) => {
        const refTable = tables.find((t) => t.name === fk.refTable)
        const locked = Boolean(fk.originalName)
        return (
          <div key={fk.id} className={`constraint-row fk ${fk.dropped ? 'removed' : ''}`}>
            <ColumnPicker
              available={columnNames}
              selected={fk.columns}
              onChange={(columns) => patch(fk.id, { columns })}
              disabled={locked}
            />
            <span className="fk-label">references</span>
            <select
              value={fk.refTable}
              disabled={locked}
              onChange={(e) => {
                const t = tables.find((x) => x.name === e.target.value)
                patch(fk.id, {
                  refTable: e.target.value,
                  refColumns: t?.columns.filter((c) => c.isPrimary).map((c) => c.name) ?? []
                })
              }}
            >
              <option value="">choose a table…</option>
              {tables.map((t) => (
                <option key={`${t.schema}.${t.name}`} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
            <ColumnPicker
              available={refTable?.columns.map((c) => c.name) ?? []}
              selected={fk.refColumns}
              onChange={(refColumns) => patch(fk.id, { refColumns })}
              disabled={locked}
            />
            <span className="fk-label">on delete</span>
            <select
              value={fk.onDelete}
              disabled={locked}
              onChange={(e) => patch(fk.id, { onDelete: e.target.value as never })}
            >
              {FK_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a.toLowerCase()}
                </option>
              ))}
            </select>
            <button
              className="constraint-del"
              title={fk.dropped ? 'Keep this foreign key' : 'Drop this foreign key'}
              onClick={() =>
                fk.originalName
                  ? patch(fk.id, { dropped: !fk.dropped })
                  : onChange(foreignKeys.filter((x) => x.id !== fk.id))
              }
            >
              {fk.dropped ? <IconUndo /> : <IconTrash />}
            </button>
          </div>
        )
      })}

      <button
        className="col-add"
        onClick={() =>
          onChange([
            ...foreignKeys,
            {
              id: crypto.randomUUID(),
              columns: [],
              refTable: '',
              refColumns: [],
              onDelete: 'NO ACTION',
              onUpdate: 'NO ACTION'
            }
          ])
        }
      >
        <IconPlus /> Add foreign key
      </button>
    </div>
  )
}
