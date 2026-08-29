import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent
} from 'react'
import type {
  DbSchema,
  Driver,
  SchemaRelationship,
  SchemaTable
} from '../../../shared/types'
import './schema-map.css'

const CARD_WIDTH = 256
const HEADER_HEIGHT = 58
const COLUMN_HEIGHT = 26
const FOOTER_HEIGHT = 38
const MAX_COLUMNS = 10
const GAP_X = 92
const GAP_Y = 28
const PADDING = 72

interface Props {
  connectionId: string
  driver: Driver
  schema: DbSchema
  onClose: () => void
  onOpenTable: (schema: string, table: string) => void
  onOpenStructure: (schema: string, table: string) => void
}

interface NodeLayout {
  key: string
  table: SchemaTable
  x: number
  y: number
  width: number
  height: number
  visibleColumns: number
}

interface GraphLayout {
  nodes: NodeLayout[]
  byKey: Map<string, NodeLayout>
  width: number
  height: number
}

interface Viewport {
  x: number
  y: number
  scale: number
}

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`
}

function relationKey(r: SchemaRelationship): string {
  return [r.sourceSchema, r.sourceTable, r.name, r.targetSchema, r.targetTable].join('\u0000')
}

function cardHeight(table: SchemaTable): number {
  const rows = Math.min(table.columns.length, MAX_COLUMNS)
  const more = table.columns.length > MAX_COLUMNS ? COLUMN_HEIGHT : 0
  return HEADER_HEIGHT + rows * COLUMN_HEIGHT + more + FOOTER_HEIGHT
}

/**
 * A deterministic dependency layout: referenced (parent) tables flow left to
 * referencing (child) tables. Cycles stay together instead of destabilising
 * the whole graph, and isolated tables are grouped after the connected graph.
 */
function buildLayout(schema: DbSchema, relationships: SchemaRelationship[]): GraphLayout {
  const tables = schema.tables
  const keys = new Set(tables.map((t) => tableKey(t.schema, t.name)))
  const rank = new Map<string, number>(tables.map((t) => [tableKey(t.schema, t.name), 0]))
  const indegree = new Map<string, number>(tables.map((t) => [tableKey(t.schema, t.name), 0]))
  const children = new Map<string, Set<string>>()
  const connected = new Set<string>()

  for (const r of relationships) {
    const parent = tableKey(r.targetSchema, r.targetTable)
    const child = tableKey(r.sourceSchema, r.sourceTable)
    if (!keys.has(parent) || !keys.has(child)) continue
    connected.add(parent)
    connected.add(child)
    if (parent === child) continue
    const list = children.get(parent) ?? new Set<string>()
    if (!list.has(child)) {
      list.add(child)
      children.set(parent, list)
      indegree.set(child, (indegree.get(child) ?? 0) + 1)
    }
  }

  const queue = tables
    .map((t) => tableKey(t.schema, t.name))
    .filter((key) => connected.has(key) && (indegree.get(key) ?? 0) === 0)
    .sort()

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const parent = queue[cursor]
    for (const child of children.get(parent) ?? []) {
      rank.set(child, Math.max(rank.get(child) ?? 0, (rank.get(parent) ?? 0) + 1))
      indegree.set(child, (indegree.get(child) ?? 1) - 1)
      if (indegree.get(child) === 0) queue.push(child)
    }
  }

  // Nodes left with indegree > 0 are part of a cycle. Keep them close to the
  // deepest neighbour we managed to rank, rather than inventing a huge chain.
  let maxConnectedRank = 0
  for (const key of connected) maxConnectedRank = Math.max(maxConnectedRank, rank.get(key) ?? 0)
  for (const key of connected) {
    if ((indegree.get(key) ?? 0) > 0) rank.set(key, maxConnectedRank)
  }

  const isolated = tables.filter((t) => !connected.has(tableKey(t.schema, t.name)))
  if (isolated.length > 0 && connected.size > 0) {
    const isolatedRank = maxConnectedRank + 1
    for (const t of isolated) rank.set(tableKey(t.schema, t.name), isolatedRank)
  }

  const columns = new Map<number, SchemaTable[]>()
  for (const table of tables) {
    const r = rank.get(tableKey(table.schema, table.name)) ?? 0
    const list = columns.get(r) ?? []
    list.push(table)
    columns.set(r, list)
  }

  for (const list of columns.values()) {
    list.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`))
  }

  const nodes: NodeLayout[] = []
  const sortedRanks = [...columns.keys()].sort((a, b) => a - b)
  let graphHeight = 0

  sortedRanks.forEach((r, visualColumn) => {
    let y = PADDING
    const x = PADDING + visualColumn * (CARD_WIDTH + GAP_X)
    for (const table of columns.get(r) ?? []) {
      const height = cardHeight(table)
      nodes.push({
        key: tableKey(table.schema, table.name),
        table,
        x,
        y,
        width: CARD_WIDTH,
        height,
        visibleColumns: Math.min(table.columns.length, MAX_COLUMNS)
      })
      y += height + GAP_Y
    }
    graphHeight = Math.max(graphHeight, y - GAP_Y + PADDING)
  })

  const graphWidth =
    PADDING * 2 + Math.max(1, sortedRanks.length) * CARD_WIDTH + Math.max(0, sortedRanks.length - 1) * GAP_X

  return {
    nodes,
    byKey: new Map(nodes.map((node) => [node.key, node])),
    width: graphWidth,
    height: Math.max(graphHeight, 360)
  }
}

