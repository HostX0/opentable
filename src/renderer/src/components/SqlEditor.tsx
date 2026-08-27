import { useEffect, useRef } from 'react'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  placeholder,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor
} from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab
} from '@codemirror/commands'
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap
} from '@codemirror/autocomplete'
import {
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle
} from '@codemirror/language'
import { sql, PostgreSQL, MySQL } from '@codemirror/lang-sql'
import { tags as t } from '@lezer/highlight'
import type { DbSchema, Driver } from '../../../shared/types'
import { inkHighlight, buildTheme, prefersDark } from './editorTheme'

export interface EditorHandle {
  /** Selected text if any, else the statement surrounding the caret. */
  getRunTarget: () => string
  setDoc: (text: string) => void
  insert: (text: string) => void
  focus: () => void
}

interface Props {
  tabId: string
  initialValue: string
  driver: Driver
  schema: DbSchema | null
  onChange: (value: string) => void
  onRun: () => void
  handleRef?: { current: EditorHandle | null }
}

/** Find the statement containing `pos`, splitting on semicolons outside quotes. */
function statementAt(doc: string, pos: number): string {
  let start = 0
  let quote: string | null = null
  const bounds: number[] = []
  for (let i = 0; i < doc.length; i++) {
    const ch = doc[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === ';') bounds.push(i)
  }
  let end = doc.length
  for (const b of bounds) {
    if (b >= pos) {
      end = b
      break
    }
    start = b + 1
  }
  return doc.slice(start, end).trim()
}

function buildSqlExtension(driver: Driver, schema: DbSchema | null) {
  const schemaMap: Record<string, string[]> = {}
  if (schema) {
    for (const table of schema.tables) {
      const cols = table.columns.map((c) => c.name)
      schemaMap[table.name] = cols
      if (table.schema && table.schema !== 'public') {
        schemaMap[`${table.schema}.${table.name}`] = cols
      }
    }
  }
  return sql({
    dialect: driver === 'postgres' ? PostgreSQL : MySQL,
    schema: schemaMap,
    upperCaseKeywords: true
  })
}

export default function SqlEditor({
  tabId,
  initialValue,
  driver,
  schema,
  onChange,
  onRun,
  handleRef
}: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const onRunRef = useRef(onRun)
  const onChangeRef = useRef(onChange)
  onRunRef.current = onRun
  onChangeRef.current = onChange

  // (re)create the editor when the tab changes
  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        closeBrackets(),
        themeCompartment.current.of(buildTheme(prefersDark())),
        autocompletion({ activateOnTyping: true, icons: true }),
        syntaxHighlighting(inkHighlight),
        placeholder('Write a query…'),
        langCompartment.current.of(buildSqlExtension(driver, schema)),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRunRef.current()
              return true
            }
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
        EditorView.lineWrapping
      ]
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    // focus after paint so the caret is placed and CodeMirror's focus state is in sync
    const raf = requestAnimationFrame(() => view.focus())
    return () => {
      cancelAnimationFrame(raf)
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // expose imperative helpers used by Run, AI insert and the command palette
  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      getRunTarget: () => {
        const view = viewRef.current
        if (!view) return ''
        const { state } = view
        const sel = state.selection.main
        if (!sel.empty) return state.sliceDoc(sel.from, sel.to).trim()
        return statementAt(state.doc.toString(), sel.head)
      },
      setDoc: (text: string) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
        view.focus()
      },
      insert: (text: string) => {
        const view = viewRef.current
        if (!view) return
        const sel = view.state.selection.main
        view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } })
        view.focus()
      },
      focus: () => viewRef.current?.focus()
    }
    return () => {
      handleRef.current = null
    }
  }, [handleRef])

  // follow the system light/dark switch without rebuilding the editor
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

  // hot-swap dialect + schema for autocomplete
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: langCompartment.current.reconfigure(buildSqlExtension(driver, schema))
    })
  }, [driver, schema])

  // Clicking anywhere in the pane must focus the document, and CodeMirror's
  // internal focus flag can drift out of sync with document.activeElement —
  // re-assert focus so the caret and active line always render.
  const ensureFocus = (): void => {
    const view = viewRef.current
    if (view && !view.hasFocus) view.focus()
  }

  return (
    <div
      ref={hostRef}
      className="editor-host"
      onMouseDown={ensureFocus}
      onMouseUp={ensureFocus}
      onClick={ensureFocus}
    />
  )
}
