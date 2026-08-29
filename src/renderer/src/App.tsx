import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar, { type ConnState } from './components/Sidebar'
import SqlEditor, { type EditorHandle } from './components/SqlEditor'
import ResultsView from './components/ResultsView'
import StructureView from './components/StructureView'
import ConnectionModal from './components/ConnectionModal'
import CommandPalette, { type Command } from './components/CommandPalette'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import CreateTableView, { newTableDraft, type TableDraft } from './components/CreateTableView'
import CreateDatabaseModal from './components/CreateDatabaseModal'
import ErrorBoundary from './components/ErrorBoundary'
import DropMenu, { type MenuItem } from './components/DropMenu'
import AiBar, { type AiAction } from './components/AiBar'
import ChatPanel from './components/ChatPanel'
import QueryDoctor from './components/QueryDoctor'
import { IconHistory, IconSettings, IconAi, IconStar } from './components/icons'
import type {
  AppSettings,
  ConnectionConfig,
  ConnectionSummary,
  DbSchema,
  HistoryEntry,
  QueryResult,
  SavedQuery,
  TableDetails
} from '../../shared/types'
import type { SafetyCheck, UpdateState } from '../../preload/index.d'

interface Tab {
  id: string
  title: string
  kind: 'query' | 'structure' | 'newtable'
  /**
   * Identity for reuse. Table and structure tabs are unique per connection, so
   * opening the same table twice focuses the existing tab instead of stacking
   * duplicates. Scratch query tabs have no key and are always new.
   */
  key?: string
  sql: string
  result: QueryResult | null
  error: string | null
  running: boolean
  details?: TableDetails
  /** draft held on the tab so switching away does not lose it */
  draft?: TableDraft
  /** exact SQL that produced `result`, so Re-run after an edit repeats it */
  lastRun?: string
}

const newTab = (title: string, sql = ''): Tab => ({
  id: crypto.randomUUID(),
  title,
  kind: 'query',
  sql,
  result: null,
  error: null,
  running: false
})

/** Lowest unused "Query N", so numbering stays tidy as tabs come and go. */
function nextQueryName(tabs: { title: string }[]): string {
  const used = new Set(
    tabs
      .map((t) => /^Query (\d+)$/.exec(t.title)?.[1])
      .filter((n): n is string => Boolean(n))
      .map(Number)
  )
  let n = 1
  while (used.has(n)) n++
  return `Query ${n}`
}

