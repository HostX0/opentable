import { useEffect, useMemo, useState } from 'react'
import type { Driver } from '../../../shared/types'
import { buildCreateDatabase, isSafeIdent } from '../../../shared/sql'

interface Props {
  driver: Driver
  busy: boolean
  error: string | null
  onCreate: (ddl: string, name: string) => void
  onClose: () => void
}

const ENCODINGS: Record<'postgres' | 'mysql', { value: string; label: string }[]> = {
  postgres: [
    { value: 'UTF8', label: 'UTF8' },
    { value: 'LATIN1', label: 'LATIN1' },
    { value: 'SQL_ASCII', label: 'SQL_ASCII' }
  ],
  mysql: [
    { value: 'utf8mb4', label: 'utf8mb4 — full Unicode' },
    { value: 'utf8', label: 'utf8' },
    { value: 'latin1', label: 'latin1' }
  ]
}

export default function CreateDatabaseModal({
  driver,
  busy,
  error,
  onCreate,
  onClose
}: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [encoding, setEncoding] = useState(driver === 'mysql' ? 'utf8mb4' : 'UTF8')
  const [showSql, setShowSql] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // an empty field speaks for itself; only flag input that will actually fail
  const incomplete = !name.trim()
  const problem = name.trim() && !isSafeIdent(name.trim()) ? 'Letters, digits and _ only' : null

  const ddl = useMemo(
    () => (name.trim() ? buildCreateDatabase(driver, name.trim(), { encoding }) : ''),
    [driver, name, encoding]
  )

  // SQLite has no server-side databases — a database is simply a file
  if (driver === 'sqlite') {
    return (
      <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="modal-head">
            <h3>New database</h3>
          </div>
          <div className="modal-body">
            <p className="field-note">
              A SQLite database is just a file, so there is nothing to create on a server. Add a new
              connection and point it at a new <code>.db</code> path — OpenTable creates the file when
              it first connects.
            </p>
          </div>
          <div className="modal-foot">
            <span className="spacer" />
            <button className="btn primary" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h3>New database</h3>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="analytics"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !incomplete && !problem && !busy) onCreate(ddl, name.trim())
              }}
            />
          </div>

          <div className="field">
            <label>{driver === 'mysql' ? 'Character set' : 'Encoding'}</label>
            <select value={encoding} onChange={(e) => setEncoding(e.target.value)}>
              {ENCODINGS[driver === 'mysql' ? 'mysql' : 'postgres'].map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <button className="sql-toggle" onClick={() => setShowSql((v) => !v)}>
            {showSql ? 'Hide' : 'Show'} SQL
          </button>
          {showSql && <pre className="sql-preview">{ddl || '—'}</pre>}
        </div>

        {error && (
          <div className="test-banner err">
            <span className="test-mark">!</span>
            <span className="test-text">{error}</span>
          </div>
        )}

        <div className="modal-foot">
          {problem && <span className="foot-hint">{problem}</span>}
          <span className="spacer" />
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={incomplete || Boolean(problem) || busy}
            onClick={() => onCreate(ddl, name.trim())}
          >
            {busy ? 'Creating…' : 'Create database'}
          </button>
        </div>
      </div>
    </div>
  )
}
