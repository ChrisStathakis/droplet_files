// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { useDialogs } from './dialogs'

afterEach(cleanup)

function ConfirmationHarness(): React.ReactElement {
  const [confirmed, setConfirmed] = useState(false)
  const { askConfirm, node } = useDialogs()
  return (
    <>
      <button onClick={() => void askConfirm('Delete item', 'This cannot be undone').then(setConfirmed)}>
        Open confirmation
      </button>
      {confirmed && <span>Confirmed</span>}
      {node}
    </>
  )
}

describe('confirmation dialog keyboard behavior', () => {
  it('keeps Enter on Cancel from confirming a destructive action', async () => {
    render(<ConfirmationHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(document.activeElement).toBe(cancel)
    fireEvent.keyDown(cancel, { key: 'Enter', code: 'Enter' })

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByText('Confirmed')).toBeNull()

    fireEvent.click(cancel)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText('Confirmed')).toBeNull()
  })

  it('keeps keyboard focus inside the dialog', () => {
    render(<ConfirmationHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }))

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Delete' })
    fireEvent.keyDown(cancel, { key: 'Tab', code: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
    fireEvent.keyDown(confirm, { key: 'Tab', code: 'Tab' })
    expect(document.activeElement).toBe(cancel)
  })
})
