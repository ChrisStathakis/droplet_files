import { useEffect, useRef, useState } from 'react'
import type {
  ActionDefinition,
  ActionIntervalUnit,
  ActionRunEntry,
  ActionsSnapshot,
  BackupProgress,
  Profile
} from '@shared/types'
import { describeSchedule } from '@shared/actionSchedule'
import { useDialogs } from '../dialogs'
import { errorMessage, formatSize } from '../format'
import { BackupProgressPanel } from './BackupProgress'

interface Props {
  profiles: Profile[]
  onClose: () => void
}

function statusLabel(action: ActionDefinition, runningActionId: string | null): string {
  if (runningActionId === action.id) return 'Running'
  switch (action.lastStatus) {
    case 'running':
      return 'Running'
    case 'success':
      return 'OK'
    case 'failed':
      return 'Failed'
    case 'skipped':
      return 'Skipped'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Never run'
  }
}

function badgeClass(status: string): string {
  if (status === 'success' || status === 'running') return 'badge-ok'
  if (status === 'failed') return 'badge-fail'
  return 'badge-muted'
}

function formatStamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString()
}

export function ActionsDialog({ profiles, onClose }: Props): React.ReactElement {
  const [snapshot, setSnapshot] = useState<ActionsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ action: ActionDefinition | null } | null>(null)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const { askConfirm, node: confirmNode } = useDialogs()
  const confirmOpen = Boolean(confirmNode)

  const editorRef = useRef(editor)
  editorRef.current = editor

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const value = await window.api.actionsList()
        if (!cancelled) setSnapshot(value)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err))
      }
    })()
    const off = window.api.onActionsChanged((value) => setSnapshot(value))
    return () => {
      cancelled = true
      off()
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
      if (e.key !== 'Escape' || confirmOpen) return
      if (editorRef.current) setEditor(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmOpen, onClose])

  const runningActionId = snapshot?.runningActionId ?? null
  const busy = snapshot?.busy ?? false
  const runningAction = snapshot?.actions.find((a) => a.id === runningActionId) ?? null

  const runNow = async (id: string): Promise<void> => {
    setError(null)
    setProgress(null)
    try {
      await window.api.actionsRunNow(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const setEnabled = async (action: ActionDefinition, enabled: boolean): Promise<void> => {
    setError(null)
    try {
      setSnapshot(await window.api.actionsSetEnabled(action.id, enabled))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const removeAction = async (action: ActionDefinition): Promise<void> => {
    const ok = await askConfirm(
      'Delete scheduled action',
      `Delete "${action.label}"? Existing backup folders are not touched.`
    )
    if (!ok) return
    setError(null)
    try {
      setSnapshot(await window.api.actionsDelete(action.id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const deleteBackup = async (run: ActionRunEntry): Promise<void> => {
    const ok = await askConfirm(
      'Delete backup',
      `Delete this backup folder?\n${run.backupDir ?? ''}\n\nThis cannot be undone.`
    )
    if (!ok) return
    setError(null)
    try {
      setSnapshot(await window.api.actionsDeleteBackup(run.id))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const openFolder = async (dir: string): Promise<void> => {
    try {
      await window.api.actionsOpenFolder(dir)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !editor) onClose()
      }}
    >
      <div
        className="dialog dialog-wide actions-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scheduled actions"
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
        <div className="dialog-title">⏱ Scheduled actions</div>

        {error && <div className="banner banner-danger">{error}</div>}

        {editor ? (
          <ActionEditor
            initial={editor.action}
            profiles={profiles}
            onCancel={() => setEditor(null)}
            onSaved={(value) => {
              setSnapshot(value)
              setEditor(null)
            }}
          />
        ) : (
          <>
            {busy && !runningActionId && (
              <div className="banner banner-warning">
                A backup or restore is running — scheduled actions wait for it.
              </div>
            )}

            {runningActionId && (
              <div className="actions-running">
                <div className="actions-running-title">
                  Running “{runningAction?.label ?? 'scheduled action'}”
                </div>
                <BackupProgressPanel
                  progress={progress}
                  onCancel={() => void window.api.actionsCancelRun().catch(() => undefined)}
                />
              </div>
            )}

            <div className="actions-toolbar">
              <button
                className="btn btn-primary"
                onClick={() => setEditor({ action: null })}
                disabled={profiles.length === 0}
                title={
                  profiles.length === 0
                    ? 'Save a connection profile first'
                    : 'Create a scheduled backup'
                }
              >
                + New action
              </button>
              <span className="actions-hint">
                Runs while the app is open (closing the window keeps it in the tray).
              </span>
            </div>

            {profiles.length === 0 && (
              <div className="banner banner-warning">
                Save a connection profile first — actions connect on their own with a saved
                profile.
              </div>
            )}

            <div className="actions-list">
              {snapshot === null ? (
                <div className="actions-empty">Loading…</div>
              ) : snapshot.actions.length === 0 ? (
                <div className="actions-empty">No scheduled actions yet.</div>
              ) : (
                snapshot.actions.map((action) => {
                  const profile = profiles.find((p) => p.id === action.profileId)
                  return (
                    <div className="action-card" key={action.id}>
                      <div className="action-card-head">
                        <span className={`badge ${badgeClass(statusLabel(action, runningActionId))}`}>
                          {statusLabel(action, runningActionId)}
                        </span>
                        <span className="action-name">{action.label}</span>
                        <span className="action-schedule">{describeSchedule(action)}</span>
                        <div className="spacer" />
                        <button
                          className="btn btn-sm"
                          onClick={() => void runNow(action.id)}
                          disabled={!!runningActionId || busy}
                          title={
                            busy
                              ? 'A backup or restore is already running'
                              : 'Back up now'
                          }
                        >
                          ▶ Run now
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => void setEnabled(action, !action.enabled)}
                          disabled={runningActionId === action.id}
                        >
                          {action.enabled ? 'Pause' : 'Enable'}
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => setEditor({ action })}
                          disabled={runningActionId === action.id}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => void removeAction(action)}
                          disabled={runningActionId === action.id}
                        >
                          Delete
                        </button>
                      </div>
                      <div className="action-card-meta">
                        <span
                          title={
                            profile
                              ? `${profile.username}@${profile.host}:${profile.port}`
                              : 'Profile missing'
                          }
                        >
                          {profile ? profile.label : '⚠ profile missing'}
                        </span>
                        <span title={action.remotePaths.join('\n')}>
                          {action.remotePaths.join(', ')}
                        </span>
                        <span title={action.destination}>→ {action.destination}</span>
                        <span>
                          {action.enabled
                            ? `Next: ${formatStamp(action.nextRunAt)}`
                            : 'Paused'}
                        </span>
                        {action.lastRunAt && <span>Last: {formatStamp(action.lastRunAt)}</span>}
                      </div>
                      {action.lastError && (
                        <div className="action-error">{action.lastError}</div>
                      )}
                    </div>
                  )
                })
              )}
            </div>

            <div className="actions-section-title">History</div>
            <div className="action-history">
              {snapshot === null || snapshot.history.length === 0 ? (
                <div className="actions-empty">No runs yet.</div>
              ) : (
                snapshot.history.slice(0, 50).map((run) => (
                  <div className="action-run" key={run.id}>
                    <span className={`badge ${badgeClass(run.status)}`}>{run.status}</span>
                    <span className="action-run-name">{run.actionLabel}</span>
                    <span className="action-run-time">
                      {formatStamp(run.startedAt)}
                      {run.trigger === 'manual' ? ' · manual' : ''}
                    </span>
                    <span className="action-run-summary" title={run.error ?? undefined}>
                      {run.status === 'success'
                        ? `${run.files} file(s), ${formatSize(run.bytes, false)}`
                        : run.error ?? ''}
                    </span>
                    <div className="spacer" />
                    {run.backupDir && (
                      <>
                        <button
                          className="btn btn-sm"
                          onClick={() => void openFolder(run.backupDir as string)}
                        >
                          Open
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => void deleteBackup(run)}
                        >
                          Delete backup
                        </button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}

        {confirmNode}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- editor

interface EditorProps {
  initial: ActionDefinition | null
  profiles: Profile[]
  onCancel: () => void
  onSaved: (snapshot: ActionsSnapshot) => void
}

function ActionEditor({ initial, profiles, onCancel, onSaved }: EditorProps): React.ReactElement {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [profileId, setProfileId] = useState(initial?.profileId ?? profiles[0]?.id ?? '')
  const [remotePaths, setRemotePaths] = useState((initial?.remotePaths ?? []).join('\n'))
  const [destination, setDestination] = useState(initial?.destination ?? '')
  const [intervalValue, setIntervalValue] = useState(String(initial?.intervalValue ?? 3))
  const [intervalUnit, setIntervalUnit] = useState<ActionIntervalUnit>(
    initial?.intervalUnit ?? 'days'
  )
  const [timeEnabled, setTimeEnabled] = useState(initial?.timeOfDay != null)
  const [timeOfDay, setTimeOfDay] = useState(initial?.timeOfDay ?? '03:00')
  const [catchUp, setCatchUp] = useState(initial?.catchUp ?? true)
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (destination) return
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
  }, [destination])

  const profile = profiles.find((p) => p.id === profileId) ?? null

  const chooseDestination = async (): Promise<void> => {
    try {
      const picked = await window.api.pickBackupDestination()
      if (picked) setDestination(picked)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const save = async (): Promise<void> => {
    setError(null)
    setSaving(true)
    try {
      const value = await window.api.actionsSave({
        id: initial?.id,
        label,
        profileId,
        remotePaths: remotePaths
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        destination,
        intervalValue: Number(intervalValue) || 1,
        intervalUnit,
        timeOfDay: timeEnabled && intervalUnit !== 'hours' ? timeOfDay : null,
        enabled,
        catchUp
      })
      onSaved(value)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const canSave =
    label.trim().length > 0 &&
    profileId.length > 0 &&
    remotePaths.trim().length > 0 &&
    destination.trim().length > 0 &&
    !saving

  return (
    <>
      <div className="dialog-title backup-label-title">
        {initial ? 'Edit action' : 'New scheduled action'}
      </div>

      <label className="backup-field">
        <span className="backup-label">Action name</span>
        <input
          className="input"
          value={label}
          spellCheck={false}
          autoFocus
          placeholder="Nightly website"
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      <label className="backup-field">
        <span className="backup-label">Saved connection</span>
        <select
          className="input"
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
        >
          {profiles.length === 0 && <option value="">— no saved profiles —</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.username}@{p.host})
            </option>
          ))}
        </select>
      </label>

      {profile && !profile.rememberPassphrase && (
        <div className="banner banner-warning">
          “{profile.label}” does not remember its passphrase. If the private key is encrypted,
          scheduled runs cannot connect — edit the profile above with “Remember” ticked.
        </div>
      )}

      <label className="backup-field">
        <span className="backup-label">Remote folders to back up (one per line)</span>
        <textarea
          className="input actions-textarea"
          rows={3}
          value={remotePaths}
          spellCheck={false}
          placeholder={'/var/www\n/etc/nginx'}
          onChange={(e) => setRemotePaths(e.target.value)}
        />
      </label>

      <div className="backup-field">
        <span className="backup-label">Save backups in</span>
        <span className="input-group">
          <input
            className="input"
            value={destination}
            placeholder="Choose a local folder…"
            spellCheck={false}
            onChange={(e) => setDestination(e.target.value)}
          />
          <button className="btn" title="Choose a folder" onClick={() => void chooseDestination()}>
            …
          </button>
        </span>
      </div>

      <div className="actions-row">
        <label className="field">
          <span>Every</span>
          <input
            className="input input-interval"
            value={intervalValue}
            inputMode="numeric"
            onChange={(e) => setIntervalValue(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </label>
        <label className="field">
          <span>Unit</span>
          <select
            className="input"
            value={intervalUnit}
            onChange={(e) => setIntervalUnit(e.target.value as ActionIntervalUnit)}
          >
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
          </select>
        </label>
        {intervalUnit !== 'hours' && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={timeEnabled}
                onChange={(e) => setTimeEnabled(e.target.checked)}
              />
              At a fixed time
            </label>
            {timeEnabled && (
              <input
                className="input input-time"
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
              />
            )}
          </>
        )}
      </div>

      <label className="checkbox" title="Runs a missed backup when the app opens again">
        <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} />
        Catch up on missed runs when the app opens
      </label>

      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {error && <div className="banner banner-danger">{error}</div>}

      <div className="dialog-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={!canSave}>
          {initial ? 'Save changes' : 'Create action'}
        </button>
      </div>
    </>
  )
}
