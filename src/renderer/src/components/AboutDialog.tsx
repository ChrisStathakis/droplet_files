import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { errorMessage } from '../format'

interface Props {
  onClose: () => void
}

export function AboutDialog({ onClose }: Props): React.ReactElement {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const value = await window.api.appInfo()
        if (!cancelled) setInfo(value)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Help and about"
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const focusable = e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
          )
          if (focusable.length === 0) {
            e.preventDefault()
            e.currentTarget.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }}
      >
        <div className="dialog-title">Help — Droplet Files</div>

        {error && <div className="banner banner-danger">{error}</div>}

        <div className="about-version">
          Version <strong>{info?.version ?? '…'}</strong>
        </div>

        <div className="about-grid">
          <span>Electron</span>
          <span>{info?.electron ?? '…'}</span>
          <span>Platform</span>
          <span>{info?.platform ?? '…'}</span>
        </div>

        <div className="about-help">
          <div>
            <strong>Backup:</strong> select files in the Remote pane, or select nothing to back up
            the current folder, then press 🗄 Backup.
          </div>
          <div>
            <strong>Restore:</strong> in the Local pane press ♻ Restore and pick a backup folder.
          </div>
          <div>
            <strong>Scheduled actions:</strong> press ⏱ Actions to back up remote folders
            automatically every few hours/days. Actions run while the app is open (also from the
            tray) and keep a run history.
          </div>
        </div>

        <div className="dialog-actions">
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
