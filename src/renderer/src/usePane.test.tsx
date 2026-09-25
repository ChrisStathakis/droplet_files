// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { DirListing, ElectronApi } from '@shared/types'
import { usePane } from './usePane'

afterEach(cleanup)

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function listing(path: string): DirListing {
  return { path, parent: '/', entries: [] }
}

describe('usePane directory request ordering', () => {
  let api: Pick<ElectronApi, 'listLocal' | 'listRemote'>

  beforeEach(() => {
    api = {
      listLocal: vi.fn(async (path) => listing(path)),
      listRemote: vi.fn(async (path) => listing(path))
    }
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  it('ignores an older response when a newer navigation finishes first', async () => {
    const slow = deferred<DirListing>()
    const fast = deferred<DirListing>()
    vi.mocked(api.listLocal).mockImplementation((path) =>
      path === '/slow' ? slow.promise : fast.promise
    )
    const { result } = renderHook(() => usePane('local'))
    let slowRequest!: Promise<void>
    let fastRequest!: Promise<void>

    act(() => {
      slowRequest = result.current.load('/slow')
      fastRequest = result.current.load('/fast')
    })
    await act(async () => {
      fast.resolve(listing('/fast'))
      await fastRequest
    })
    await act(async () => {
      slow.resolve(listing('/slow'))
      await slowRequest
    })

    expect(result.current.cwd).toBe('/fast')
    expect(result.current.listing?.path).toBe('/fast')
    expect(result.current.busy).toBe(false)
  })

  it('ignores a pending response after the pane resets', async () => {
    const pending = deferred<DirListing>()
    vi.mocked(api.listLocal).mockReturnValue(pending.promise)
    const { result } = renderHook(() => usePane('local'))
    let request!: Promise<void>
    act(() => {
      request = result.current.load('/pending')
    })
    act(() => result.current.reset())
    await act(async () => {
      pending.resolve(listing('/pending'))
      await request
    })

    expect(result.current.cwd).toBe('')
    expect(result.current.listing).toBeNull()
    expect(result.current.busy).toBe(false)
  })
})
