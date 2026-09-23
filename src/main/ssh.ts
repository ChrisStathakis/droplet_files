import {
  Client,
  type ConnectConfig,
  type FileEntryWithStats,
  type HostVerifier,
  type SFTPWrapper,
  type Stats
} from 'ssh2'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, createWriteStream, opendirSync, promises as fsp } from 'fs'
import * as path from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { Store } from './store'
import type {
  ConnectInput,
  ConnectionStatus,
  DirEntry,
  DirListing,
  HostKeyRequest,
  Side,
  TransferUpdate
} from '../shared/types'

export interface SshEvents {
  status(status: ConnectionStatus): void
  hostKey(request: HostKeyRequest): void
  transfer(update: TransferUpdate): void
}

type Callback<T> = (err: Error | undefined, result: T) => void

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

const PROGRESS_INTERVAL_MS = 100

export class SshManager {
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private pendingHostKeys = new Map<string, (trusted: boolean) => void>()
  private lock: Promise<unknown> = Promise.resolve()
  private transferSeq = 0
  private status: ConnectionStatus = { state: 'disconnected' }

  constructor(private events: SshEvents) {}

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
    await this.disconnect()

    const label = `${input.username}@${input.host}:${input.port}`
    this.setStatus('connecting', label)

    let privateKey: Buffer
    try {
      privateKey = await fsp.readFile(input.keyPath)
    } catch (err) {
      this.setStatus('disconnected')
      throw new Error(`Cannot read private key file "${input.keyPath}": ${errmsg(err)}`)
    }

