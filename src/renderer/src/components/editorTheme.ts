import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * Syntax stays colour-coded — it conveys meaning, unlike UI chrome. The palette
 * is deliberately desaturated so it reads as part of the neutral interface.
 */
export const inkHighlight = HighlightStyle.define([
  // structure
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-kw)', fontWeight: '550' },
  { tag: [t.controlKeyword, t.definitionKeyword], color: 'var(--syn-kw)', fontWeight: '600' },

  // literal data
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-str)' },
  { tag: [t.number, t.bool, t.integer, t.float], color: 'var(--syn-num)' },
  { tag: t.null, color: 'var(--syn-num)', fontStyle: 'italic' },

  // identifiers
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)', fontWeight: '550' },
  { tag: [t.propertyName, t.variableName, t.attributeName], color: 'var(--ink)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },

  // quiet scaffolding
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.paren, t.squareBracket], color: 'var(--syn-punct)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--danger)' }
])

/**
 * CodeMirror needs to know it is on a dark background so its own selection and
 * cursor layers get the right contrast — CSS alone cannot tell it.
 */
export function buildTheme(dark: boolean) {
  return [
    EditorView.theme(
      {
        '&': { color: 'var(--ink)', backgroundColor: 'var(--paper)' },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'var(--caret)',
          borderLeftWidth: '2px'
        },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
          backgroundColor: 'var(--selection)'
        },
        '.cm-selectionMatch': { backgroundColor: 'var(--selection)' }
      },
      { dark }
    )
  ]
}

export function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}
