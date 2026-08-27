import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  separatorBefore?: boolean
}

interface Props {
  /** Position under an element… */
  anchorRef?: React.RefObject<HTMLElement | null>
  /** …or at an explicit point (right-click). */
  point?: { x: number; y: number }
  items: MenuItem[]
  onClose: () => void
}

/**
 * Rendered into <body> so no ancestor's `overflow` or stacking context can clip
 * it, and positioned in viewport coordinates.
 */
export default function DropMenu({ anchorRef, point, items, onClose }: Props): React.JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const place = (): void => {
      if (point) {
        // keep the menu on screen when opened near an edge
        const w = 190
        const h = items.length * 30 + 10
        setPos({
          top: Math.min(point.y, window.innerHeight - h - 8),
          left: Math.min(point.x, window.innerWidth - w - 8)
        })
        return
      }
      const r = anchorRef?.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 5, right: Math.max(8, window.innerWidth - r.right) })
    }
    place()

    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // a click inside the menu must reach the item's onClick, and a click on
      // the trigger is handled by the trigger itself
      if (menuRef.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [anchorRef, point, items.length, onClose])

  if (!pos) return null

  return createPortal(
    <div className="drop-menu" style={pos} ref={menuRef}>
      {items.map((it, i) => (
        <div key={it.label}>
          {it.separatorBefore && i > 0 && <div className="drop-sep" />}
          <button
            className={it.danger ? 'danger' : undefined}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