    const passphrase =
      input.passphrase ||
      (input.profileId ? Store.getPassphrase(input.profileId) : undefined) ||
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

    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          reject(err)
        }
        client.on('ready', () => {
          if (settled) return
          settled = true
          resolve()
        })
        client.on('error', (err) => {
          if (!settled) fail(err)
          else if (this.client === client) this.handleUnexpectedClose(errmsg(err))
        })
        const onClosed = (): void => {
          if (this.client !== client) return
          if (!settled) fail(new Error('Connection closed before reaching the server'))
          else this.handleUnexpectedClose()
        }
        client.on('close', onClosed)
        client.on('end', onClosed)
        this.client = client
        client.connect(config)
      })

      this.sftp = await promisify<SFTPWrapper>((cb) => client.sftp(cb))
      this.setStatus('connected', label)
    } catch (err) {
      if (this.client === client) {
        this.client = null
        this.sftp = null
      }
      try {
        client.end()
      } catch {
        /* already closed */
      }
      this.rejectPendingHostKeys()
      const message = errmsg(err)
      this.setStatus('disconnected')
      throw new Error(
        /host.*verif|host.*key/i.test(message)
          ? 'Host key verification failed — the server identity could not be confirmed'
          : message
      )
    }
  }

  async disconnect(): Promise<void> {
    this.rejectPendingHostKeys()
    const client = this.client
    this.client = null
    this.sftp = null
    if (client) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    if (this.status.state !== 'disconnected') this.setStatus('disconnected')
  }

  private handleUnexpectedClose(message?: string): void {
    this.client = null
    this.sftp = null
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

  // ----------------------------------------------------------------- filesystem

  private requireSftp(): SFTPWrapper {
    if (!this.isConnected() || !this.sftp) throw new Error('Not connected to a server')
    return this.sftp
  }

  async listRemote(dir: string): Promise<DirListing> {
    const sftp = this.requireSftp()
    const list = await promisify<FileEntryWithStats[]>((cb) => sftp.readdir(dir, cb))
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
      const dest = path.join(destDir, path.basename(src))
      await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false })
    }
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
    const sftp = this.requireSftp()
    return this.withLock(async () => {
      for (const src of localPaths) {
        const st = await fsp.lstat(src)
        const base = path.basename(src)
        const destName = await uniqueName(
          remoteDir,
          base,
          (d, n) => path.posix.join(d, n),
          (p) => sftpExists(sftp, p)
        )
        const dest = path.posix.join(remoteDir, destName)
        if (st.isDirectory()) await this.uploadDir(src, dest)
        else await this.uploadFile(src, dest, destName)
      }
    })
  }

  private async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    const sftp = this.requireSftp()
    try {
      await sftpCall((done) => sftp.mkdir(remoteDir, done))
    } catch (err) {
      // Ignore "already exists", rethrow anything else (e.g. permission denied)
      if (!(await sftpExists(sftp, remoteDir))) throw err
    }
    const dirents = await fsp.readdir(localDir, { withFileTypes: true })
    for (const d of dirents) {
      const full = path.join(localDir, d.name)
      const dest = path.posix.join(remoteDir, d.name)
      if (d.isDirectory()) await this.uploadDir(full, dest)
      else if (d.isFile()) await this.uploadFile(full, dest, d.name)
      // sockets/fifos/devices are skipped
    }
  }

  private async uploadFile(localPath: string, remotePath: string, name: string): Promise<void> {
    const sftp = this.requireSftp()
    const id = String(++this.transferSeq)
    let total = 0
    try {
      const st = await fsp.stat(localPath)
      total = st.size
      this.emitTransfer({ id, name, direction: 'up', state: 'queued', transferred: 0, total })
      this.emitTransfer({ id, name, direction: 'up', state: 'active', transferred: 0, total })

      const source = createReadStream(localPath)
      const counter = this.counter(id, name, 'up', total)
      const dest = sftp.createWriteStream(remotePath)
      await pipeline(source, counter, dest)
      this.emitTransfer({ id, name, direction: 'up', state: 'done', transferred: total, total })
    } catch (err) {
      this.emitTransfer({
        id,
        name,
        direction: 'up',
        state: 'error',
        transferred: 0,
        total,
        error: errmsg(err)
      })
    }
  }

  async download(remotePaths: string[], localDir: string): Promise<void> {
    const sftp = this.requireSftp()
    return this.withLock(async () => {
      for (const src of remotePaths) {
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
        const st = await promisify<Stats>((cb) => sftp.lstat(src, cb))
        if (st.isDirectory() && !st.isSymbolicLink()) await this.downloadDir(src, dest)
        else await this.downloadFile(src, dest, destName)
      }
    })
  }

  private async downloadDir(remoteDir: string, localDir: string): Promise<void> {
    const sftp = this.requireSftp()
    await fsp.mkdir(localDir, { recursive: true })
    const list = await promisify<FileEntryWithStats[]>((cb) => sftp.readdir(remoteDir, cb))
    for (const entry of list) {
      const src = path.posix.join(remoteDir, entry.filename)
      const dest = path.join(localDir, entry.filename)
      if (entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink()) {
        await this.downloadDir(src, dest)
      } else if (!entry.attrs.isSymbolicLink()) {
        await this.downloadFile(src, dest, entry.filename)
      }
    }
  }

  private async downloadFile(remotePath: string, localPath: string, name: string): Promise<void> {
    const sftp = this.requireSftp()
    const id = String(++this.transferSeq)
    let total = 0
    try {
      const st = await promisify<Stats>((cb) => sftp.stat(remotePath, cb))
      total = st.size
      this.emitTransfer({ id, name, direction: 'down', state: 'queued', transferred: 0, total })
      this.emitTransfer({ id, name, direction: 'down', state: 'active', transferred: 0, total })

      const source = sftp.createReadStream(remotePath)
      const counter = this.counter(id, name, 'down', total)
      const dest = createWriteStream(localPath)
      await pipeline(source, counter, dest)
      this.emitTransfer({ id, name, direction: 'down', state: 'done', transferred: total, total })
    } catch (err) {
      this.emitTransfer({
        id,
        name,
        direction: 'down',
        state: 'error',
        transferred: 0,
        total,
        error: errmsg(err)
      })
    }
  }

  private counter(
    id: string,
    name: string,
    direction: TransferUpdate['direction'],
    total: number
  ): Transform {
    let transferred = 0
    let lastEmit = 0
    return new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        transferred += chunk.length
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
