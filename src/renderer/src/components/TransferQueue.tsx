import type { TransferUpdate } from '@shared/types'
import { formatSize } from '../format'

interface Props {
  transfers: TransferUpdate[]
  onClear: () => void
}

function progressBar(t: TransferUpdate): React.ReactElement {
  const pct = t.total > 0 ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0
  return (
    <div className="progress">
      <div
        className={`progress-fill ${t.state === 'error' ? 'progress-error' : ''}`}
        style={{ width: `${t.state === 'done' ? 100 : pct}%` }}
      />
    </div>
  )
}

export function TransferQueue({ transfers, onClear }: Props): React.ReactElement | null {
  if (transfers.length === 0) return null

  const activeCount = transfers.filter((t) => t.state === 'queued' || t.state === 'active').length
  const hasFinished = transfers.some((t) => t.state === 'done' || t.state === 'error')

  return (
    <footer className="transfer-queue">
      <div className="transfer-header">
        <span>
          Transfers — {activeCount > 0 ? `${activeCount} in progress` : 'idle'}
        </span>
        <button className="btn btn-sm" onClick={onClear} disabled={!hasFinished}>
          Clear finished
        </button>
      </div>
      <div className="transfer-list">
        {transfers.map((t) => (
          <div key={t.id} className={`transfer-row transfer-${t.state}`}>
            <span className="transfer-dir" title={t.direction === 'up' ? 'Upload' : 'Download'}>
              {t.direction === 'up' ? '⬆' : '⬇'}
            </span>
            <span className="transfer-name" title={t.error ?? t.name}>
              {t.name}
            </span>
            {progressBar(t)}
            <span className="transfer-bytes">
              {t.state === 'error' ? (
                <span className="transfer-error-text" title={t.error}>
                  ✗ {formatSize(t.transferred, false)} / {formatSize(t.total, false)} —{' '}
                  {t.error ?? 'failed'}
                </span>
              ) : t.state === 'done' ? (
                <>✓ {formatSize(t.total, false)}</>
              ) : (
                <>
                  {formatSize(t.transferred, false)} / {formatSize(t.total, false)}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </footer>
  )
}
