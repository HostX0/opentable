import { useEffect, useMemo, useState } from 'react'
import type { QueryPlan, QueryPlanNode } from '../../../shared/types'
import './query-doctor.css'

interface Props {
  connectionId: string
  sql: string
  onClose: () => void
}

function PlanNode({ node, depth = 0 }: { node: QueryPlanNode; depth?: number }): React.JSX.Element {
  const meta = [
    node.relation,
    node.access,
    node.index ? `index ${node.index}` : '',
    node.estimatedRows != null ? `~${node.estimatedRows.toLocaleString()} rows` : '',
    node.estimatedCost != null ? `cost ${node.estimatedCost.toLocaleString()}` : ''
  ].filter(Boolean)

  return (
    <div className="doctor-plan-node" style={{ '--doctor-depth': depth } as React.CSSProperties}>
      <div className="doctor-node-line">
        <span className="doctor-node-op">{node.operation}</span>
        {meta.length > 0 && <span className="doctor-node-meta">{meta.join(' · ')}</span>}
      </div>
      {node.filter && <code className="doctor-node-filter">{node.filter}</code>}
      {node.detail && <span className="doctor-node-detail">{node.detail}</span>}
      {node.children.map((child) => (
        <PlanNode key={child.id} node={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export default function QueryDoctor({ connectionId, sql, onClose }: Props): React.JSX.Element {
  const [plan, setPlan] = useState<QueryPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [rawOpen, setRawOpen] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    setPlan(null)
    window.opentable.doctor.diagnose(connectionId, sql).then((res) => {
      if (!live) return
      if (res.ok && res.plan) setPlan(res.plan)
      else setError(res.error ?? 'Could not read the query plan')
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [connectionId, sql])

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const counts = useMemo(() => {
    if (!plan) return { critical: 0, warning: 0 }
    return {
      critical: plan.findings.filter((f) => f.severity === 'critical').length,
      warning: plan.findings.filter((f) => f.severity === 'warning').length
    }
  }, [plan])

  return (
    <div className="doctor-overlay" role="dialog" aria-modal="true" aria-label="Query Doctor">
      <div className="doctor-panel">
        <header className="doctor-head">
          <div>
            <span className="doctor-eyebrow">Local EXPLAIN analyzer</span>
            <h2>Query Doctor</h2>
            <p>Planner estimates only. Your SELECT is not executed.</p>
          </div>
          <button className="doctor-close" onClick={onClose} aria-label="Close Query Doctor">
            ×
          </button>
        </header>

        <div className="doctor-query"><code>{sql}</code></div>

        {loading ? (
          <div className="doctor-state">Reading the database query plan…</div>
        ) : error ? (
          <div className="doctor-state error">
            <strong>Could not analyze this query</strong>
            <span>{error}</span>
          </div>
        ) : plan ? (
          <div className="doctor-body">
            <section className="doctor-summary">
              <div>
                <span>Dialect</span>
                <strong>{plan.driver}</strong>
              </div>
              <div>
                <span>Estimated rows</span>
                <strong>{plan.estimatedRows != null ? plan.estimatedRows.toLocaleString() : '—'}</strong>
              </div>
              <div>
                <span>Estimated cost</span>
                <strong>{plan.totalCost != null ? plan.totalCost.toLocaleString() : '—'}</strong>
              </div>
              <div>
                <span>Findings</span>
                <strong>{counts.critical + counts.warning || 'clean'}</strong>
              </div>
            </section>

            <section className="doctor-section">
              <div className="doctor-section-head">
                <div>
                  <span>What stands out</span>
                  <strong>Deterministic checks, no API key</strong>
                </div>
              </div>
              <div className="doctor-findings">
                {plan.findings.map((finding, i) => (
                  <article className={`doctor-finding ${finding.severity}`} key={`${finding.title}:${i}`}>
                    <span className="doctor-severity">{finding.severity}</span>
                    <div>
                      <strong>{finding.title}</strong>
                      <p>{finding.detail}</p>
                      {finding.suggestion && <p className="doctor-suggestion">{finding.suggestion}</p>}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="doctor-section plan">
              <div className="doctor-section-head">
                <div>
                  <span>Plan tree</span>
                  <strong>How the database intends to do the work</strong>
                </div>
                <button onClick={() => setRawOpen((v) => !v)}>{rawOpen ? 'Plan tree' : 'Raw EXPLAIN'}</button>
              </div>
              {rawOpen ? (
                <pre className="doctor-raw">{plan.raw}</pre>
              ) : (
                <div className="doctor-plan-tree">
                  <PlanNode node={plan.root} />
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}
