import type { HostKeyRequest } from '@shared/types'

interface Props {
  request: HostKeyRequest
  onRespond: (trusted: boolean) => void
}

export function HostKeyDialog({ request, onRespond }: Props): React.ReactElement {
  return (
    <div className="dialog-overlay">
      <div className="dialog dialog-wide" role="dialog" aria-label="Host key verification">
        <div className="dialog-title">
          {request.changed ? '⚠ Host key has changed' : 'Unknown host key'}
        </div>

        {request.changed ? (
          <div className="banner banner-danger">
            The server presented a <strong>different key</strong> than the one previously trusted
            for <code>{request.host}:{request.port}</code>. Someone could be intercepting your
            connection (man-in-the-middle attack). Only continue if you recently reinstalled or
            regenerated the server&apos;s host key.
          </div>
        ) : (
          <div className="dialog-message">
            The authenticity of <code>{request.host}:{request.port}</code> can&apos;t be established
            the first time you connect. Verify that the fingerprint below matches the one shown by
            your provider (e.g. in the DigitalOcean control panel) before trusting it.
          </div>
        )}

        <div className="fingerprint">
          <span className="fingerprint-label">SHA256 fingerprint</span>
          <code>{request.fingerprint}</code>
        </div>

        <div className="dialog-actions">
          <button className="btn" autoFocus onClick={() => onRespond(false)}>
            Cancel
          </button>
          <button
            className={`btn ${request.changed ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onRespond(true)}
          >
            {request.changed ? 'Replace trusted key' : 'Trust & connect'}
          </button>
        </div>
      </div>
    </div>
  )
}
