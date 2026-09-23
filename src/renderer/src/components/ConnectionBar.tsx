import type { ConnectionStatus, Profile } from '@shared/types'

export interface ConnectionForm {
  host: string
  port: string
  username: string
  keyPath: string
  passphrase: string
  rememberPassphrase: boolean
  label: string
}

export const emptyForm: ConnectionForm = {
  host: '',
  port: '22',
  username: 'root',
  keyPath: '',
  passphrase: '',
  rememberPassphrase: false,
  label: ''
}

interface Props {
  status: ConnectionStatus
  profiles: Profile[]
  form: ConnectionForm
  selectedProfileId: string | null
  error: string | null
  onFormChange: (patch: Partial<ConnectionForm>) => void
  onSelectProfile: (id: string | null) => void
  onConnect: () => void
  onDisconnect: () => void
  onSaveProfile: () => void
  onDeleteProfile: () => void
  onPickKey: () => void
}

export function ConnectionBar({
  status,
  profiles,
  form,
  selectedProfileId,
  error,
  onFormChange,
  onSelectProfile,
  onConnect,
  onDisconnect,
  onSaveProfile,
  onDeleteProfile,
  onPickKey
}: Props): React.ReactElement {
  const connected = status.state === 'connected'
  const busy = status.state === 'connecting'
  const locked = connected || busy

  const canSave = form.host.trim().length > 0 && form.keyPath.trim().length > 0

  return (
    <header className="connection-bar">
      <div className="connection-row">
        <select
          className="input profile-select"
          value={selectedProfileId ?? ''}
          onChange={(e) => onSelectProfile(e.target.value || null)}
          title="Saved connections"
        >
          <option value="">— New connection —</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>

        <button
          className="btn"
          onClick={onSaveProfile}
          disabled={!canSave || busy}
          title={selectedProfileId ? 'Update this profile' : 'Save these connection details'}
        >
          💾 Save
        </button>
        <button
          className="btn btn-icon"
          onClick={onDeleteProfile}
          disabled={!selectedProfileId || busy}
          title="Delete selected profile"
        >
          ✕
        </button>

        <div className="spacer" />

        <span className={`status status-${status.state}`} title={status.message}>
          <span className="status-dot" />
          {status.state === 'connected'
            ? status.message ?? 'Connected'
            : status.state === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
        </span>
      </div>

      <div className="connection-row">
        <label className="field">
          <span>Host</span>
          <input
            className="input input-host"
            value={form.host}
            disabled={locked}
            placeholder="123.45.67.89"
            onChange={(e) => onFormChange({ host: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>Port</span>
          <input
            className="input input-port"
            value={form.port}
            disabled={locked}
            onChange={(e) => onFormChange({ port: e.target.value.replace(/[^0-9]/g, '') })}
            inputMode="numeric"
          />
        </label>
        <label className="field">
          <span>User</span>
          <input
            className="input input-user"
            value={form.username}
            disabled={locked}
            placeholder="root"
            onChange={(e) => onFormChange({ username: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="field field-grow">
          <span>Private key</span>
          <span className="input-group">
            <input
              className="input"
              value={form.keyPath}
              disabled={locked}
              placeholder="C:\Users\you\.ssh\id_ed25519"
              onChange={(e) => onFormChange({ keyPath: e.target.value })}
              spellCheck={false}
            />
            <button className="btn" onClick={onPickKey} disabled={locked} title="Browse…">
              …
            </button>
          </span>
        </label>
        <label className="field">
          <span>Passphrase</span>
          <input
            className="input input-pass"
            type="password"
            value={form.passphrase}
            disabled={locked}
            placeholder="(if key is encrypted)"
            onChange={(e) => onFormChange({ passphrase: e.target.value })}
          />
        </label>
        <label className="checkbox" title="Store the passphrase encrypted with your OS keychain">
          <input
            type="checkbox"
            checked={form.rememberPassphrase}
            disabled={locked}
            onChange={(e) => onFormChange({ rememberPassphrase: e.target.checked })}
          />
          Remember
        </label>

        <div className="spacer" />

        {connected || busy ? (
          <button className="btn btn-danger" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : (
          <button className="btn btn-primary btn-connect" onClick={onConnect}>
            Connect
          </button>
        )}
      </div>

      {error && <div className="banner banner-danger connection-error">{error}</div>}
    </header>
  )
}