function columnAnchor(node: NodeLayout, column: string): number {
  const index = node.table.columns.findIndex((c) => c.name === column)
  if (index < 0) return node.y + HEADER_HEIGHT / 2
  const visibleIndex = Math.min(index, MAX_COLUMNS)
  return node.y + HEADER_HEIGHT + visibleIndex * COLUMN_HEIGHT + COLUMN_HEIGHT / 2
}

function edgePath(parent: NodeLayout, child: NodeLayout, relation: SchemaRelationship): string {
  const parentY = columnAnchor(parent, relation.targetColumns[0] ?? '')
  const childY = columnAnchor(child, relation.sourceColumns[0] ?? '')
  const dx = child.x - parent.x

  if (Math.abs(dx) < 24) {
    const fromX = parent.x + parent.width
    const toX = child.x + child.width
    const bend = Math.max(fromX, toX) + 82
    return `M ${fromX} ${parentY} C ${bend} ${parentY}, ${bend} ${childY}, ${toX} ${childY}`
  }

  const forward = dx > 0
  const fromX = forward ? parent.x + parent.width : parent.x
  const toX = forward ? child.x : child.x + child.width
  const direction = forward ? 1 : -1
  const bend = Math.max(54, Math.abs(toX - fromX) * 0.46)
  return `M ${fromX} ${parentY} C ${fromX + direction * bend} ${parentY}, ${toX - direction * bend} ${childY}, ${toX} ${childY}`
}

function identifier(name: string, driver: Driver): string {
  if (driver === 'mysql') return `\`${name.replace(/`/g, '``')}\``
  return `"${name.replace(/"/g, '""')}"`
}

function qualified(schema: string, table: string, driver: Driver): string {
  if (driver === 'postgres' && schema && schema !== 'public') {
    return `${identifier(schema, driver)}.${identifier(table, driver)}`
  }
  return identifier(table, driver)
}

function joinSql(r: SchemaRelationship, driver: Driver): string {
  const source = qualified(r.sourceSchema, r.sourceTable, driver)
  const target = qualified(r.targetSchema, r.targetTable, driver)
  const on = r.sourceColumns
    .map((column, i) => `s.${identifier(column, driver)} = t.${identifier(r.targetColumns[i], driver)}`)
    .join('\n  AND ')
  return `SELECT s.*, t.*\nFROM ${source} AS s\nJOIN ${target} AS t\n  ON ${on};`
}

