import { useEffect, useRef } from 'react'
import { EditorView, lineNumbers } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { syntaxHighlighting } from '@codemirror/language'
import { sql, PostgreSQL, MySQL, SQLite } from '@codemirror/lang-sql'
import type { Driver } from '../../../shared/types'
import { inkHighlight, buildTheme, prefersDark } from './editorTheme'

interface Props {
  code: string
  driver: Driver
  showLineNumbers?: boolean
}

function dialectFor(driver: Driver) {
  if (driver === 'mysql') return MySQL
  if (driver === 'sqlite') return SQLite
  return PostgreSQL
}

/** Read-only CodeMirror, so generated SQL is highlighted exactly like the editor. */
export default function SqlPreview({
  code,
  driver,
  showLineNumbers = true
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())

  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: code,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          ...(showLineNumbers ? [lineNumbers()] : []),
          syntaxHighlighting(inkHighlight),
          themeCompartment.current.of(buildTheme(prefersDark())),
          sql({ dialect: dialectFor(driver), upperCaseKeywords: true }),
          EditorView.lineWrapping
        ]
      }),
      parent: hostRef.current
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, showLineNumbers])

  // push new SQL in without rebuilding the editor
  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === code) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
  }, [code])

  // follow the system theme
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      viewRef.current?.dispatch({
        effects: themeCompartment.current.reconfigure(buildTheme(mq.matches))
      })
    }
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  return <div className="sql-preview-host" ref={hostRef} />
}
