import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { errorMessage } from '../format'

interface Props {
  /** Drawer visibility — the session and scrollback stay alive while hidden */
  visible: boolean
  /** Host label shown in the drawer header */
  title: string
  onClose: () => void
}

const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 240
const MAX_HEIGHT_RATIO = 0.75

/**
 * Bottom drawer holding a single shared PTY session on the current SSH
 * connection. The xterm instance is created on first show, kept alive while
 * hidden (so scrollback survives toggling), and disposed when the component
 * unmounts — App only mounts this while connected.
 */
export function TerminalDrawer({ visible, title, onClose }: Props): React.ReactElement {
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const shellOpenRef = useRef(false)
  const shellOpeningRef = useRef(false)
  const shellAttemptRef = useRef(0)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [shellState, setShellState] = useState<'closed' | 'opening' | 'open'>('closed')

  /** Re-measures the container; never fits a hidden (zero-size) drawer */
  const fit = useCallback(() => {
    const el = bodyRef.current
    if (!el || !visible) return
    if (el.clientWidth === 0 || el.clientHeight === 0) return
    try {
      fitRef.current?.fit()
    } catch {
      /* mid-layout or already disposed */
    }
  }, [visible])

  const openShell = useCallback(async (): Promise<void> => {
    const term = termRef.current
    if (!term || shellOpenRef.current || shellOpeningRef.current) return
    shellOpeningRef.current = true
    setShellState('opening')
    const attempt = ++shellAttemptRef.current
    try {
      await window.api.shellOpen({ cols: term.cols, rows: term.rows })
      if (attempt !== shellAttemptRef.current || termRef.current !== term) return
      shellOpenRef.current = true
      setShellState('open')
      fit()
      await window.api.shellResize(term.cols, term.rows)
    } catch (err) {
      if (attempt === shellAttemptRef.current && termRef.current === term) {
        setShellState('closed')
        term.write(`\r\n\x1b[31m${errorMessage(err)}\x1b[0m\r\n`)
      }
    } finally {
      if (attempt === shellAttemptRef.current) shellOpeningRef.current = false
    }
  }, [fit])

  // Create one terminal instance and reopen its PTY whenever it is shown again.
  useEffect(() => {
    if (!visible || !bodyRef.current) return
    if (!termRef.current) {
      const term = new Terminal({
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#0e1116', foreground: '#d7dde5' }
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(bodyRef.current)
      termRef.current = term
      fitRef.current = fitAddon
      fit()
      term.onData((data) => {
        void window.api.shellWrite(data).catch(() => {
          /* session already gone — keystroke dropped */
        })
      })
      term.onResize(({ cols, rows }) => {
        void window.api.shellResize(cols, rows).catch(() => {})
      })
    }
    void openShell()
    // openShell reads the terminal ref, which this effect initializes above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // Dispose only when the connection (and therefore this component) goes away
  useEffect(
    () => () => {
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
      shellAttemptRef.current++
      shellOpenRef.current = false
      shellOpeningRef.current = false
    },
    []
  )

  // Feed shell output into the terminal
  useEffect(() => {
    const offData = window.api.onShellData((chunk) => termRef.current?.write(chunk))
    const offClosed = window.api.onShellClosed((event) => {
      shellAttemptRef.current++
      shellOpenRef.current = false
      shellOpeningRef.current = false
      setShellState('closed')
      termRef.current?.write(
        `\r\n\x1b[33m[shell closed${event.reason ? `: ${event.reason}` : ''}]\x1b[0m\r\n`
      )
    })
    return () => {
      offData()
      offClosed()
    }
  }, [])

  // Fit and focus whenever the drawer is (re)shown
  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      fit()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, fit])

  // Follow drawer drags and window resizes
  useEffect(() => {
    if (!visible) return
    const el = bodyRef.current
    if (!el) return
    const observer = new ResizeObserver(() => fit())
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible, fit])

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO))
    const move = (ev: MouseEvent): void => {
      setHeight(Math.min(max, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY))))
    }
    const stop = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <section
      className={`terminal-drawer${visible ? '' : ' terminal-hidden'}`}
      style={visible ? { height } : undefined}
      aria-hidden={!visible}
    >
      <div className="terminal-resize-handle" onMouseDown={startDrag} />
      <div className="terminal-header">
        <span className="terminal-heading">⌨ Shell</span>
        <span className="terminal-host" title={title}>
          {title}
        </span>
        <span className="spacer" />
        <span className="terminal-hint">Ctrl+` toggles</span>
        {shellState === 'opening' && <span className="terminal-hint">Opening shell…</span>}
        {shellState === 'closed' && (
          <button className="btn btn-sm" onClick={() => void openShell()}>
            Restart shell
          </button>
        )}
        <button className="btn btn-sm btn-icon" onClick={onClose} title="Hide terminal">
          ✕
        </button>
      </div>
      <div className="terminal-body" ref={bodyRef} />
    </section>
  )
}
