// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BackupInspection, ElectronApi } from '@shared/types'
import { BackupDialog } from './components/BackupDialog'
import { RestoreDialog } from './components/RestoreDialog'

afterEach(cleanup)

const inspection: BackupInspection = {
  backupDir: 'C:\\backups\\www_2026-10-19',
  manifest: {
    format: 'droplet-files-backup',
    version: 1,
    createdAt: '2026-10-19T12:00:00.000Z',
    appVersion: '0.2.1',
    connection: { host: 'example.com', port: 22, username: 'root' },
    originalDir: '/var/www',
    sources: [{ remotePath: '/var/www', backupPath: 'www', kind: 'dir' }],
    files: [],
    dirs: [{ path: 'www', mtime: 1, mode: 0o40755 }],
    skipped: [],
    totals: { files: 0, dirs: 1, bytes: 0 }
  }
}

describe('restore dialog', () => {
  let api: Pick<ElectronApi, 'backupRestore' | 'onBackupProgress'>

  beforeEach(() => {
    api = {
      backupRestore: vi.fn(async () => ({
        restored: 0,
        skipped: 0,
        renamed: 0,
        failed: 0,
        failures: []
      })),
      onBackupProgress: vi.fn(() => () => undefined)
    }
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  it('requires explicit confirmation before restoring to another server', async () => {
    const onCompleted = vi.fn()
    render(
      <RestoreDialog
        inspection={inspection}
        currentConnectionLabel="root@other.example:22"
        defaultRemoteDir="/tmp"
        onClose={() => undefined}
        onCompleted={onCompleted}
      />
    )

    expect(screen.getByText(/different server/i)).toBeTruthy()
    const restore = screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement
    expect(restore.disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/i }))
    await waitFor(() => expect(restore.disabled).toBe(false))
    fireEvent.click(restore)

    await waitFor(() => expect(api.backupRestore).toHaveBeenCalledTimes(1))
    expect(api.backupRestore).toHaveBeenCalledWith({
      backupDir: inspection.backupDir,
      remoteDir: '/var/www',
      conflictPolicy: 'keep-both',
      verifyChecksums: true,
      allowHostMismatch: true
    })
    await waitFor(() => expect(onCompleted).toHaveBeenCalled())
  })
})

describe('backup dialog', () => {
  let api: Pick<
    ElectronApi,
    'backupCreate' | 'backupLastDestination' | 'localHome' | 'onBackupProgress'
  >

  beforeEach(() => {
    api = {
      backupCreate: vi.fn(async (input) => ({
        backupDir: `C:\\backups\\${input.name}`,
        manifest: inspection.manifest
      })),
      backupLastDestination: vi.fn(async () => 'C:\\backups'),
      localHome: vi.fn(async () => 'C:\\Users\\tester'),
      onBackupProgress: vi.fn(() => () => undefined)
    }
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  it('prefills the last destination and starts a backup', async () => {
    render(<BackupDialog remotePaths={['/var/www']} onClose={() => undefined} />)

    const name = screen.getByLabelText('Backup name') as HTMLInputElement
    const destination = screen.getByPlaceholderText(/Choose a local folder/i) as HTMLInputElement
    await waitFor(() => expect(destination.value).toBe('C:\\backups'))
    expect(name.value).toMatch(/^www_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/)

    fireEvent.click(screen.getByRole('button', { name: 'Start backup' }))
    await waitFor(() => expect(api.backupCreate).toHaveBeenCalledTimes(1))
    expect(api.backupCreate).toHaveBeenCalledWith({
      remotePaths: ['/var/www'],
      destination: 'C:\\backups',
      name: name.value
    })
    await waitFor(() => expect(screen.getByText(/Backup saved to/i)).toBeTruthy())
  })
})
