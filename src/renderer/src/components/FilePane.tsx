import { useEffect, useRef, useState } from 'react'
import type { DirEntry, Side } from '@shared/types'
import type { PaneApi } from '../usePane'
import { errorMessage, formatDate, formatSize, joinPath } from '../format'
import { useDialogs } from '../dialogs'

const PAYLOAD_PREFIX = 'application/x-droplet-'

interface Props {
  side: Side
  heading: string
  pane: PaneApi
  /** Whether transfers/navigation into this pane are possible (remote: must be connected) */
  enabled: boolean
  /** Local drive roots for the quick-pick dropdown (Windows) */
  roots: string[]
  /** Cross-pane transfer into this pane (paths originating from the other pane) */
  onDropPaths: (paths: string[]) => Promise<void>
  /** Files dropped from the operating system into this pane */
  onDropFiles: (files: string[]) => Promise<void>
}

function entryIcon(entry: DirEntry): string {
  if (entry.isSymlink && !entry.isDir) return '🔗'
  if (entry.isDir) return '📁'
  return '📄'
}

export function FilePane({
  side,
  heading,
  pane,
  enabled,
  roots,
  onDropPaths,
  onDropFiles
}: Props): React.ReactElement {
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [dragOver, setDragOver] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const anchorRef = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dragDepthRef = useRef(0)
  const { askInput, askConfirm, node: dialogNode } = useDialogs()

  const { listing, cwd, busy, error } = pane

  // Keep the path bar in sync and clear selection when the directory changes
  useEffect(() => {
    setPathDraft(cwd)
    setSelection(new Set())
    anchorRef.current = null
  }, [cwd])

  const entries = listing?.entries ?? []
  const payloadType = `${PAYLOAD_PREFIX}${side}`

  // ------------------------------------------------------------------ selection

  const select = (entry: DirEntry, index: number, event: React.MouseEvent): void => {
    if (event.shiftKey && anchorRef.current !== null) {
      const anchorIndex = entries.findIndex((e) => e.name === anchorRef.current)
      if (anchorIndex !== -1) {
        const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex]
        setSelection(new Set(entries.slice(from, to + 1).map((e) => e.name)))
        return
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelection((prev) => {
        const next = new Set(prev)
        if (next.has(entry.name)) next.delete(entry.name)
        else next.add(entry.name)
        return next
      })
      anchorRef.current = entry.name
    } else {
      setSelection(new Set([entry.name]))
      anchorRef.current = entry.name
    }
  }

  const openEntry = (entry: DirEntry): void => {
    if (entry.isDir) void pane.load(joinPath(side, cwd, entry.name))
  }

  // ---------------------------------------------------------------- drag & drop

  const dragPayloadPaths = (name: string): string[] => {
    const names = selection.has(name) ? [...selection] : [name]
    return names.map((n) => joinPath(side, cwd, n))
  }

  const onDragStart = (e: React.DragEvent, entry: DirEntry): void => {
    if (!enabled) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData(payloadType, JSON.stringify(dragPayloadPaths(entry.name)))
  }

  const dragSourceSide = (types: readonly string[]): Side | null => {
    if (types.includes(`${PAYLOAD_PREFIX}local`)) return 'local'
    if (types.includes(`${PAYLOAD_PREFIX}remote`)) return 'remote'
    return null
  }

  const acceptsDrag = (types: readonly string[]): boolean => {
    if (!enabled) return false
    const source = dragSourceSide(types)
    if (source !== null) return source !== side // only cross-pane drags
    return types.includes('Files') // files from the OS
  }

  const onDragEnter = (e: React.DragEvent): void => {
    if (!acceptsDrag([...e.dataTransfer.types])) return
    e.preventDefault()
    dragDepthRef.current++
    setDragOver(true)
  }

  const onDragOver = (e: React.DragEvent): void => {
    const accept = acceptsDrag([...e.dataTransfer.types])
    if (accept) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
    } else {
      e.dataTransfer.dropEffect = 'none'
    }
  }

  const onDragLeave = (): void => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    dragDepthRef.current = 0
    setDragOver(false)
    if (!enabled || !acceptsDrag([...e.dataTransfer.types])) return
    e.preventDefault()

    const source = dragSourceSide([...e.dataTransfer.types])
    try {
      if (source !== null && source !== side) {
        const raw = e.dataTransfer.getData(`${PAYLOAD_PREFIX}${source}`)
        const paths: string[] = JSON.parse(raw)
        if (paths.length) await onDropPaths(paths)
      } else if (source === null && e.dataTransfer.files.length > 0) {
        const files = [...e.dataTransfer.files]
          .map((f) => window.api.getPathForFile(f))
          .filter((p): p is string => p.length > 0)
        if (files.length) await onDropFiles(files)
      }
    } catch (err) {
      pane.fail(errorMessage(err))
    }
  }

  // ------------------------------------------------------------------ toolbar

  const createFolder = async (): Promise<void> => {
    if (!listing) return
    const name = await askInput('New folder', 'New folder')
    if (!name) return
    try {
      await window.api.mkdir(side, joinPath(side, cwd, name))
      await pane.refresh()
    } catch (err) {
      pane.fail(errorMessage(err))
    }
  }

  const renameSelection = async (): Promise<void> => {
    if (selection.size !== 1) return
    const current = [...selection][0]
    const name = await askInput('Rename', current)
    if (!name || name === current) return
    try {
      await window.api.rename(side, joinPath(side, cwd, current), joinPath(side, cwd, name))
      await pane.refresh()
      setSelection(new Set([name]))
    } catch (err) {
      pane.fail(errorMessage(err))
    }
  }

  const deleteSelection = async (): Promise<void> => {
    if (selection.size === 0 || !listing) return
    const names = [...selection]
    const hasDir = entries.some((e) => names.includes(e.name) && e.isDir)
    const label = names.length === 1 ? `"${names[0]}"` : `${names.length} items`
    const ok = await askConfirm(
      'Delete',
      `Delete ${label}${hasDir ? ' (including all contents of folders)' : ''}? This cannot be undone.`
    )
    if (!ok) return
    try {
      for (const name of names) {
        await window.api.remove(side, joinPath(side, cwd, name))
      }
      await pane.refresh()
      setSelection(new Set())
    } catch (err) {
      pane.fail(errorMessage(err))
      await pane.refresh()
    }
  }

  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Delete' && selection.size > 0) {
      e.preventDefault()
      void deleteSelection()
    } else if (e.key === 'F2' && selection.size === 1) {
      e.preventDefault()
      void renameSelection()
    } else if (e.key === 'Escape') {
      setSelection(new Set())
    }
  }

  // -------------------------------------------------------------------- render

  const toolbarDisabled = !listing || busy

  return (
    <section
      className={`pane ${dragOver ? 'pane-dragover' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="pane-header">
        <div className="pane-title-row">
          <span className={`pane-heading side-${side}`}>{heading}</span>
          <span className="pane-count">
            {listing ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : ''}
          </span>
          <span className={`spinner ${busy ? 'visible' : ''}`} aria-hidden />
          <div className="spacer" />
          <button
            className="btn btn-sm"
            onClick={() => void pane.up()}
            disabled={!listing?.parent || busy}
            title="Parent directory"
          >
            ⬆
          </button>
          <button
            className="btn btn-sm"
            onClick={() => void pane.refresh()}
            disabled={!listing || busy}
            title="Refresh"
          >
            ⟳
          </button>
        </div>

        <div className="pane-path-row">
          {side === 'local' && roots.length > 1 && (
            <select
              className="input roots-select"
              value=""
              title="Drives"
              onChange={(e) => {
                if (e.target.value) void pane.load(e.target.value)
              }}
            >
              <option value="">Drives</option>
              {roots.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <input
            className="input path-input"
            value={pathDraft}
            disabled={!enabled}
            spellCheck={false}
            placeholder={side === 'remote' ? 'Not connected' : 'Path'}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pathDraft.trim()) void pane.load(pathDraft.trim())
              if (e.key === 'Escape') setPathDraft(cwd)
            }}
          />
          <button
            className="btn btn-sm"
            onClick={() => void createFolder()}
            disabled={!enabled || toolbarDisabled}
            title="New folder"
          >
            📁+
          </button>
          <button
            className="btn btn-sm"
            onClick={() => void renameSelection()}
            disabled={toolbarDisabled || selection.size !== 1}
            title="Rename selected (F2)"
          >
            ✎
          </button>
          <button
            className="btn btn-sm"
            onClick={() => void deleteSelection()}
            disabled={toolbarDisabled || selection.size === 0}
            title="Delete selected (Del)"
          >
            🗑
          </button>
        </div>

        {error && (
          <div className="banner banner-danger pane-error">
            <span>{error}</span>
            <button className="btn btn-sm" onClick={pane.clearError}>
              ✕
            </button>
          </div>
        )}
      </div>

      <div
        ref={listRef}
        className="pane-list"
        tabIndex={0}
        onKeyDown={onListKeyDown}
        onMouseDown={(e) => {
          listRef.current?.focus()
          if (e.target === e.currentTarget) setSelection(new Set())
        }}
      >
        {!listing && <div className="pane-empty">{side === 'remote' && !enabled ? 'Connect to a server to browse remote files' : 'Loading…'}</div>}
        {listing && entries.length === 0 && <div className="pane-empty">This folder is empty</div>}
        {entries.map((entry, index) => (
          <div
            key={entry.name}
            className={`row ${selection.has(entry.name) ? 'row-selected' : ''}`}
            draggable={enabled}
            onClick={(e) => select(entry, index, e)}
            onDoubleClick={() => openEntry(entry)}
            onDragStart={(e) => onDragStart(e, entry)}
          >
            <span className="row-icon">{entryIcon(entry)}</span>
            <span className="row-name">{entry.name}</span>
            <span className="row-date">{formatDate(entry.mtime)}</span>
            <span className="row-size">{formatSize(entry.size, entry.isDir)}</span>
          </div>
        ))}
      </div>
      {dialogNode}
    </section>
  )
}
