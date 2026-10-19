import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type FileEntryWithStats,
  type HostVerifier,
  type SFTPWrapper,
  type Stats
} from 'ssh2'
import { createHash, randomUUID } from 'crypto'
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  opendirSync,
  promises as fsp
} from 'fs'
import * as path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { Store } from './store'
import type {
  BackupConflictPolicy,
  BackupConnectionInfo,
  ConnectInput,
  ConnectionStatus,
  DirEntry,
  DirListing,
  HostKeyRequest,
  ShellClosedEvent,
  ShellOpenOptions,
  Side,
  TransferUpdate
} from '../shared/types'

export interface SshEvents {
  status(status: ConnectionStatus): void
  hostKey(request: HostKeyRequest): void
  transfer(update: TransferUpdate): void
  shellData(chunk: string): void
  shellClosed(event: ShellClosedEvent): void
}

type Callback<T> = (err: Error | undefined, result: T) => void

interface TransferSession {
  sftp: SFTPWrapper
  generation: number
}

export interface RemoteStatInfo {
  isDir: boolean
  isFile: boolean
  isSymlink: boolean
  size: number
  mtime: number
  mode: number
}

export interface BackupDownloadResult {
  size: number
  mtime: number
  mode: number
  sha256: string
}

export interface RestoreUploadOptions {
  policy: BackupConflictPolicy
  /** Expected SHA-256 of the local source, verified while uploading */
  sha256?: string
  mode?: number
  mtime?: number
  signal?: AbortSignal
  /** The SSH connection this restore is pinned to */
  expectedGeneration?: number
}

export interface RestoreUploadResult {
  outcome: 'restored' | 'skipped' | 'renamed'
  finalPath: string
}

function promisify<T>(fn: (cb: Callback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)))
  })
}

/** For ssh2 methods that use the result-less `Callback` (mkdir, unlink, ...) */
function sftpCall(fn: (done: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fn((err) => (err ? reject(err) : resolve()))
  })
}

function errmsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/** Append " (1)", " (2)", ... until the name is free */
async function uniqueName(
  dir: string,
  name: string,
  join: (d: string, n: string) => string,
  exists: (p: string) => Promise<boolean>
): Promise<string> {
  if (!(await exists(join(dir, name)))) return name
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let i = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `${stem} (${i})${ext}`
    if (!(await exists(join(dir, candidate)))) return candidate
    i++
  }
}

/** Whether a remote path exists — never rejects (stat fails with NO_SUCH_FILE otherwise) */
function sftpExists(sftp: SFTPWrapper, p: string): Promise<boolean> {
  return new Promise((resolve) => sftp.stat(p, (err) => resolve(!err)))
}

/** Like sftpExists, but does not follow symlinks (detects dangling links too) */
function sftpLexists(sftp: SFTPWrapper, p: string): Promise<boolean> {
  return new Promise((resolve) => sftp.lstat(p, (err) => resolve(!err)))
}

const PROGRESS_INTERVAL_MS = 100

export class SshManager {
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private connectionGeneration = 0
  private connectAbort: AbortController | null = null
  private shellStream: ClientChannel | null = null
  private pendingHostKeys = new Map<string, (trusted: boolean) => void>()
  private lock: Promise<unknown> = Promise.resolve()
  private transferSeq = 0
  private status: ConnectionStatus = { state: 'disconnected' }
  private connectionInfo: BackupConnectionInfo | null = null

  constructor(private events: SshEvents) {}

  getConnectionInfo(): BackupConnectionInfo | null {
    return this.connectionInfo
  }

  /** Bumped on every connect attempt; multi-file jobs pin themselves to one value. */
  getConnectionGeneration(): number {
    return this.connectionGeneration
  }

  private setStatus(state: ConnectionStatus['state'], message?: string): void {
    this.status = { state, message }
    this.events.status(this.status)
  }

  isConnected(): boolean {
    return this.status.state === 'connected' && this.sftp !== null
  }

  // ---------------------------------------------------------------- connection

