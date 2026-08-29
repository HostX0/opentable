import React from 'react'

/**
 * A deliberately small markdown renderer for assistant replies.
 *
 * Models answer in markdown whether or not you ask them to, so `**bold**` and
 * backticked table names were showing up literally. This handles the subset
 * that actually appears — emphasis, inline code, fenced code, lists, headings
 * — and renders everything else as plain text.
 *
 * It builds React elements rather than setting innerHTML: the input is model
 * output, and some of it echoes column values that came from the database, so
 * it must never be interpreted as markup.
 */

type Inline = string | React.JSX.Element

/** `code`, **bold**, *italic* — applied in that order so code wins. */
function inline(text: string, keyBase: string): Inline[] {
  const out: Inline[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyBase}-i${i++}`
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>)
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const BULLET = /^\s*[-*•]\s+/
const NUMBERED = /^\s*\d+[.)]\s+/

export default function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: React.JSX.Element[] = []
  const lines = text.split('\n')
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence
      blocks.push(
        <pre key={`b${key++}`} className="md-code" data-lang={lang || undefined}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    // heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        <p key={`b${key++}`} className="md-heading">
          {inline(heading[2], `h${key}`)}
        </p>
      )
      i++
      continue
    }

    // list — consecutive bullet or numbered lines become one list
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line) && !BULLET.test(line)
      const items: string[] = []
      while (i < lines.length && (BULLET.test(lines[i]) || NUMBERED.test(lines[i]))) {
        items.push(lines[i].replace(BULLET, '').replace(NUMBERED, ''))
        i++
      }
      const contents = items.map((it, n) => <li key={n}>{inline(it, `l${key}-${n}`)}</li>)
      blocks.push(
        ordered ? (
          <ol key={`b${key++}`} className="md-list">
            {contents}
          </ol>
        ) : (
          <ul key={`b${key++}`} className="md-list">
            {contents}
          </ul>
        )
      )
      continue
    }

    // blank lines separate paragraphs
    if (!line.trim()) {
      i++
      continue
    }

    // paragraph — gather until a blank line or a block-level construct
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    blocks.push(
      <p key={`b${key++}`} className="md-p">
        {inline(para.join('\n'), `p${key}`)}
      </p>
    )
  }

  return <>{blocks}</>
}
