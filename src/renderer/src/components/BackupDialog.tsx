import { useEffect, useState } from 'react'
import type { BackupProgress, BackupSummary } from '@shared/types'
import { errorMessage, formatSize } from '../format'
import { BackupProgressPanel } from './BackupProgress'

interface Props {
  remotePaths: string[]
  onClose: () => void
}

function defaultName(remotePaths: string[]): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  const base =
    remotePaths.length === 1
      ? remotePaths[0].split('/').filter(Boolean).pop() ?? 'backup'
      : 'backup'
  return `${base.replace(/[\\/:*?"<>|]/g, '-')}_${stamp}`
}

export function BackupDialog({ remotePaths, onClose }: Props): React.ReactElement {
  const [name, setName] = useState(() => defaultName(remotePaths))
  const [destination, setDestination] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [result, setResult] = useState<BackupSummary | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [last, home] = await Promise.all([
          window.api.backupLastDestination(),
          window.api.localHome()
        ])
        if (!cancelled) setDestination((current) => current || last || home)
      } catch {
        /* the folder can still be chosen manually */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () =>
      window.api.onBackupProgress((update) => {
        if (update.kind === 'backup') setProgress(update)
      }),
    []
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const chooseDestination = async (): Promise<void> => {
    try {
      const picked = await window.api.pickBackupDestination()
      if (picked) setDestination(picked)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const start = async (): Promise<void> => {
    setError(null)
    setProgress(null)
    setBusy(true)
    try {
      const summary = await window.api.backupCreate({
        remotePaths,
        destination: destination.trim(),
        name: name.trim()
      })
      setResult(summary)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    try {
      await window.api.backupCancel()
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Back up remote files"
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
        <div className="dialog-title">Back up remote files</div>

        {busy ? (
          <BackupProgressPanel progress={progress} onCancel={() => void cancel()} />
        ) : result ? (
          <div className="backup-summary">
            <div className="backup-success">
              ✓ Backup saved to <code>{result.backupDir}</code>
            </div>
            <div className="backup-summary-grid">
              <span>Files</span>
              <span>{result.manifest.totals.files}</span>
              <span>Folders</span>
              <span>{result.manifest.totals.dirs}</span>
              <span>Size</span>
              <span>{formatSize(result.manifest.totals.bytes, false)}</span>
              {result.manifest.skipped.length > 0 && (
                <>
                  <span>Skipped symlinks/special files</span>
                  <span>{result.manifest.skipped.length}</span>
                </>
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn btn-primary" onClick={onClose} autoFocus>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="backup-field">
              <span className="backup-label">Remote sources</span>
              <div className="backup-path-list">
                {remotePaths.map((p) => (
                  <code key={p}>{p}</code>
                ))}
              </div>
            </div>

            <label className="backup-field">
              <span className="backup-label">Backup name</span>
              <input
                className="input"
                value={name}
                spellCheck={false}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <div className="backup-field">
              <span className="backup-label">Save in</span>
              <span className="input-group">
                <input
                  className="input"
                  value={destination}
                  placeholder="Choose a local folder…"
                  spellCheck={false}
                  onChange={(e) => setDestination(e.target.value)}
                />
                <button
                  className="btn"
                  title="Choose a folder"
                  onClick={() => void chooseDestination()}
                >
                  …
                </button>
              </span>
            </div>

            {error && <div className="banner banner-danger">{error}</div>}

            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void start()}
                disabled={!name.trim() || !destination.trim()}
              >
                Start backup
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
