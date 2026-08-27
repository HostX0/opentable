import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Changing this value clears a previous error (e.g. when switching tabs) */
  resetKey?: string
}

interface State {
  error: Error | null
  info: string
}

/**
 * A render error must never leave the user with a blank window. This catches it,
 * shows what happened, and lets them carry on without restarting the app.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info: info.componentStack ?? '' })
    console.error('OpenTable render error:', error, info)
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: '' })
    }
  }

  render(): ReactNode {
    const { error, info } = this.state
    if (!error) return this.props.children

    const report = `${error.message}\n\n${error.stack ?? ''}\n${info}`.trim()

    return (
      <div className="results">
        <div className="state">
          <div className="state-inner boundary">
            <h2>Something broke in this view</h2>
            <p>
              The rest of OpenTable is still running — close this tab or try again. Copying the
              details below helps track the bug down.
            </p>
            <pre className="boundary-msg">{error.message}</pre>
            <div className="boundary-actions">
              <button className="btn-mini" onClick={() => navigator.clipboard.writeText(report)}>
                Copy details
              </button>
              <button
                className="btn-mini primary"
                onClick={() => this.setState({ error: null, info: '' })}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
