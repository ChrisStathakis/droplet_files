import type { Side } from '@shared/types'

export function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  const d = new Date(unixSeconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const monthDay = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  // Compact: omit the year unless the file is from a different year
  if (d.getFullYear() === new Date().getFullYear()) return `${monthDay} ${time}`
  return `${d.getFullYear()}-${monthDay} ${time}`
}

/** Strip Electron's "Error invoking remote method" prefix from IPC errors */
export function errorMessage(err: unknown): string {
  let msg: string
  if (err instanceof Error) msg = err.message
  else msg = String(err)
  return msg
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
}

export function joinLocal(cwd: string, name: string): string {
  if (!cwd) return name
  const sep = cwd.includes('\\') ? '\\' : '/'
  return cwd.endsWith('\\') || cwd.endsWith('/') ? cwd + name : cwd + sep + name
}

export function joinRemote(cwd: string, name: string): string {
  if (!cwd || cwd === '/') return `/${name}`.replace('//', '/')
  return cwd.endsWith('/') ? cwd + name : `${cwd}/${name}`
}

export function joinPath(side: Side, cwd: string, name: string): string {
  return side === 'local' ? joinLocal(cwd, name) : joinRemote(cwd, name)
}
