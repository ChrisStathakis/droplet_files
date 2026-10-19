import type { BackupProgress } from '@shared/types'
import { formatSize } from '../format'

interface Props {
  progress: BackupProgress | null
  onCancel: () => void
}

function phaseLabel(progress: BackupProgress): string {
  switch (progress.phase) {
    case 'scanning':
      return 'Scanning remote files…'
    case 'verifying':
      return 'Verifying local backup…'
    case 'downloading':
      return 'Downloading backup…'
    case 'restoring':
      return 'Restoring files…'
    case 'finalizing':
      return 'Finalizing backup…'
    case 'done':
      return 'Complete'
    case 'cancelled':
      return 'Cancelled'
    case 'error':
      return 'Failed'
  }
}

export function BackupProgressPanel({ progress, onCancel }: Props): React.ReactElement {
  const pct = progress
    ? progress.bytesTotal > 0
      ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
      : progress.filesTotal > 0
        ? Math.min(100, Math.round((progress.filesDone / progress.filesTotal) * 100))
        : 0
    : 0

  const indeterminate = !progress || progress.filesTotal === 0

  return (
    <div className="backup-progress">
      <div className="backup-progress-head">
        <span>{progress ? phaseLabel(progress) : 'Starting…'}</span>
        <span className="backup-progress-count">
          {progress && progress.filesTotal > 0
            ? `${progress.filesDone} / ${progress.filesTotal} files`
            : progress?.message ?? ''}
        </span>
      </div>
      <div
        className={`progress backup-progress-bar${indeterminate ? ' progress-indeterminate' : ''}${
          progress?.phase === 'error' ? ' progress-error' : ''
        }`}
      >
        <div
          className="progress-fill"
          style={{ width: indeterminate ? '35%' : `${pct}%` }}
        />
      </div>
      <div className="backup-progress-footer">
        <span className="backup-progress-bytes">
          {progress && progress.bytesTotal > 0
            ? `${formatSize(progress.bytesDone, false)} / ${formatSize(progress.bytesTotal, false)}`
            : ''}
        </span>
        <span className="backup-progress-current" title={progress?.currentPath}>
          {progress?.message ?? progress?.currentPath ?? ''}
        </span>
      </div>
      <div className="dialog-actions">
        <button className="btn btn-danger" onClick={onCancel} autoFocus>
          Cancel
        </button>
      </div>
    </div>
  )
}
