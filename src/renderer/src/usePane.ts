import { useCallback, useRef, useState } from 'react'
import type { DirListing, Side } from '@shared/types'
import { errorMessage } from './format'

export interface PaneApi {
  side: Side
  cwd: string
  listing: DirListing | null
  busy: boolean
  error: string | null
  /** Load a directory (defaults to the current one) */
  load: (path?: string) => Promise<void>
  up: () => Promise<void>
  refresh: () => Promise<void>
  reset: () => void
  /** Surface an operation error in this pane's banner */
  fail: (message: string) => void
  clearError: () => void
}

export function usePane(side: Side): PaneApi {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cwdRef = useRef('')

  const load = useCallback(
    async (path?: string): Promise<void> => {
      const target = path ?? cwdRef.current
      setBusy(true)
      try {
        const result =
          side === 'local' ? await window.api.listLocal(target) : await window.api.listRemote(target)
        cwdRef.current = result.path
        setCwd(result.path)
        setListing(result)
        setError(null)
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setBusy(false)
      }
    },
    [side]
  )

  const up = useCallback(async (): Promise<void> => {
    const parent = listing?.parent
    if (parent) await load(parent)
  }, [listing, load])

  const refresh = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const reset = useCallback((): void => {
    cwdRef.current = ''
    setCwd('')
    setListing(null)
    setBusy(false)
    setError(null)
  }, [])

  const fail = useCallback((message: string): void => setError(message), [])
  const clearError = useCallback((): void => setError(null), [])

  return { side, cwd, listing, busy, error, load, up, refresh, reset, fail, clearError }
}