  async connect(input: ConnectInput): Promise<void> {
    if (this.status.state === 'connecting') throw new Error('Connection already in progress')
    const label = `${input.username}@${input.host}:${input.port}`
    this.closeCurrentConnection()
    const generation = ++this.connectionGeneration
    const abort = new AbortController()
    this.connectAbort = abort
    this.setStatus('connecting', label)

    try {
      let privateKey: Buffer
      try {
        privateKey = await fsp.readFile(input.keyPath, { signal: abort.signal })
      } catch (err) {
        if (generation === this.connectionGeneration) {
          throw new Error(`Cannot read private key file "${input.keyPath}": ${errmsg(err)}`)
        }
        throw err
      }
      this.assertConnectionAttempt(generation)

      const passphrase =
        input.passphrase ||
        (input.rememberPassphrase && input.profileId
          ? Store.getPassphrase(input.profileId)
          : undefined) ||
        undefined

      if (input.profileId && input.rememberPassphrase && input.passphrase) {
        Store.rememberPassphrase(input.profileId, input.passphrase)
      }

      const hostVerifier: HostVerifier = (key, verify) => {
        void this.verifyHostKey(input, key, verify)
      }

      const config: ConnectConfig = {
        host: input.host,
        port: input.port,
        username: input.username,
        privateKey,
        passphrase,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        hostVerifier
      }

      const client = new Client()
      let settled = false

      await new Promise<void>((resolve, reject) => {
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          reject(err)
        }
        client.on('ready', () => {
          if (settled) return
          if (generation !== this.connectionGeneration || this.client !== client) {
            fail(new Error('Connection cancelled'))
            return
          }
          settled = true
          resolve()
        })
        client.on('error', (err) => {
          if (!settled) fail(err)
          else if (this.client === client) this.handleUnexpectedClose(errmsg(err))
        })
        const onClosed = (): void => {
          if (!settled) {
            fail(new Error('Connection closed before reaching the server'))
          } else if (generation === this.connectionGeneration && this.client === client) {
            this.handleUnexpectedClose()
          }
        }
        client.on('close', onClosed)
        client.on('end', onClosed)
        this.client = client
        client.connect(config)
      })

      const sftp = await promisify<SFTPWrapper>((cb) => client.sftp(cb))
      this.assertConnectionAttempt(generation)
      this.sftp = sftp
      this.connectAbort = null
      this.connectionInfo = {
        host: input.host,
        port: input.port,
        username: input.username
      }
      this.setStatus('connected', label)
    } catch (err) {
      if (generation === this.connectionGeneration) {
        this.connectAbort = null
        this.closeCurrentConnection()
        this.setStatus('disconnected')
        this.rejectPendingHostKeys()
      }
      const message = errmsg(err)
      throw new Error(
        /host.*verif|host.*key/i.test(message)
          ? 'Host key verification failed — the server identity could not be confirmed'
          : message
      )
    }
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration++
    this.connectAbort?.abort()
    this.connectAbort = null
    this.closeCurrentConnection()
    if (this.status.state !== 'disconnected') this.setStatus('disconnected')
  }

  private closeCurrentConnection(): void {
    this.rejectPendingHostKeys()
    this.endShell()
    const client = this.client
    this.client = null
    this.sftp = null
    this.connectionInfo = null
    if (client) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
  }

  private assertConnectionAttempt(generation: number): void {
    if (generation !== this.connectionGeneration) throw new Error('Connection cancelled')
  }

  private handleUnexpectedClose(message?: string): void {
    this.client = null
    this.sftp = null
    this.connectionInfo = null
    this.endShell(message)
    this.rejectPendingHostKeys()
    this.setStatus('disconnected', message || undefined)
  }

  private rejectPendingHostKeys(): void {
    for (const resolve of this.pendingHostKeys.values()) resolve(false)
    this.pendingHostKeys.clear()
  }

  respondHostKey(requestId: string, trusted: boolean): void {
    const resolve = this.pendingHostKeys.get(requestId)
    if (!resolve) return
    this.pendingHostKeys.delete(requestId)
    resolve(trusted)
  }

  private async verifyHostKey(
    input: ConnectInput,
    rawKey: Buffer,
    verify: (valid: boolean) => void
  ): Promise<void> {
    let done = false
    const finish = (valid: boolean): void => {
      if (done) return
      done = true
      verify(valid)
    }

    const fingerprint =
      'SHA256:' + createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')
    const hostPort = `${input.host}:${input.port}`
    const trusted = Store.getTrustedFingerprint(hostPort)

    if (trusted === fingerprint) return finish(true)

    // Unknown (or changed) host key — ask the user
    const requestId = randomUUID()
    const answer = await new Promise<boolean>((resolve) => {
      this.pendingHostKeys.set(requestId, resolve)
      this.events.hostKey({
        requestId,
        host: input.host,
        port: input.port,
        fingerprint,
        changed: trusted !== undefined
      })
      setTimeout(() => {
        if (this.pendingHostKeys.delete(requestId)) resolve(false)
      }, 120000)
    })

    if (answer) Store.setTrustedFingerprint(hostPort, fingerprint)
    finish(answer)
  }

  // ---------------------------------------------------------------------- shell

  /**
   * Opens an interactive shell (PTY) on the existing connection.
   * Any previous session is replaced silently — only the new stream emits events.
   */
  async openShell(options: ShellOpenOptions): Promise<void> {
    const client = this.client
    const generation = this.connectionGeneration
    if (!client || this.status.state !== 'connected') {
      throw new Error('Not connected to a server')
    }
    this.endShell(undefined, true)

    const stream = await promisify<ClientChannel>((cb) =>
      client.shell(
        {
          term: 'xterm-256color',
          cols: Math.max(2, Math.floor(options.cols)),
          rows: Math.max(1, Math.floor(options.rows))
        },
        cb
      )
    )

    if (generation !== this.connectionGeneration || this.client !== client) {
      stream.destroy()
      throw new Error('Connection changed while opening the shell')
    }

    this.shellStream = stream
    stream.setEncoding('utf8')
    stream.stderr.setEncoding('utf8')

    // All handlers are guarded so a stream we already replaced stays silent
    stream.on('data', (chunk: string) => {
      if (this.shellStream === stream) this.events.shellData(chunk)
    })
    stream.stderr.on('data', (chunk: string) => {
      if (this.shellStream === stream) this.events.shellData(chunk)
    })
    const finish = (reason?: string): void => {
      if (this.shellStream !== stream) return
      this.shellStream = null
      this.events.shellClosed({ reason })
    }
    stream.on('error', (err: Error) => finish(err.message))
    stream.on('close', () => finish())
  }

  /** Sends keystrokes to the shell; ignored when no session is open */
  writeShell(data: string): void {
    const stream = this.shellStream
    if (!stream) return
    stream.write(data)
  }

  /** Tells the remote PTY about a terminal resize; ignored when no session is open */
  resizeShell(cols: number, rows: number): void {
    const stream = this.shellStream
    if (!stream) return
    // ssh2 takes (rows, cols, pixelHeight, pixelWidth); 0 pixel size = unknown
    stream.setWindow(Math.max(1, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0)
  }

  closeShell(): void {
    this.endShell()
  }

  /** Ends the shell channel; `silent` skips the shellClosed event (session swap) */
  private endShell(reason?: string, silent = false): void {
    const stream = this.shellStream
    if (!stream) return
    this.shellStream = null
    try {
      stream.destroy()
    } catch {
      /* already closed */
    }
    if (!silent) this.events.shellClosed({ reason })
  }

  // ----------------------------------------------------------------- filesystem

  private requireSftp(): SFTPWrapper {
    if (!this.isConnected() || !this.sftp) throw new Error('Not connected to a server')
    return this.sftp
  }

  private captureTransferSession(): TransferSession {
    return { sftp: this.requireSftp(), generation: this.connectionGeneration }
  }

  private assertTransferSession(session: TransferSession): void {
    if (
      session.generation !== this.connectionGeneration ||
      this.sftp !== session.sftp ||
      !this.isConnected()
    ) {
      throw new Error('Connection changed during transfer; the transfer was stopped')
    }
  }

  private isCurrentTransferSession(session: TransferSession): boolean {
    return (
      session.generation === this.connectionGeneration &&
      this.sftp === session.sftp &&
      this.isConnected()
    )
  }

  private assertGeneration(expected: number | undefined, message: string): void {
    if (expected !== undefined && expected !== this.connectionGeneration) {
      throw new Error(message)
    }
  }

  async listRemote(dir: string, expectedGeneration?: number): Promise<DirListing> {
    this.assertGeneration(
      expectedGeneration,
      'Connection changed while reading the server; the operation was stopped'
    )
    const session = this.captureTransferSession()
    const list = await promisify<FileEntryWithStats[]>((cb) => session.sftp.readdir(dir, cb))
    this.assertTransferSession(session)
    const entries: DirEntry[] = list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({
        name: e.filename,
        isDir: e.attrs.isDirectory(),
        size: e.attrs.size,
        mtime: e.attrs.mtime,
        isSymlink: e.attrs.isSymbolicLink()
      }))
    entries.sort(compareEntries)
    return {
      path: dir,
      parent: dir === '/' ? null : path.posix.dirname(dir) || '/',
      entries
    }
  }

  async listLocal(dir: string): Promise<DirListing> {
    let dirents
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Folder not found: ${dir}`)
      }
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new Error(`Access denied: ${dir}`)
      }
      throw err
    }
    const entries = await Promise.all(
      dirents.map(async (d): Promise<DirEntry> => {
        const full = path.join(dir, d.name)
        let isDir = d.isDirectory()
        let size = 0
        let mtime = 0
        try {
          const st = await fsp.stat(full)
          isDir = st.isDirectory()
          size = st.size
          mtime = Math.floor(st.mtimeMs / 1000)
        } catch {
          /* broken symlink or permission issue — keep defaults */
        }
        return { name: d.name, isDir, size, mtime, isSymlink: d.isSymbolicLink() }
      })
    )
    entries.sort(compareEntries)
    const parent = path.dirname(dir)
    return {
      path: dir,
      parent: parent === dir ? null : parent,
      entries
    }
  }

  localHome(): string {
    return process.env.USERPROFILE || process.env.HOME || process.cwd()
  }

  localRoots(): string[] {
    if (process.platform === 'win32') {
      const roots: string[] = []
      for (let i = 65; i <= 90; i++) {
        const drive = `${String.fromCharCode(i)}:\\`
        // opendirSync (unlike existsSync) fails for drives with no media,
        // e.g. empty optical drives, so only readable drives are listed
        try {
          const dir = opendirSync(drive)
          dir.closeSync()
          roots.push(drive)
        } catch {
          /* not ready or not present */
        }
      }
      return roots
    }
    return ['/']
  }

  async remoteHome(): Promise<string> {
    const sftp = this.requireSftp()
    return promisify<string>((cb) => sftp.realpath('.', cb))
  }

  async mkdir(side: Side, dir: string): Promise<void> {
    if (side === 'local') {
      await fsp.mkdir(dir)
      return
    }
    const sftp = this.requireSftp()
    await sftpCall((done) => sftp.mkdir(dir, done))
  }

  async rename(side: Side, from: string, to: string): Promise<void> {
    if (side === 'local') {
      await fsp.rename(from, to)
      return
    }
    const sftp = this.requireSftp()
    await sftpCall((done) => sftp.rename(from, to, done))
  }

  async remove(side: Side, target: string): Promise<void> {
    if (side === 'local') {
      const st = await fsp.lstat(target)
      if (st.isDirectory() && !st.isSymbolicLink()) await fsp.rm(target, { recursive: true })
      else await fsp.unlink(target)
      return
    }
    await this.remoteRemove(this.requireSftp(), target)
  }

  private async remoteRemove(sftp: SFTPWrapper, target: string): Promise<void> {
    const st = await promisify<Stats>((cb) => sftp.lstat(target, cb))
    if (st.isDirectory() && !st.isSymbolicLink()) {
      const list = await promisify<FileEntryWithStats[]>((cb) => sftp.readdir(target, cb))
      for (const entry of list) {
        await this.remoteRemove(sftp, path.posix.join(target, entry.filename))
      }
      await sftpCall((done) => sftp.rmdir(target, done))
    } else {
      await sftpCall((done) => sftp.unlink(target, done))
    }
  }

  async copyLocal(sources: string[], destDir: string): Promise<void> {
    for (const src of sources) {
      const base = path.basename(src)
      for (;;) {
        const name = await uniqueName(
          destDir,
          base,
          (dir, entry) => path.join(dir, entry),
          async (candidate) => {
            try {
              await fsp.lstat(candidate)
              return true
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
              throw err
            }
          }
        )
        try {
          await fsp.cp(src, path.join(destDir, name), {
            recursive: true,
            force: false,
            errorOnExist: true
          })
          break
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'EEXIST' && code !== 'ERR_FS_CP_EEXIST') throw err
        }
      }
    }
  }

  // ------------------------------------------------------------------ backups

  async lstatRemote(target: string, expectedGeneration?: number): Promise<RemoteStatInfo> {
    this.assertGeneration(
      expectedGeneration,
      'Connection changed while reading the server; the operation was stopped'
    )
    const session = this.captureTransferSession()
    const st = await promisify<Stats>((cb) => session.sftp.lstat(target, cb))
    this.assertTransferSession(session)
    return {
      isDir: st.isDirectory(),
      isFile: st.isFile(),
      isSymlink: st.isSymbolicLink(),
      size: st.size,
      mtime: st.mtime,
      mode: st.mode
    }
  }

  /** Creates a remote directory and any missing parents (like `mkdir -p`) */
  async mkdirpRemote(dir: string, expectedGeneration?: number): Promise<void> {
    this.assertGeneration(
      expectedGeneration,
      'Connection changed during restore; the restore was stopped'
    )
    const sftp = this.requireSftp()
    const normalized = path.posix.normalize(dir)
    let current = normalized.startsWith('/') ? '/' : ''

    for (const segment of normalized.split('/')) {
      if (!segment || segment === '.') continue
      this.assertGeneration(
        expectedGeneration,
        'Connection changed during restore; the restore was stopped'
      )
      current = current === '' ? segment : current === '/' ? `/${segment}` : `${current}/${segment}`

      if (await sftpExists(sftp, current)) {
        // stat (not lstat) so a symlink pointing at a directory is accepted.
        const st = await promisify<Stats>((cb) => sftp.stat(current, cb))
        if (!st.isDirectory()) throw new Error(`Not a directory: ${current}`)
        continue
      }
      try {
        await sftpCall((done) => sftp.mkdir(current, done))
      } catch (err) {
        // Another client may have created it between the check and the mkdir.
        const st = await promisify<Stats>((cb) => sftp.stat(current, cb)).catch(() => null)
        if (!st?.isDirectory()) throw err
      }
    }
  }

  /** Best-effort chmod/utimes used by restore; metadata failures are ignored */
  async applyRemoteMetadata(
    target: string,
    mode?: number,
    mtime?: number,
    expectedGeneration?: number
  ): Promise<void> {
    this.assertGeneration(
      expectedGeneration,
      'Connection changed during restore; the restore was stopped'
    )
    const sftp = this.requireSftp()
    await this.applyMetadata(sftp, target, mode, mtime)
  }

  private async applyMetadata(
    sftp: SFTPWrapper,
    target: string,
    mode?: number,
    mtime?: number
  ): Promise<void> {
    if (mode !== undefined) {
      await sftpCall((done) => sftp.chmod(target, mode & 0o7777, done)).catch(() => undefined)
    }
    if (mtime !== undefined) {
      await sftpCall((done) => sftp.utimes(target, mtime, mtime, done)).catch(() => undefined)
    }
  }

  /** Exact-path recursive file download used by backups (no collision suffixing) */
  async downloadBackupFile(
    remotePath: string,
    localPath: string,
    signal?: AbortSignal,
    expectedGeneration?: number
  ): Promise<BackupDownloadResult> {
    this.assertGeneration(
      expectedGeneration,
      'Connection changed during backup; the backup was stopped'
    )
    const session = this.captureTransferSession()
    return this.withLock(async () => {
      this.assertTransferSession(session)
      this.assertGeneration(
        expectedGeneration,
        'Connection changed during backup; the backup was stopped'
      )
      const id = String(++this.transferSeq)
      const name = path.posix.basename(remotePath)
      let total = 0
      let transferred = 0

      try {
        const st = await promisify<Stats>((cb) => session.sftp.lstat(remotePath, cb))
        if (!st.isFile()) throw new Error(`Not a regular file: ${remotePath}`)
        total = st.size
        this.emitTransfer({ id, name, direction: 'down', state: 'queued', transferred: 0, total })
        this.emitTransfer({ id, name, direction: 'down', state: 'active', transferred: 0, total })

        const hash = createHash('sha256')
        const hasher = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            hash.update(chunk)
            cb(null, chunk)
          }
        })
        const source = session.sftp.createReadStream(remotePath)
        const counter = this.counter(id, name, 'down', total, (count) => (transferred = count))
        const dest = createWriteStream(localPath, { flags: 'wx' })
        await pipeline(source, hasher, counter, dest, { signal })

        this.emitTransfer({
          id,
          name,
          direction: 'down',
          state: 'done',
          transferred,
          total: transferred
        })
        return {
          size: transferred,
          mtime: st.mtime,
          mode: st.mode,
          sha256: hash.digest('hex')
        }
      } catch (err) {
        const message = signal?.aborted ? 'Backup cancelled' : errmsg(err)
        this.emitTransfer({
          id,
          name,
          direction: 'down',
          state: 'error',
          transferred,
          total,
          error: message
        })
        throw err
      }
    })
  }

  /** Uploads one restored file with the requested conflict policy */
  async uploadBackupFile(
    localPath: string,
    remoteDir: string,
    name: string,
    options: RestoreUploadOptions
  ): Promise<RestoreUploadResult> {
    this.assertGeneration(
      options.expectedGeneration,
      'Connection changed during restore; the restore was stopped'
    )
    const session = this.captureTransferSession()
    return this.withLock(async () => {
      this.assertTransferSession(session)
      this.assertGeneration(
        options.expectedGeneration,
        'Connection changed during restore; the restore was stopped'
      )
      const sftp = session.sftp
      const originalTarget = path.posix.join(remoteDir, name)
      const exists = await sftpLexists(sftp, originalTarget)

      if (exists && options.policy === 'skip') {
        return { outcome: 'skipped', finalPath: originalTarget }
      }

      let target = originalTarget
      let renamed = false
      if (exists && options.policy === 'keep-both') {
        const unique = await uniqueName(
          remoteDir,
          name,
          (d, n) => path.posix.join(d, n),
          (p) => sftpLexists(sftp, p)
        )
        target = path.posix.join(remoteDir, unique)
        renamed = unique !== name
      } else if (exists && options.policy === 'overwrite') {
        const st = await promisify<Stats>((cb) => sftp.lstat(originalTarget, cb))
        if (st.isDirectory()) {
          throw new Error(`Cannot overwrite directory with a file: ${originalTarget}`)
        }
      }

      const id = String(++this.transferSeq)
      let total = 0
      let transferred = 0
      let tempPath: string | null = null
      let previousPath: string | null = null

      try {
        const st = await fsp.lstat(localPath)
        if (!st.isFile() || st.isSymbolicLink()) {
          throw new Error(`Not a regular file: ${localPath}`)
        }
        total = st.size
        this.emitTransfer({ id, name, direction: 'up', state: 'queued', transferred: 0, total })
        this.emitTransfer({ id, name, direction: 'up', state: 'active', transferred: 0, total })

        tempPath = path.posix.join(remoteDir, `.droplet-${randomUUID()}.part`)
        const hash = createHash('sha256')
        const hasher = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            hash.update(chunk)
            cb(null, chunk)
          }
        })
        const source = createReadStream(localPath)
        const counter = this.counter(id, name, 'up', total, (count) => (transferred = count))
        const dest = sftp.createWriteStream(tempPath, { flags: 'wx' })
        await pipeline(source, hasher, counter, dest, { signal: options.signal })

        if (options.sha256 && hash.digest('hex') !== options.sha256) {
          throw new Error(`Checksum mismatch for ${name}`)
        }

        this.assertTransferSession(session)
        if (exists && options.policy === 'overwrite') {
          // Move the old file aside first so a failed rename cannot lose it.
          previousPath = path.posix.join(remoteDir, `.droplet-old-${randomUUID()}.part`)
          await sftpCall((done) => sftp.rename(originalTarget, previousPath!, done))
        }
        await sftpCall((done) => sftp.rename(tempPath!, target, done))
        tempPath = null
        if (previousPath) {
          await sftpCall((done) => sftp.unlink(previousPath!, done)).catch(() => undefined)
          previousPath = null
        }
        await this.applyMetadata(sftp, target, options.mode, options.mtime)
        this.emitTransfer({ id, name, direction: 'up', state: 'done', transferred: total, total })
        return {
          outcome: renamed ? 'renamed' : 'restored',
          finalPath: target
        }
      } catch (err) {
        const message = options.signal?.aborted ? 'Restore cancelled' : errmsg(err)
        if (previousPath && this.isCurrentTransferSession(session)) {
          try {
            // If the new file never made it into place, put the old one back.
            if (!(await sftpExists(sftp, target))) {
              await sftpCall((done) => sftp.rename(previousPath!, target, done))
              previousPath = null
            }
          } catch {
            /* leave the old file at its temporary path rather than deleting it */
          }
        }
        if (tempPath && this.isCurrentTransferSession(session)) {
          await sftpCall((done) => sftp.unlink(tempPath!, done)).catch(() => undefined)
        }
        this.emitTransfer({
          id,
          name,
          direction: 'up',
          state: 'error',
          transferred,
          total,
          error: message
        })
        throw err
      }
    })
  }

  // ----------------------------------------------------------------- transfers

  /** Runs jobs one at a time so transfers don't interleave */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(() => fn())
    this.lock = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async upload(localPaths: string[], remoteDir: string): Promise<void> {
    const session = this.captureTransferSession()
    return this.withLock(async () => {
      this.assertTransferSession(session)
      for (const src of localPaths) {
        this.assertTransferSession(session)
        const st = await fsp.lstat(src)
        const base = path.basename(src)
        const destName = await uniqueName(
          remoteDir,
          base,
          (d, n) => path.posix.join(d, n),
          (p) => sftpExists(session.sftp, p)
        )
        const dest = path.posix.join(remoteDir, destName)
        if (st.isDirectory()) await this.uploadDir(session, src, dest)
        else await this.uploadFile(session, src, dest, destName)
      }
    })
  }

  private async uploadDir(
    session: TransferSession,
    localDir: string,
    remoteDir: string
  ): Promise<void> {
    this.assertTransferSession(session)
    await sftpCall((done) => session.sftp.mkdir(remoteDir, done))
    const dirents = await fsp.readdir(localDir, { withFileTypes: true })
    for (const d of dirents) {
      this.assertTransferSession(session)
      const full = path.join(localDir, d.name)
      const dest = path.posix.join(remoteDir, d.name)
      if (d.isDirectory()) await this.uploadDir(session, full, dest)
      else if (d.isFile()) await this.uploadFile(session, full, dest, d.name)
      // sockets/fifos/devices are skipped
    }
  }

  private async uploadFile(
    session: TransferSession,
    localPath: string,
    remotePath: string,
    name: string
  ): Promise<void> {
    const id = String(++this.transferSeq)
    let total = 0
    let transferred = 0
    let tempPath: string | null = null
    try {
      this.assertTransferSession(session)
      const st = await fsp.stat(localPath)
      total = st.size
      this.emitTransfer({ id, name, direction: 'up', state: 'queued', transferred: 0, total })
      this.emitTransfer({ id, name, direction: 'up', state: 'active', transferred: 0, total })

      tempPath = path.posix.join(
        path.posix.dirname(remotePath),
        `.droplet-${randomUUID()}.part`
      )
      const source = createReadStream(localPath)
      const counter = this.counter(id, name, 'up', total, (count) => (transferred = count))
      const dest = session.sftp.createWriteStream(tempPath, { flags: 'wx' })
      await pipeline(source, counter, dest)
      this.assertTransferSession(session)
      if (await sftpExists(session.sftp, remotePath)) {
        throw new Error(`Destination already exists: ${remotePath}`)
      }
      await sftpCall((done) => session.sftp.rename(tempPath!, remotePath, done))
      tempPath = null
      this.emitTransfer({ id, name, direction: 'up', state: 'done', transferred: total, total })
    } catch (err) {
      let message = errmsg(err)
      if (tempPath && this.isCurrentTransferSession(session)) {
        try {
          await sftpCall((done) => session.sftp.unlink(tempPath!, done))
          tempPath = null
        } catch {
          message += ` (partial remote file may remain at ${tempPath})`
        }
      } else if (tempPath) {
        message += ` (partial remote file may remain at ${tempPath})`
      }
      this.emitTransfer({
        id,
        name,
        direction: 'up',
        state: 'error',
        transferred,
        total,
        error: message
      })
    }
  }

  async download(remotePaths: string[], localDir: string): Promise<void> {
    const session = this.captureTransferSession()
    return this.withLock(async () => {
      this.assertTransferSession(session)
      for (const src of remotePaths) {
        this.assertTransferSession(session)
        const base = path.posix.basename(src)
        const destName = await uniqueName(
          localDir,
          base,
          (d, n) => path.join(d, n),
          (p) => fsp
            .access(p)
            .then(() => true)
            .catch(() => false)
        )
        const dest = path.join(localDir, destName)
        const st = await promisify<Stats>((cb) => session.sftp.lstat(src, cb))
        if (st.isDirectory() && !st.isSymbolicLink()) await this.downloadDir(session, src, dest)
        else await this.downloadFile(session, src, dest, destName)
      }
    })
  }

  private async downloadDir(
    session: TransferSession,
    remoteDir: string,
    localDir: string
  ): Promise<void> {
    this.assertTransferSession(session)
    await fsp.mkdir(localDir, { recursive: true })
    const list = await promisify<FileEntryWithStats[]>((cb) =>
      session.sftp.readdir(remoteDir, cb)
    )
    for (const entry of list) {
      this.assertTransferSession(session)
      const src = path.posix.join(remoteDir, entry.filename)
      const dest = path.join(localDir, entry.filename)
      if (entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink()) {
        await this.downloadDir(session, src, dest)
      } else if (!entry.attrs.isSymbolicLink()) {
        await this.downloadFile(session, src, dest, entry.filename)
      }
    }
  }

  private async downloadFile(
    session: TransferSession,
    remotePath: string,
    localPath: string,
    name: string
  ): Promise<void> {
    const id = String(++this.transferSeq)
    let total = 0
    let transferred = 0
    const tempPath = path.join(path.dirname(localPath), `.droplet-${randomUUID()}.part`)
    let tempExists = false
    try {
      this.assertTransferSession(session)
      const st = await promisify<Stats>((cb) => session.sftp.stat(remotePath, cb))
      total = st.size
      this.emitTransfer({ id, name, direction: 'down', state: 'queued', transferred: 0, total })
      this.emitTransfer({ id, name, direction: 'down', state: 'active', transferred: 0, total })

      const source = session.sftp.createReadStream(remotePath)
      const counter = this.counter(id, name, 'down', total, (count) => (transferred = count))
      const dest = createWriteStream(tempPath, { flags: 'wx' })
      tempExists = true
      await pipeline(source, counter, dest)
      this.assertTransferSession(session)
      await fsp.copyFile(tempPath, localPath, fsConstants.COPYFILE_EXCL)
      await fsp.rm(tempPath, { force: true })
      tempExists = false
      this.emitTransfer({ id, name, direction: 'down', state: 'done', transferred: total, total })
    } catch (err) {
      if (tempExists) await fsp.rm(tempPath, { force: true }).catch(() => undefined)
      this.emitTransfer({
        id,
        name,
        direction: 'down',
        state: 'error',
        transferred,
        total,
        error: errmsg(err)
      })
    }
  }

  private counter(
    id: string,
    name: string,
    direction: TransferUpdate['direction'],
    total: number,
    onProgress: (transferred: number) => void
  ): Transform {
    let transferred = 0
    let lastEmit = 0
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        transferred += chunk.length
        onProgress(transferred)
        const now = Date.now()
        if (now - lastEmit >= PROGRESS_INTERVAL_MS || transferred >= total) {
          lastEmit = now
          this.emitTransfer({ id, name, direction, state: 'active', transferred, total })
        }
        cb(null, chunk)
      }
    })
  }

  private emitTransfer(update: TransferUpdate): void {
    this.events.transfer(update)
  }
}
