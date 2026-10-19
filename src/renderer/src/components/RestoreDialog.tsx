import { useEffect, useState } from 'react'
import type {
  BackupConflictPolicy,
  BackupInspection,
  BackupProgress,
  RestoreResult
} from '@shared/types'
import { errorMessage, formatSize } from '../format'
import { BackupProgressPanel } from './BackupProgress'

interface Props {
  inspection: BackupInspection
  /** Current connection label, e.g. "root@1.2.3.4:22" */
  currentConnectionLabel?: string
  /** Fallback when the manifest has no common original directory */
  defaultRemoteDir: string
  onClose: () => void
  onCompleted: () => void
}

function connectionLabel(inspection: BackupInspection): string {
  const c = inspection.manifest.connection
  return `${c.username}@${c.host}:${c.port}`
}

export function RestoreDialog({
  inspection,
  currentConnectionLabel,
  defaultRemoteDir,
  onClose,
  onCompleted
}: Props): React.ReactElement {
  const manifest = inspection.manifest
  const [remoteDir, setRemoteDir] = useState(
    manifest.originalDir ?? defaultRemoteDir ?? ''
  )
  const [policy, setPolicy] = useState<BackupConflictPolicy>('keep-both')
  const [verifyChecksums, setVerifyChecksums] = useState(true)
  const [allowMismatch, setAllowMismatch] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)

  const expectedLabel = connectionLabel(inspection)
  const mismatch = !!currentConnectionLabel && currentConnectionLabel !== expectedLabel

  useEffect(
    () =>
      window.api.onBackupProgress((update) => {
        if (update.kind === 'restore') setProgress(update)
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

  const start = async (): Promise<void> => {
    setError(null)
    setProgress(null)
    setBusy(true)
    try {
      const restored = await window.api.backupRestore({
        backupDir: inspection.backupDir,
        remoteDir: remoteDir.trim(),
        conflictPolicy: policy,
        verifyChecksums,
        allowHostMismatch: mismatch ? allowMismatch : false
      })
      setResult(restored)
      onCompleted()
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
        aria-label="Restore backup"
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
        <div className="dialog-title">Restore backup</div>

        {busy ? (
          <BackupProgressPanel progress={progress} onCancel={() => void cancel()} />
        ) : result ? (
          <div className="backup-summary">
            <div className={result.failed > 0 ? 'backup-warning' : 'backup-success'}>
              {result.failed > 0 ? '⚠ Restore finished with errors' : '✓ Restore complete'} —{' '}
              <code>{remoteDir}</code>
            </div>
            <div className="backup-summary-grid">
              <span>Restored</span>
              <span>{result.restored}</span>
              <span>Renamed (kept both)</span>
              <span>{result.renamed}</span>
              <span>Skipped</span>
              <span>{result.skipped}</span>
              <span>Failed</span>
              <span>{result.failed}</span>
            </div>
            {result.failures.length > 0 && (
              <div className="backup-failures">
                {result.failures.slice(0, 10).map((failure) => (
                  <div key={failure.path}>
                    <code>{failure.path}</code> — {failure.error}
                  </div>
                ))}
                {result.failures.length > 10 && (
                  <div>…and {result.failures.length - 10} more</div>
                )}
              </div>
            )}
            <div className="dialog-actions">
              <button className="btn btn-primary" onClick={onClose} autoFocus>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="backup-summary-grid">
              <span>Created</span>
              <span>{new Date(manifest.createdAt).toLocaleString()}</span>
              <span>Server</span>
              <span>{expectedLabel}</span>
              <span>Contents</span>
              <span>
                {manifest.totals.files} files, {manifest.totals.dirs} folders,{' '}
                {formatSize(manifest.totals.bytes, false)}
              </span>
              {manifest.skipped.length > 0 && (
                <>
                  <span>Skipped at backup</span>
                  <span>{manifest.skipped.length} symlinks/special files</span>
                </>
              )}
            </div>

            <div className="backup-field">
              <span className="backup-label">Remote sources</span>
              <div className="backup-path-list">
                {manifest.sources.map((source) => (
                  <code key={source.remotePath}>{source.remotePath}</code>
                ))}
              </div>
            </div>

            {mismatch && (
              <div className="banner banner-danger backup-warning">
                This backup was created on <code>{expectedLabel}</code>, but you are
                connected as <code>{currentConnectionLabel}</code>.
                <label className="checkbox backup-confirm">
                  <input
                    type="checkbox"
                    checked={allowMismatch}
                    onChange={(e) => setAllowMismatch(e.target.checked)}
                  />
                  I understand and want to restore to this different server
                </label>
              </div>
            )}

            <label className="backup-field">
              <span className="backup-label">Restore to (remote folder)</span>
              <input
                className="input"
                value={remoteDir}
                spellCheck={false}
                autoFocus
                onChange={(e) => setRemoteDir(e.target.value)}
              />
              <span className="backup-hint">
                The backed-up sources are recreated inside this folder.
              </span>
            </label>

            <div className="backup-field">
              <span className="backup-label">If a file already exists</span>
              <div className="radio-group">
                <label className="radio">
                  <input
                    type="radio"
                    name="conflict-policy"
                    checked={policy === 'keep-both'}
                    onChange={() => setPolicy('keep-both')}
                  />
                  Keep both — save the restored file with a suffix
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="conflict-policy"
                    checked={policy === 'skip'}
                    onChange={() => setPolicy('skip')}
                  />
                  Skip existing files
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="conflict-policy"
                    checked={policy === 'overwrite'}
                    onChange={() => setPolicy('overwrite')}
                  />
                  Overwrite existing files
                </label>
              </div>
              {policy === 'overwrite' && (
                <div className="banner banner-danger">
                  Existing files at the destination will be permanently replaced.
                </div>
              )}
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={verifyChecksums}
                onChange={(e) => setVerifyChecksums(e.target.checked)}
              />
              Verify checksums before restoring
            </label>

            {error && <div className="banner banner-danger">{error}</div>}

            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void start()}
                disabled={!remoteDir.trim() || (mismatch && !allowMismatch)}
              >
                Restore
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