function mermaidId(schema: string, table: string): string {
  let value = `${schema}_${table}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (!/^[A-Za-z_]/.test(value)) value = `t_${value}`
  return value
}

function mermaidType(type: string): string {
  const clean = type.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
  return clean || 'value'
}

function mermaid(schema: DbSchema, relationships: SchemaRelationship[]): string {
  const fkColumns = new Set<string>()
  for (const r of relationships) {
    for (const column of r.sourceColumns) {
      fkColumns.add(`${r.sourceSchema}.${r.sourceTable}.${column}`)
    }
  }

  const lines = ['erDiagram']
  for (const table of schema.tables) {
    const id = mermaidId(table.schema, table.name)
    lines.push(`  ${id} {`)
    for (const column of table.columns) {
      const flags: string[] = []
      if (column.isPrimary) flags.push('PK')
      if (fkColumns.has(`${table.schema}.${table.name}.${column.name}`)) flags.push('FK')
      lines.push(
        `    ${mermaidType(column.dataType)} ${column.name.replace(/[^A-Za-z0-9_]/g, '_')}${flags.length ? ` ${flags.join(',')}` : ''}`
      )
    }
    lines.push('  }')
  }

  for (const r of relationships) {
    const target = mermaidId(r.targetSchema, r.targetTable)
    const source = mermaidId(r.sourceSchema, r.sourceTable)
    const label = r.name.replace(/"/g, "'")
    lines.push(`  ${target} ||--o{ ${source} : "${label}"`)
  }
  return lines.join('\n')
}

export default function SchemaMap({
  connectionId,
  driver,
  schema,
  onClose,
  onOpenTable,
  onOpenStructure
}: Props): React.JSX.Element {
  const [relationships, setRelationships] = useState<SchemaRelationship[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hovered, setHovered] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [drag, setDrag] = useState<{
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  const [copied, setCopied] = useState<'mermaid' | 'join' | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    window.opentable.db.relationships(connectionId).then((res) => {
      if (!live) return
      if (res.ok) setRelationships(res.relationships ?? [])
      else setError(res.error ?? 'Could not read foreign-key relationships')
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [connectionId, schema.database])

  const layout = useMemo(() => buildLayout(schema, relationships), [schema, relationships])
  const selected = useMemo(
    () => relationships.find((r) => relationKey(r) === selectedKey) ?? null,
    [relationships, selectedKey]
  )

  const fit = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const scale = Math.min(
      1.12,
      Math.max(0.28, Math.min((rect.width - 72) / layout.width, (rect.height - 72) / layout.height))
    )
    setViewport({
      scale,
      x: (rect.width - layout.width * scale) / 2,
      y: (rect.height - layout.height * scale) / 2
    })
  }, [layout.height, layout.width])

  useEffect(() => {
    if (loading) return
    const timer = window.setTimeout(fit, 0)
    return () => window.clearTimeout(timer)
  }, [loading, fit])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (selectedKey) setSelectedKey(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, selectedKey])

  useEffect(() => {
    if (!drag) return
    const move = (event: MouseEvent): void => {
      setViewport((v) => ({
        ...v,
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY
      }))
    }
    const up = (): void => setDrag(null)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [drag])

  const relationColumns = useMemo(() => {
    const source = new Set<string>()
    const target = new Set<string>()
    for (const r of relationships) {
      r.sourceColumns.forEach((column) => source.add(`${r.sourceSchema}.${r.sourceTable}.${column}`))
      r.targetColumns.forEach((column) => target.add(`${r.targetSchema}.${r.targetTable}.${column}`))
    }
    return { source, target }
  }, [relationships])

  const focusKeys = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return null
    const matches = new Set<string>()
    for (const node of layout.nodes) {
      const haystack = [
        node.table.schema,
        node.table.name,
        ...node.table.columns.map((column) => `${column.name} ${column.dataType}`)
      ]
        .join(' ')
        .toLowerCase()
      if (haystack.includes(text)) matches.add(node.key)
    }
    for (const r of relationships) {
      const source = tableKey(r.sourceSchema, r.sourceTable)
      const target = tableKey(r.targetSchema, r.targetTable)
      if (matches.has(source)) matches.add(target)
      if (matches.has(target)) matches.add(source)
    }
    return matches
  }, [layout.nodes, query, relationships])

  const hoverKeys = useMemo(() => {
    if (!hovered) return null
    const keys = new Set([hovered])
    for (const r of relationships) {
      const source = tableKey(r.sourceSchema, r.sourceTable)
      const target = tableKey(r.targetSchema, r.targetTable)
      if (source === hovered) keys.add(target)
      if (target === hovered) keys.add(source)
    }
    return keys
  }, [hovered, relationships])

  const zoom = useCallback((factor: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const cx = rect.width / 2
    const cy = rect.height / 2
    setViewport((v) => {
      const scale = Math.min(1.9, Math.max(0.24, v.scale * factor))
      const worldX = (cx - v.x) / v.scale
      const worldY = (cy - v.y) / v.scale
      return { scale, x: cx - worldX * scale, y: cy - worldY * scale }
    })
  }, [])

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const factor = Math.exp(-event.deltaY * 0.0012)
    setViewport((v) => {
      const scale = Math.min(1.9, Math.max(0.24, v.scale * factor))
      const worldX = (px - v.x) / v.scale
      const worldY = (py - v.y) / v.scale
      return { scale, x: px - worldX * scale, y: py - worldY * scale }
    })
  }

  const onStageDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as Element
    if (target.closest('.schema-card, .schema-map-inspector, .schema-edge-hit')) return
    setDrag({
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y
    })
  }

  const flashCopied = (kind: 'mermaid' | 'join'): void => {
    setCopied(kind)
    window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1400)
  }

  const copyMermaid = async (): Promise<void> => {
    await navigator.clipboard.writeText(mermaid(schema, relationships))
    flashCopied('mermaid')
  }

  const copyJoin = async (): Promise<void> => {
    if (!selected) return
    await navigator.clipboard.writeText(joinSql(selected, driver))
    flashCopied('join')
  }

  return (
    <div className="schema-map-overlay" role="dialog" aria-modal="true" aria-label="Schema map">
      <header className="schema-map-toolbar">
        <div className="schema-map-title-block">
          <strong>Schema map</strong>
          <span>{schema.database || 'database'}</span>
          <span className="schema-map-counts">
            {schema.tables.length} tables · {relationships.length} relationships
          </span>
        </div>

        <div className="schema-map-search-wrap">
          <input
            className="schema-map-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find table or column"
            autoFocus
          />
          {query && (
            <button className="schema-map-clear" onClick={() => setQuery('')} title="Clear search">
              ×
            </button>
          )}
        </div>

        <div className="schema-map-tools">
          <button onClick={() => zoom(0.86)} title="Zoom out">
            −
          </button>
          <span className="schema-map-zoom">{Math.round(viewport.scale * 100)}%</span>
          <button onClick={() => zoom(1.16)} title="Zoom in">
            +
          </button>
          <button onClick={fit}>Fit</button>
          <span className="schema-map-tool-divider" />
          <button onClick={copyMermaid}>{copied === 'mermaid' ? 'Copied' : 'Copy Mermaid'}</button>
          <button className="schema-map-close" onClick={onClose} title="Close schema map">
            ×
          </button>
        </div>
      </header>

      <div
        ref={stageRef}
        className={`schema-map-stage ${drag ? 'dragging' : ''}`}
        onWheel={onWheel}
        onMouseDown={onStageDown}
      >
        {loading ? (
          <div className="schema-map-state">Reading foreign keys…</div>
        ) : error ? (
          <div className="schema-map-state error">
            <strong>Could not build schema map</strong>
            <span>{error}</span>
          </div>
        ) : schema.tables.length === 0 ? (
          <div className="schema-map-state">This database has no tables yet.</div>
        ) : (
          <div
            className="schema-map-canvas"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`
            }}
          >
            <svg
              className="schema-map-edges"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              {relationships.map((relation) => {
                const key = relationKey(relation)
                const parent = layout.byKey.get(tableKey(relation.targetSchema, relation.targetTable))
                const child = layout.byKey.get(tableKey(relation.sourceSchema, relation.sourceTable))
                if (!parent || !child) return null
                const path = edgePath(parent, child, relation)
                const sourceKey = child.key
                const targetKey = parent.key
                const active =
                  key === selectedKey ||
                  hovered === sourceKey ||
                  hovered === targetKey ||
                  Boolean(focusKeys && (focusKeys.has(sourceKey) || focusKeys.has(targetKey)))
                const dim =
                  Boolean(focusKeys && !focusKeys.has(sourceKey) && !focusKeys.has(targetKey)) ||
                  Boolean(hoverKeys && !hoverKeys.has(sourceKey) && !hoverKeys.has(targetKey))
                return (
                  <g key={key} className={`${active ? 'active' : ''} ${dim ? 'dim' : ''}`}>
                    <path className="schema-edge" d={path} />
                    <path
                      className="schema-edge-hit"
                      d={path}
                      onClick={(event) => {
                        event.stopPropagation()
                        setSelectedKey(key === selectedKey ? null : key)
                      }}
                    />
                  </g>
                )
              })}
            </svg>

            {layout.nodes.map((node) => {
              const isDim =
                Boolean(focusKeys && !focusKeys.has(node.key)) || Boolean(hoverKeys && !hoverKeys.has(node.key))
              const relevant = relationships.filter(
                (r) =>
                  tableKey(r.sourceSchema, r.sourceTable) === node.key ||
                  tableKey(r.targetSchema, r.targetTable) === node.key
              ).length
              return (
                <article
                  key={node.key}
                  className={`schema-card ${isDim ? 'dim' : ''}`}
                  style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                  onMouseEnter={() => setHovered(node.key)}
                  onMouseLeave={() => setHovered(null)}
                  onDoubleClick={() => onOpenTable(node.table.schema, node.table.name)}
                >
                  <div className="schema-card-head">
                    <div className="schema-card-name">
                      <span className="schema-card-schema">{node.table.schema}</span>
                      <strong>{node.table.name}</strong>
                    </div>
                    <span className={`schema-card-kind ${node.table.kind}`}>{node.table.kind}</span>
                  </div>

                  <div className="schema-card-columns">
                    {node.table.columns.slice(0, MAX_COLUMNS).map((column) => {
                      const colKey = `${node.table.schema}.${node.table.name}.${column.name}`
                      const isFk = relationColumns.source.has(colKey)
                      const isReferenced = relationColumns.target.has(colKey)
                      return (
                        <div className="schema-card-column" key={column.name} title={column.dataType}>
                          <span className="schema-column-name">{column.name}</span>
                          <span className="schema-column-type">{column.dataType}</span>
                          <span className="schema-column-flags">
                            {column.isPrimary && <b>PK</b>}
                            {isFk && <b>FK</b>}
                            {!isFk && isReferenced && <i>REF</i>}
                          </span>
                        </div>
                      )
                    })}
                    {node.table.columns.length > MAX_COLUMNS && (
                      <div className="schema-card-more">
                        +{node.table.columns.length - MAX_COLUMNS} more columns
                      </div>
                    )}
                  </div>

                  <div className="schema-card-foot">
                    <span>{relevant ? `${relevant} relation${relevant === 1 ? '' : 's'}` : 'No relations'}</span>
                    <div>
                      <button onClick={() => onOpenTable(node.table.schema, node.table.name)}>Data</button>
                      <button onClick={() => onOpenStructure(node.table.schema, node.table.name)}>
                        Structure
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        {selected && (
          <aside className="schema-map-inspector" onMouseDown={(event) => event.stopPropagation()}>
            <div className="schema-inspector-head">
              <div>
                <span>Relationship</span>
                <strong>{selected.name}</strong>
              </div>
              <button onClick={() => setSelectedKey(null)}>×</button>
            </div>
            <div className="schema-inspector-route">
              <div>
                <span>From</span>
                <strong>{selected.sourceTable}</strong>
                <code>{selected.sourceColumns.join(', ')}</code>
              </div>
              <div className="schema-inspector-arrow">→</div>
              <div>
                <span>To</span>
                <strong>{selected.targetTable}</strong>
                <code>{selected.targetColumns.join(', ')}</code>
              </div>
            </div>
            {(selected.onDelete || selected.onUpdate) && (
              <div className="schema-inspector-rules">
                {selected.onDelete && <span>ON DELETE {selected.onDelete}</span>}
                {selected.onUpdate && <span>ON UPDATE {selected.onUpdate}</span>}
              </div>
            )}
            <pre className="schema-inspector-sql">{joinSql(selected, driver)}</pre>
            <div className="schema-inspector-actions">
              <button onClick={copyJoin}>{copied === 'join' ? 'Copied' : 'Copy JOIN'}</button>
              <button
                onClick={() => onOpenStructure(selected.sourceSchema, selected.sourceTable)}
              >
                Open source
              </button>
              <button
                onClick={() => onOpenStructure(selected.targetSchema, selected.targetTable)}
              >
                Open target
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