export default function App(): React.JSX.Element {
  const [connections, setConnections] = useState<ConnectionSummary[]>([])
  const [states, setStates] = useState<Record<string, ConnState>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [schemas, setSchemas] = useState<Record<string, DbSchema>>({})
  const [schemaErrors, setSchemaErrors] = useState<Record<string, string | null>>({})
  const [databases, setDatabases] = useState<Record<string, string[]>>({})
  const [serverVersion, setServerVersion] = useState('')
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab('Query 1')])
  const [activeTabId, setActiveTabId] = useState('')
  const [modal, setModal] = useState<{ open: boolean; editing: ConnectionSummary | null }>({
    open: false,
    editing: null
  })
  const [settings, setSettings] = useState<AppSettings>({
    defaultRowLimit: 500,
    confirmDestructive: true,
    hasAiKey: false,
    aiProvider: 'anthropic',
    aiBaseUrl: '',
    aiModel: 'claude-sonnet-5'
  })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiAction, setAiAction] = useState<AiAction>('ask')
  const [doctorSql, setDoctorSql] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [confirm, setConfirm] = useState<{ check: SafetyCheck; sql: string; tabId: string } | null>(
    null
  )
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' })
  const [tabMenu, setTabMenu] = useState<{ id: string; point: { x: number; y: number } } | null>(
    null
  )
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [creatingDatabase, setCreatingDatabase] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [alterConfirm, setAlterConfirm] = useState<{
    statements: string[]
    summary: string[]
    tabId: string
  } | null>(null)

  const [editorHeight, setEditorHeight] = useState(240)
  const [dragging, setDragging] = useState(false)

  const editorRef = useRef<EditorHandle | null>(null)
  const activeTabRef = useRef<HTMLButtonElement | null>(null)

  const isMac = window.opentable.platform === 'darwin'
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const activeConn = connections.find((c) => c.id === activeId) ?? null
  const activeState: ConnState = activeId ? (states[activeId] ?? 'idle') : 'idle'
  const schema = activeId ? (schemas[activeId] ?? null) : null

  /* ————————————————— boot ————————————————— */

  useEffect(() => {
    document.body.classList.add(isMac ? 'mac' : 'win')
    window.opentable.connections.list().then(setConnections)
    window.opentable.settings.get().then(setSettings)
    window.opentable.history.list(100).then(setHistory)
    window.opentable.saved.list().then(setSaved)
    const off = window.opentable.updates.onState(setUpdateState)
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeTabId && tabs.length) setActiveTabId(tabs[0].id)
  }, [activeTabId, tabs])

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  useEffect(() => {
    if (activeConn?.environment === 'production') document.body.classList.add('prod-mode')
    else document.body.classList.remove('prod-mode')
  }, [activeConn])

  const setTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const commitRename = useCallback(
    (id: string, value: string) => {
      const v = value.trim()
      if (v) setTab(id, { title: v })
      setRenamingId(null)
    },
    [setTab]
  )

  /* ————————————————— connections ————————————————— */

  const refreshSchema = useCallback(async (connId: string) => {
    const res = await window.opentable.db.schema(connId)
    if (res.ok && res.schema) {
      setSchemas((s) => ({ ...s, [connId]: res.schema! }))
      setSchemaErrors((e) => ({ ...e, [connId]: null }))
    } else {
      setSchemaErrors((e) => ({ ...e, [connId]: res.error ?? 'Could not load schema' }))
    }
    const dbs = await window.opentable.db.databases(connId)
    if (dbs.ok && dbs.databases) setDatabases((d) => ({ ...d, [connId]: dbs.databases! }))
  }, [])

  const selectConnection = useCallback(
    async (id: string) => {
      setActiveId(id)
      if (states[id] === 'connected') return
      setStates((s) => ({ ...s, [id]: 'connecting' }))
      const res = await window.opentable.db.connect(id)
      if (res.ok) {
        setStates((s) => ({ ...s, [id]: 'connected' }))
        setServerVersion(res.serverVersion ?? '')
        refreshSchema(id)
      } else {
        setStates((s) => ({ ...s, [id]: 'error' }))
        setSchemaErrors((e) => ({ ...e, [id]: res.error ?? 'Connection failed' }))
      }
    },
    [states, refreshSchema]
  )

  const switchDatabase = useCallback(
    async (database: string) => {
      if (!activeId || !database) return
      setStates((s) => ({ ...s, [activeId]: 'connecting' }))
      const res = await window.opentable.db.useDatabase(activeId, database)
      if (res.ok) {
        setStates((s) => ({ ...s, [activeId]: 'connected' }))
        setConnections(await window.opentable.connections.list())
        refreshSchema(activeId)
      } else {
        setStates((s) => ({ ...s, [activeId]: 'error' }))
        setSchemaErrors((e) => ({ ...e, [activeId]: res.error ?? 'Could not switch database' }))
      }
    },
    [activeId, refreshSchema]
  )

  const saveConnection = useCallback(async (cfg: ConnectionConfig) => {
    setConnections(await window.opentable.connections.save(cfg))
    setModal({ open: false, editing: null })
  }, [])

  const deleteConnection = useCallback(async (id: string) => {
    setConnections(await window.opentable.connections.delete(id))
    setStates((s) => ({ ...s, [id]: 'idle' }))
    setActiveId((a) => (a === id ? null : a))
    setModal({ open: false, editing: null })
  }, [])

  /* ————————————————— running queries ————————————————— */

  const execute = useCallback(
    async (tabId: string, sqlText: string) => {
      if (!activeId) return
      setTab(tabId, { running: true, error: null })
      const res = await window.opentable.db.query(activeId, sqlText)
      if (res.ok && res.result) {
        setTab(tabId, { running: false, result: res.result, error: null, lastRun: sqlText })
      } else {
        setTab(tabId, { running: false, error: res.error ?? 'Query failed', lastRun: sqlText })
      }
      window.opentable.history.list(100).then(setHistory)
      if (/\b(create|drop|alter|rename)\b/i.test(sqlText)) refreshSchema(activeId)
    },
    [activeId, setTab, refreshSchema]
  )

  const runSql = useCallback(
    async (tabId: string, sqlText: string) => {
      if (!activeId || states[activeId] !== 'connected') {
        setTab(tabId, { error: 'Not connected — pick a connection in the sidebar first.' })
        return
      }
      const text = sqlText.trim()
      if (!text) return

      const check = await window.opentable.safety.check(activeId, text)
      if (check.needsConfirm) {
        setConfirm({ check, sql: text, tabId })
        return
      }
      await execute(tabId, text)
    },
    [activeId, states, setTab, execute]
  )

  const runActive = useCallback(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    if (!t || t.running || t.kind !== 'query') return
    const target = editorRef.current?.getRunTarget()?.trim()
    runSql(t.id, target || t.sql)
  }, [tabs, activeTabId, runSql])

  const openDoctor = useCallback(() => {
    if (!activeId || states[activeId] !== 'connected') return
    const t = tabs.find((x) => x.id === activeTabId)
    if (!t || t.kind !== 'query') return
    const target = editorRef.current?.getRunTarget()?.trim()
    const sql = (target || t.sql).trim()
    if (sql) setDoctorSql(sql)
  }, [activeId, states, tabs, activeTabId])

  const cancelActive = useCallback(async () => {
    if (!activeId) return
    const res = await window.opentable.db.cancel(activeId)
    if (!res.ok && res.error) {
      setTab(activeTabId, { running: false, error: res.error })
    }
  }, [activeId, activeTabId, setTab])

  const rerunActive = useCallback(() => {
    const t = tabs.find((x) => x.id === activeTabId)
    if (t?.lastRun) execute(t.id, t.lastRun)
  }, [tabs, activeTabId, execute])

  const fixWithAi = useCallback(async () => {
    const t = tabs.find((x) => x.id === activeTabId)
    if (!t || !activeId || !t.error) return
    const res = await window.opentable.ai.fix(activeId, t.lastRun ?? t.sql, t.error)
    if (res.ok && res.sql) {
      editorRef.current?.setDoc(res.sql)
      setTab(t.id, { sql: res.sql })
    }
  }, [tabs, activeTabId, activeId, setTab])

  const runDdl = useCallback(
    async (ddl: string, opts: { switchToDatabase?: string } = {}): Promise<boolean> => {
      if (!activeId) return false
      setCreateBusy(true)
      setCreateError(null)
      const res = await window.opentable.db.query(activeId, ddl)
      setCreateBusy(false)
      if (!res.ok) {
        setCreateError(res.error ?? 'Could not run the statement')
        return false
      }
      setCreatingDatabase(false)
      window.opentable.history.list(100).then(setHistory)
      if (opts.switchToDatabase) await switchDatabase(opts.switchToDatabase)
      else await refreshSchema(activeId)
      return true
    },
    [activeId, refreshSchema, switchDatabase]
  )

  const applyAlter = useCallback(
    async (statements: string[], tabId: string): Promise<void> => {
      if (!activeId) return
      setCreateBusy(true)
      setCreateError(null)
      const res = await window.opentable.db.alterTable(activeId, statements)
      setCreateBusy(false)
      if (!res.ok) {
        setCreateError(
          res.applied > 0
            ? `${res.error} — ${res.applied} of ${statements.length} statements had already been applied.`
            : (res.error ?? 'Could not apply the changes')
        )
        return
      }
      await refreshSchema(activeId)
      const tab = tabs.find((t) => t.id === tabId)
      const table = tab?.key?.split(':structure:')[1]
      if (table) {
        const [sch, ...rest] = table.split('.')
        const fresh = await window.opentable.db.tableDetails(activeId, sch, rest.join('.'))
        if (fresh.ok && fresh.details) {
          setTab(tabId, { details: fresh.details, title: `${fresh.details.name} · structure` })
        }
      }
      window.opentable.history.list(100).then(setHistory)
    },
    [activeId, refreshSchema, tabs, setTab]
  )

  /* ————————————————— tabs ————————————————— */

  const openTable = useCallback(
    (schemaName: string, table: string) => {
      const key = `${activeId}:table:${schemaName}.${table}`
      const existing = tabs.find((t) => t.key === key)
      if (existing) {
        setActiveTabId(existing.id)
        return
      }
      const conn = connections.find((c) => c.id === activeId)
      const quoted =
        conn?.driver === 'mysql'
          ? `\`${table}\``
          : schemaName && schemaName !== 'public' && schemaName !== 'main'
            ? `"${schemaName}"."${table}"`
            : `"${table}"`
      const sqlText = `SELECT * FROM ${quoted} LIMIT 100;`
      const t: Tab = { ...newTab(table, sqlText), key }
      setTabs((ts) => [...ts, t])
      setActiveTabId(t.id)
      execute(t.id, sqlText)
    },
    [connections, activeId, tabs, execute]
  )

  const openStructure = useCallback(
    async (schemaName: string, table: string) => {
      if (!activeId) return
      const key = `${activeId}:structure:${schemaName}.${table}`
      const existing = tabs.find((t) => t.key === key)
      if (existing) {
        setActiveTabId(existing.id)
        return
      }
      const t: Tab = { ...newTab(`${table} · structure`), kind: 'structure', key }
      setTabs((ts) => [...ts, t])
      setActiveTabId(t.id)
      const res = await window.opentable.db.tableDetails(activeId, schemaName, table)
      if (res.ok && res.details) setTab(t.id, { details: res.details })
      else setTab(t.id, { error: res.error ?? 'Could not read table structure' })
    },
    [activeId, tabs, setTab]
  )

  const openNewTable = useCallback(() => {
    setCreateError(null)
    const existing = tabs.find((t) => t.kind === 'newtable')
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    const t: Tab = {
      ...newTab('New table'),
      kind: 'newtable',
      draft: newTableDraft(activeConn?.driver ?? 'postgres')
    }
    setTabs((ts) => [...ts, t])
    setActiveTabId(t.id)
  }, [tabs, activeConn])

  const addTab = useCallback(() => {
    setTabs((ts) => {
      const t = newTab(nextQueryName(ts))
      setActiveTabId(t.id)
      return [...ts, t]
    })
  }, [])

  const closeTabs = useCallback(
    (ids: Set<string>) => {
      setTabs((prev) => {
        const remaining = prev.filter((t) => !ids.has(t.id))
        if (ids.has(activeTabId)) {
          const idx = prev.findIndex((t) => t.id === activeTabId)
          const after = prev.slice(idx + 1).find((t) => !ids.has(t.id))
          const before = [...prev.slice(0, idx)].reverse().find((t) => !ids.has(t.id))
          const target = after ?? before
          setActiveTabId(target ? target.id : '')
        }
        if (remaining.length === 0) {
          const fresh = newTab('Query 1')
          setActiveTabId(fresh.id)
          return [fresh]
        }
        return remaining
      })
    },
    [activeTabId]
  )

  const closeTab = useCallback((id: string) => closeTabs(new Set([id])), [closeTabs])

  const closeOthers = useCallback(
    (id: string) => closeTabs(new Set(tabs.filter((t) => t.id !== id).map((t) => t.id))),
    [tabs, closeTabs]
  )

  const closeToRight = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id)
      closeTabs(new Set(tabs.slice(idx + 1).map((t) => t.id)))
    },
    [tabs, closeTabs]
  )

  const closeAll = useCallback(() => closeTabs(new Set(tabs.map((t) => t.id))), [tabs, closeTabs])

  const duplicateTab = useCallback(
    (id: string) => {
      const src = tabs.find((t) => t.id === id)
      if (!src) return
      const copy = newTab(`${src.title} copy`, src.sql)
      setTabs((ts) => {
        const idx = ts.findIndex((t) => t.id === id)
        return [...ts.slice(0, idx + 1), copy, ...ts.slice(idx + 1)]
      })
      setActiveTabId(copy.id)
    },
    [tabs]
  )

  const useSql = useCallback(
    (sql: string) => {
      const t = tabs.find((x) => x.id === activeTabId)
      if (t && t.kind === 'query') {
        editorRef.current?.setDoc(sql)
        setTab(t.id, { sql })
      } else {
        const fresh = newTab(nextQueryName(tabs), sql)
        setTabs((ts) => [...ts, fresh])
        setActiveTabId(fresh.id)
      }
    },
    [tabs, activeTabId, setTab]
  )

  const saveCurrentQuery = useCallback(async () => {
    const t = tabs.find((x) => x.id === activeTabId)
    if (!t?.sql.trim()) return
    const name = t.title || 'Saved query'
    const list = await window.opentable.saved.save({
      id: crypto.randomUUID(),
      name,
      sql: t.sql,
      connectionId: activeId ?? undefined,
      updatedAt: Date.now()
    })
    setSaved(list)
  }, [tabs, activeTabId, activeId])

  /* ————————————————— shortcuts ————————————————— */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        openDoctor()
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault()
        addTab()
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        closeTab(activeTabId)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveCurrentQuery()
      } else if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setAiAction('ask')
        setAiOpen((o) => !o)
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (e.key === 'Escape' && activeTab?.running) {
        cancelActive()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMac, addTab, closeTab, activeTabId, saveCurrentQuery, cancelActive, activeTab, openDoctor])

  /* ————————————————— resizer ————————————————— */

  useEffect(() => {
    const clamp = (): void =>
      setEditorHeight((h) => Math.min(h, Math.max(96, window.innerHeight - 220)))
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      setEditorHeight(Math.min(window.innerHeight - 220, Math.max(96, e.clientY - 44)))
    }
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging])

  /* ————————————————— palette actions ————————————————— */

  const paletteActions = useMemo<Command[]>(
    () => [
      {
        id: 'act:new-query',
        group: 'Actions',
        label: 'New query tab',
        hint: isMac ? '⌘T' : 'Ctrl T',
        run: addTab
      },
      {
        id: 'act:doctor',
        group: 'Actions',
        label: 'Analyze query with Query Doctor',
        hint: isMac ? '⌘⇧D' : 'Ctrl Shift D',
        run: openDoctor
      },
      {
        id: 'act:ai',
        group: 'Actions',
        label: 'Ask AI to write a query',
        hint: isMac ? '⌘I' : 'Ctrl I',
        icon: <IconAi />,
        run: () => {
          setAiAction('ask')
          setAiOpen(true)
        }
      },
      {
        id: 'act:ai-explain',
        group: 'Actions',
        label: 'Explain this query',
        icon: <IconAi />,
        run: () => {
          setAiAction('explain')
          setAiOpen(true)
        }
      },
      {
        id: 'act:save',
        group: 'Actions',
        label: 'Save current query',
        hint: isMac ? '⌘S' : 'Ctrl S',
        icon: <IconStar />,
        run: saveCurrentQuery
      },
      {
        id: 'act:settings',
        group: 'Actions',
        label: 'Open settings',
        hint: isMac ? '⌘,' : 'Ctrl ,',
        icon: <IconSettings />,
        run: () => setSettingsOpen(true)
      },
      {
        id: 'act:new-table',
        group: 'Actions',
        label: 'New table',
        run: openNewTable
      },
      {
        id: 'act:new-database',
        group: 'Actions',
        label: 'New database',
        run: () => {
          setCreateError(null)
          setCreatingDatabase(true)
        }
      },
      {
        id: 'act:new-conn',
        group: 'Actions',
        label: 'New connection',
        run: () => setModal({ open: true, editing: null })
      },
      {
        id: 'act:refresh',
        group: 'Actions',
        label: 'Refresh schema',
        run: () => activeId && refreshSchema(activeId)
      }
    ],
    [isMac, addTab, openDoctor, saveCurrentQuery, activeId, refreshSchema, openNewTable]
  )

  const rowsShown = activeTab?.result?.sets.reduce((n, s) => n + s.rows.length, 0) ?? 0

  return (
    <div className="shell">
      <Sidebar
        connections={connections}
        activeId={activeId}
        states={states}
        schema={schema}
        schemaError={activeId ? (schemaErrors[activeId] ?? null) : null}
        databases={activeId ? (databases[activeId] ?? []) : []}
        onSelect={selectConnection}
        onEdit={(c) => setModal({ open: true, editing: c })}
        onNew={() => setModal({ open: true, editing: null })}
        onOpenTable={openTable}
        onOpenStructure={openStructure}
        onRefreshSchema={() => activeId && refreshSchema(activeId)}
        onSwitchDatabase={switchDatabase}
        onNewDatabase={() => {
          setCreateError(null)
          setCreatingDatabase(true)
        }}
        onNewTable={openNewTable}
        footer={
          <>
            <button className="foot-btn" onClick={() => setPaletteOpen(true)}>
              <IconHistory />
              <span>Search</span>
              <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            <button
              className="foot-btn"
              onClick={() => setChatOpen((v) => !v)}
              title="Chat with your database"
            >
              <IconAi />
              <span>Chat</span>
            </button>
            <button
              className="foot-btn"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              <IconSettings />
              <span>Settings</span>
              {updateState.status === 'ready' && <span className="update-dot" />}
            </button>
          </>
        }
      />

      <div className="main">
        <div className="titlebar">
          <div className="tabstrip">
            {tabs.map((t) => (
              <button
                key={t.id}
                ref={t.id === activeTab?.id ? activeTabRef : undefined}
                className={`tab ${t.id === activeTab?.id ? 'active' : ''} ${
                  t.kind === 'structure' ? 'is-structure' : ''
                }`}
                onClick={() => setActiveTabId(t.id)}
                onDoubleClick={() => t.kind === 'query' && setRenamingId(t.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    closeTab(t.id)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setTabMenu({ id: t.id, point: { x: e.clientX, y: e.clientY } })
                }}
                title={t.title}
              >
                {renamingId === t.id ? (
                  <input
                    className="tab-rename"
                    autoFocus
                    defaultValue={t.title}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => commitRename(t.id, e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') commitRename(t.id, e.currentTarget.value)
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                  />
                ) : (
                  <>
                    <span className="tab-title">{t.title}</span>
                    <span
                      className="tab-close"
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(t.id)
                      }}
                    >
                      ×
                    </span>
                  </>
                )}
              </button>
            ))}
            <button className="tab-new" title="New query (⌘T)" onClick={addTab}>
              +
            </button>
          </div>
        </div>

        <div className="workspace">
          <ErrorBoundary resetKey={activeTab?.id}>
            {activeTab?.kind === 'newtable' ? (
              <CreateTableView
                driver={activeConn?.driver ?? 'postgres'}
                schemaName={schema?.tables[0]?.schema ?? 'public'}
                tables={schema?.tables ?? []}
                draft={activeTab.draft ?? newTableDraft(activeConn?.driver ?? 'postgres')}
                busy={createBusy}
                error={createError}
                onChange={(draft) => setTab(activeTab.id, { draft })}
                onCancel={() => closeTab(activeTab.id)}
                onCreate={async (ddl, tableName) => {
                  const ok = await runDdl(ddl)
                  if (ok) {
                    closeTab(activeTab.id)
                    openTable(schema?.tables[0]?.schema ?? 'public', tableName)
                  }
                }}
              />
            ) : activeTab?.kind === 'structure' ? (
              activeTab.details ? (
                <StructureView
                  details={activeTab.details}
                  driver={activeConn?.driver ?? 'postgres'}
                  tables={schema?.tables ?? []}
                  busy={createBusy}
                  error={createError}
                  onQuery={useSql}
                  onApply={(statements, destructive, summary) => {
                    setCreateError(null)
                    if (destructive) {
                      setAlterConfirm({ statements, summary, tabId: activeTab.id })
                    } else {
                      applyAlter(statements, activeTab.id)
                    }
                  }}
                />
              ) : (
                <div className="results">
                  {activeTab.error ? (
                    <div className="error-block">{activeTab.error}</div>
                  ) : (
                    <div className="running-ind">
                      <span>
                        Loading structure<span className="ellipsis" />
                      </span>
                    </div>
                  )}
                </div>
              )
            ) : (
              <>
                {aiOpen && (
                  <AiBar
                    key={aiAction}
                    connectionId={activeId}
                    hasKey={settings.hasAiKey}
                    currentSql={activeTab?.sql ?? ''}
                    action={aiAction}
                    onInsert={useSql}
                    onOpenSettings={() => {
                      setAiOpen(false)
                      setSettingsOpen(true)
                    }}
                    onClose={() => setAiOpen(false)}
                  />
                )}

                <div className="editor-zone" style={{ height: editorHeight }}>
                  {activeTab && (
                    <SqlEditor
                      key={activeTab.id}
                      tabId={activeTab.id}
                      initialValue={activeTab.sql}
                      driver={activeConn?.driver ?? 'postgres'}
                      schema={schema}
                      handleRef={editorRef}
                      onChange={(v) => setTab(activeTab.id, { sql: v })}
                      onRun={runActive}
                    />
                  )}
                  <div className="run-float">
                    <button
                      className="btn-icon doctor-trigger"
                      title={`Query Doctor (${isMac ? '⌘⇧D' : 'Ctrl Shift D'})`}
                      onClick={openDoctor}
                      disabled={activeState !== 'connected'}
                    >
                      Plan
                    </button>
                    {settings.hasAiKey && (
                      <button
                        className={`btn-icon ${aiOpen ? 'on' : ''}`}
                        title="Ask AI (⌘I)"
                        onClick={() => {
                          setAiAction('ask')
                          setAiOpen((o) => !o)
                        }}
                      >
                        <IconAi />
                      </button>
                    )}
                    <span className="kbd-hint">{isMac ? '⌘⏎' : 'Ctrl ⏎'}</span>
                    {activeTab?.running ? (
                      <button className="btn-run cancel" onClick={cancelActive}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        className="btn-run"
                        onClick={runActive}
                        disabled={activeState !== 'connected'}
                      >
                        <span className="play">▶</span>
                        Run
                      </button>
                    )}
                  </div>
                </div>

                <div
                  className={`drag-handle ${dragging ? 'dragging' : ''}`}
                  onMouseDown={() => setDragging(true)}
                />

                <ResultsView
                  result={activeTab?.result ?? null}
                  error={activeTab?.error ?? null}
                  running={activeTab?.running ?? false}
                  hasConnection={activeState === 'connected'}
                  connectionId={activeId}
                  onRerun={rerunActive}
                  onCancel={cancelActive}
                  onFixWithAi={fixWithAi}
                  aiAvailable={settings.hasAiKey}
                />
              </>
            )}
          </ErrorBoundary>

          <div className="statusbar">
            <span className={`sb-item ${activeState === 'connected' ? 'sb-live' : ''}`}>
              {activeState === 'connected'
                ? activeConn?.name
                : activeState === 'connecting'
                  ? 'connecting…'
                  : 'not connected'}
            </span>
            {activeConn?.environment === 'production' && (
              <span className="sb-item sb-prod">production</span>
            )}
            {serverVersion && activeState === 'connected' && (
              <span className="sb-item">{serverVersion.split(',')[0].slice(0, 44)}</span>
            )}
            <span className="spacer" />
            {updateState.status === 'ready' && (
              <button className="sb-item sb-update" onClick={() => window.opentable.updates.install()}>
                Update ready — restart
              </button>
            )}
            {activeTab?.result && (
              <>
                <span className="sb-item">{rowsShown.toLocaleString()} rows</span>
                <span className="sb-item">{Math.round(activeTab.result.elapsedMs)} ms</span>
              </>
            )}
          </div>
        </div>
      </div>

      {chatOpen && (
        <ChatPanel
          connectionId={activeId}
          connectionName={connections.find((c) => c.id === activeId)?.name ?? ''}
          driver={connections.find((c) => c.id === activeId)?.driver ?? 'postgres'}
          onClose={() => setChatOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onInsert={useSql}
        />
      )}

      {doctorSql && activeId && (
        <QueryDoctor connectionId={activeId} sql={doctorSql} onClose={() => setDoctorSql(null)} />
      )}

      {modal.open && (
        <ConnectionModal
          editing={modal.editing}
          onSave={saveConnection}
          onDelete={deleteConnection}
          onClose={() => setModal({ open: false, editing: null })}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={async (patch) => {
            setSettings(await window.opentable.settings.update(patch))
            setSettingsOpen(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          connections={connections}
          schema={schema}
          history={history}
          saved={saved}
          actions={paletteActions}
          onSelectConnection={selectConnection}
          onOpenTable={openTable}
          onUseSql={useSql}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {tabMenu && (
        <DropMenu
          point={tabMenu.point}
          onClose={() => setTabMenu(null)}
          items={buildTabMenu(tabMenu.id, tabs, {
            close: closeTab,
            closeOthers,
            closeToRight,
            closeAll,
            duplicate: duplicateTab,
            rename: setRenamingId
          })}
        />
      )}

      {creatingDatabase && (
        <CreateDatabaseModal
          driver={activeConn?.driver ?? 'postgres'}
          busy={createBusy}
          error={createError}
          onCreate={(ddl, name) => runDdl(ddl, { switchToDatabase: name })}
          onClose={() => setCreatingDatabase(false)}
        />
      )}

      {alterConfirm && (
        <ConfirmDialog
          title="Apply destructive changes?"
          confirmLabel="Apply"
          body={
            <div className="confirm-body">
              <p>These changes cannot be undone:</p>
              <ul className="confirm-list">
                {alterConfirm.summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          }
          onConfirm={() => {
            const c = alterConfirm
            setAlterConfirm(null)
            applyAlter(c.statements, c.tabId)
          }}
          onCancel={() => setAlterConfirm(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.check.isProduction ? 'Run on production?' : 'Run this statement?'}
          body={
            <div className="confirm-body">
              {confirm.check.isProduction && (
                <p>
                  <b>{confirm.check.connectionName}</b> is marked as a production database.
                </p>
              )}
              {confirm.check.unscoped.length > 0 && (
                <>
                  <p>
                    {confirm.check.unscoped.length === 1
                      ? 'This statement has no WHERE clause and will affect every row:'
                      : 'These statements have no WHERE clause and will affect every row:'}
                  </p>
                  <pre className="confirm-sql">{confirm.check.unscoped.join('\n')}</pre>
                </>
              )}
            </div>
          }
          onConfirm={() => {
            const c = confirm
            setConfirm(null)
            execute(c.tabId, c.sql)
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

function buildTabMenu(
  id: string,
  tabs: { id: string; kind: string }[],
  actions: {
    close: (id: string) => void
    closeOthers: (id: string) => void
    closeToRight: (id: string) => void
    closeAll: () => void
    duplicate: (id: string) => void
    rename: (id: string) => void
  }
): MenuItem[] {
  const idx = tabs.findIndex((t) => t.id === id)
  const hasOthers = tabs.length > 1
  const hasRight = idx >= 0 && idx < tabs.length - 1
  const isQuery = tabs[idx]?.kind === 'query'

  const items: MenuItem[] = [{ label: 'Close', onSelect: () => actions.close(id) }]
  if (hasOthers) items.push({ label: 'Close others', onSelect: () => actions.closeOthers(id) })
  if (hasRight) items.push({ label: 'Close to the right', onSelect: () => actions.closeToRight(id) })
  items.push({ label: 'Close all', onSelect: actions.closeAll })

  if (isQuery) {
    items.push({
      label: 'Rename…',
      separatorBefore: true,
      onSelect: () => actions.rename(id)
    })
    items.push({ label: 'Duplicate', onSelect: () => actions.duplicate(id) })
  }
  return items
}
