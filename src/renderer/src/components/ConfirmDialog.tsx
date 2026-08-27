import { useEffect } from 'react'

interface Props {
  title: string
  body: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Run anyway',
  danger = true,
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal confirm">
        <div className="modal-head">
          <h3>{title}</h3>
        </div>
        <div className="modal-body">{body}</div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
