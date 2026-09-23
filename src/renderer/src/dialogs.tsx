import { useEffect, useRef, useState, type ReactNode } from 'react'

interface DialogState {
  kind: 'input' | 'confirm'
  title: string
  message?: string
  initial?: string
  resolve: (value: string | boolean | null) => void
}

interface DialogProps {
  state: DialogState
  close: (value: string | boolean | null) => void
}

function Dialog({ state, close }: DialogProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(state.initial ?? '')

  useEffect(() => {
    if (state.kind === 'input') inputRef.current?.select()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, close])

  const submit = (): void => {
    if (state.kind === 'input') {
      const trimmed = value.trim()
      close(trimmed || null)
    } else {
      close(true)
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null)
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-label={state.title}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      >
        <div className="dialog-title">{state.title}</div>
        {state.message && <div className="dialog-message">{state.message}</div>}
        {state.kind === 'input' && (
          <input
            ref={inputRef}
            className="input dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button className={`btn ${state.kind === 'confirm' ? 'btn-danger' : 'btn-primary'}`} onClick={submit}>
            {state.kind === 'confirm' ? 'Delete' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function useDialogs(): {
  askInput: (title: string, initial?: string) => Promise<string | null>
  askConfirm: (title: string, message: string) => Promise<boolean>
  node: ReactNode
} {
  const [state, setState] = useState<DialogState | null>(null)

  const close = (value: string | boolean | null): void => {
    const current = state
    setState(null)
    current?.resolve(value)
  }

  const askInput = (title: string, initial = ''): Promise<string | null> =>
    new Promise((resolve) =>
      setState({
        kind: 'input',
        title,
        initial,
        resolve: (value) => resolve(typeof value === 'string' ? value : null)
      })
    )

  const askConfirm = (title: string, message: string): Promise<boolean> =>
    new Promise((resolve) =>
      setState({
        kind: 'confirm',
        title,
        message,
        resolve: (value) => resolve(value === true)
      })
    )

  return {
    askInput,
    askConfirm,
    node: state ? <Dialog state={state} close={close} /> : null
  }
}
