import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConnectionStatus,
  HostKeyRequest,
  Profile,
  Side,
  TransferUpdate
} from '@shared/types'
import { ConnectionBar, emptyForm, type ConnectionForm } from './components/ConnectionBar'
import { FilePane } from './components/FilePane'
import { HostKeyDialog } from './components/HostKeyDialog'
import { TransferQueue } from './components/TransferQueue'
import { useDialogs } from './dialogs'
import { errorMessage } from './format'
import { usePane } from './usePane'

export default function App(): React.ReactElement {
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'disconnected' })
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [form, setForm] = useState<ConnectionForm>(emptyForm)
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
  const [hostKeyReq, setHostKeyReq] = useState<HostKeyRequest | null>(null)
  const [transfers, setTransfers] = useState<TransferUpdate[]>([])
  const [connectError, setConnectError] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([])

  const localPane = usePane('local')
  const remotePane = usePane('remote')
  const { askConfirm, node: dialogNode } = useDialogs()
  const cancelledRef = useRef(false)

  // ------------------------------------------------------------- subscriptions

  useEffect(() => {
    const offs = [
      window.api.onStatus(setStatus),
      window.api.onHostKeyRequest(setHostKeyReq),
      window.api.onTransfer((update) =>
        setTransfers((prev) => {
          const index = prev.findIndex((t) => t.id === update.id)
          if (index === -1) return [...prev, update]
          const next = [...prev]
          next[index] = update
          return next
        })
      )
    ]
    return () => offs.forEach((off) => off())
  }, [])

  // Reset the remote pane whenever we lose the connection
  useEffect(() => {
    if (status.state === 'disconnected') remotePane.reset()
  }, [status.state, remotePane.reset])

  // Initial load: local home + drive roots + saved profiles
  useEffect(() => {
    void (async () => {
      try {
        setProfiles(await window.api.listProfiles())
        setRoots(await window.api.localRoots())
        const home = await window.api.localHome()
        await localPane.load(home)
      } catch (err) {
        localPane.fail(errorMessage(err))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- connection

  const handleConnect = async (): Promise<void> => {
    cancelledRef.current = false
    setConnectError(null)
    if (!form.host.trim() || !form.username.trim() || !form.keyPath.trim()) {
      setConnectError('Host, user and private key are all required.')
      return
    }
    try {
      await window.api.connect({
        host: form.host.trim(),
        port: parseInt(form.port, 10) || 22,
        username: form.username.trim(),
        keyPath: form.keyPath.trim(),
        passphrase: form.passphrase || undefined,
        rememberPassphrase: form.rememberPassphrase,
        profileId: selectedProfileId ?? undefined
      })
      setForm((f) => ({ ...f, passphrase: '' }))
      const home = await window.api.remoteHome()
      await remotePane.load(home)
    } catch (err) {
      if (cancelledRef.current) {
        cancelledRef.current = false
        return
      }
      setConnectError(errorMessage(err))
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (status.state === 'connecting') cancelledRef.current = true
    try {
      await window.api.disconnect()
    } catch {
      /* ignore */
    }
  }

  const handleHostKeyResponse = async (trusted: boolean): Promise<void> => {
    const request = hostKeyReq
    setHostKeyReq(null)
    if (!request) return
    if (!trusted) cancelledRef.current = true
    try {
      await window.api.respondHostKey(request.requestId, trusted)
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ profiles

  const refreshProfiles = useCallback(async (): Promise<void> => {
    setProfiles(await window.api.listProfiles())
  }, [])

  const handleSelectProfile = (id: string | null): void => {
    setSelectedProfileId(id)
    setConnectError(null)
    const profile = id ? profiles.find((p) => p.id === id) : null
    setForm(
      profile
        ? {
            host: profile.host,
            port: String(profile.port),
            username: profile.username,
            keyPath: profile.keyPath,
            passphrase: '',
            rememberPassphrase: profile.rememberPassphrase,
            label: profile.label
          }
        : emptyForm
    )
  }

  const handleSaveProfile = async (): Promise<void> => {
    try {
      const saved = await window.api.saveProfile(
        {
          id: selectedProfileId ?? undefined,
          label: form.label || `${form.username}@${form.host}`,
          host: form.host.trim(),
          port: parseInt(form.port, 10) || 22,
          username: form.username.trim(),
          keyPath: form.keyPath.trim(),
          rememberPassphrase: form.rememberPassphrase
        },
        form.passphrase || undefined
      )
      await refreshProfiles()
      setSelectedProfileId(saved.id)
      setForm((f) => ({ ...f, label: saved.label }))
    } catch (err) {
      setConnectError(errorMessage(err))
    }
  }

  const handleDeleteProfile = async (): Promise<void> => {
    if (!selectedProfileId) return
    const profile = profiles.find((p) => p.id === selectedProfileId)
    const ok = await askConfirm('Delete profile', `Remove the saved connection "${profile?.label}"?`)
    if (!ok) return
    await window.api.deleteProfile(selectedProfileId)
    await refreshProfiles()
    setSelectedProfileId(null)
    setForm(emptyForm)
  }

  const handlePickKey = async (): Promise<void> => {
    const picked = await window.api.pickKeyFile()
    if (picked) setForm((f) => ({ ...f, keyPath: picked }))
  }

  // ----------------------------------------------------------------- transfers

  const connected = status.state === 'connected'

  const uploadInto = useCallback(
    async (paths: string[]): Promise<void> => {
      if (!connected || !remotePane.cwd) return
      try {
        await window.api.upload(paths, remotePane.cwd)
        await remotePane.refresh()
      } catch (err) {
        remotePane.fail(errorMessage(err))
      }
    },
    [connected, remotePane]
  )

  const downloadInto = useCallback(
    async (paths: string[]): Promise<void> => {
      if (!localPane.cwd) return
      try {
        await window.api.download(paths, localPane.cwd)
        await localPane.refresh()
      } catch (err) {
        localPane.fail(errorMessage(err))
      }
    },
    [localPane]
  )

  const copyInto = useCallback(
    async (files: string[]): Promise<void> => {
      if (!localPane.cwd) return
      try {
        await window.api.copyLocal(files, localPane.cwd)
        await localPane.refresh()
      } catch (err) {
        localPane.fail(errorMessage(err))
      }
    },
    [localPane]
  )

  // -------------------------------------------------------------------- render

  return (
    <div className="app">
      <ConnectionBar
        status={status}
        profiles={profiles}
        form={form}
        selectedProfileId={selectedProfileId}
        error={connectError}
        onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        onSelectProfile={handleSelectProfile}
        onConnect={() => void handleConnect()}
        onDisconnect={() => void handleDisconnect()}
        onSaveProfile={() => void handleSaveProfile()}
        onDeleteProfile={() => void handleDeleteProfile()}
        onPickKey={() => void handlePickKey()}
      />

      <main className="panes">
        <FilePane
          side={'local' as Side}
          heading="Local"
          pane={localPane}
          enabled={true}
          roots={roots}
          onDropPaths={downloadInto}
          onDropFiles={copyInto}
        />
        <FilePane
          side={'remote' as Side}
          heading="Remote"
          pane={remotePane}
          enabled={connected}
          roots={[]}
          onDropPaths={uploadInto}
          onDropFiles={uploadInto}
        />
      </main>

      <TransferQueue
        transfers={transfers}
        onClear={() =>
          setTransfers((prev) =>
            prev.filter((t) => t.state === 'queued' || t.state === 'active')
          )
        }
      />

      {hostKeyReq && (
        <HostKeyDialog request={hostKeyReq} onRespond={(t) => void handleHostKeyResponse(t)} />
      )}
      {dialogNode}
    </div>
  )
}
