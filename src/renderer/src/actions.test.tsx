// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ActionsSnapshot, ElectronApi, Profile } from '@shared/types'
import { ActionsDialog } from './components/ActionsDialog'

afterEach(cleanup)

const profile: Profile = {
  id: 'p1',
  label: 'web server',
  host: 'example.com',
  port: 22,
  username: 'root',
  keyPath: 'C:\\keys\\id_ed25519',
  rememberPassphrase: true
}

const snapshot: ActionsSnapshot = {
  actions: [
    {
      id: 'a1',
      label: 'Nightly www',
      profileId: 'p1',
      remotePaths: ['/var/www'],
      destination: 'C:\\backups',
      intervalValue: 3,
      intervalUnit: 'days',
      timeOfDay: '03:00',
      enabled: true,
      catchUp: true,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
      lastRunAt: '2026-10-19T03:00:00.000Z',
      nextRunAt: '2026-10-22T03:00:00.000Z',
      lastStatus: 'success',
      lastError: null
    }
  ],
  history: [],
  runningActionId: null,
  busy: false
}

describe('actions dialog', () => {
  let api: Pick<ElectronApi, 'actionsList' | 'onActionsChanged' | 'onBackupProgress'>

  beforeEach(() => {
    api = {
      actionsList: vi.fn(async () => snapshot),
      onActionsChanged: vi.fn(() => () => undefined),
      onBackupProgress: vi.fn(() => () => undefined)
    }
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  it('lists scheduled actions with their schedule', async () => {
    render(<ActionsDialog profiles={[profile]} onClose={() => undefined} />)

    await waitFor(() => expect(screen.getByText('Nightly www')).toBeTruthy())
    expect(screen.getByText('Every 3 days at 03:00')).toBeTruthy()
    expect(screen.getByText('web server')).toBeTruthy()
  })

  it('opens the editor for a new action', async () => {
    render(<ActionsDialog profiles={[profile]} onClose={() => undefined} />)

    await waitFor(() => expect(screen.getByText('Nightly www')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /New action/ }))

    expect(screen.getByText('New scheduled action')).toBeTruthy()
    expect(screen.getByLabelText('Remote folders to back up (one per line)')).toBeTruthy()
    expect(screen.getByLabelText('Action name')).toBeTruthy()
  })
})
