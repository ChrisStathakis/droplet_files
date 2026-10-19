// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ElectronApi } from '@shared/types'
import { AboutDialog } from './components/AboutDialog'

afterEach(cleanup)

describe('about dialog', () => {
  it('shows the running app version', async () => {
    const api: Pick<ElectronApi, 'appInfo'> = {
      appInfo: vi.fn(async () => ({
        name: 'droplet-files',
        version: '0.2.1',
        electron: '44.4.4',
        platform: 'win32'
      }))
    }
    Object.defineProperty(window, 'api', { configurable: true, value: api })

    render(<AboutDialog onClose={() => undefined} />)

    await waitFor(() => expect(screen.getByText('0.2.1')).toBeTruthy())
    expect(screen.getByText('44.4.4')).toBeTruthy()
    expect(screen.getByText('win32')).toBeTruthy()
  })
})
