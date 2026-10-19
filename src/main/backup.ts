import { createHash, randomUUID } from 'crypto'
import { createReadStream, promises as fsp } from 'fs'
import * as path from 'path'
import type { SshManager } from './ssh'
import type {
  BackupCreateInput,
  BackupDirEntry,
  BackupFileEntry,
  BackupInspection,
  BackupManifest,
  BackupPhase,
  BackupProgress,
  BackupRestoreInput,
  BackupSkippedEntry,
  BackupSourceEntry,
  BackupSummary,
  RestoreResult
} from '../shared/types'

export interface BackupManagerOptions {
  ssh: SshManager
  appVersion: string
  events: {
    progress(update: BackupProgress): void
  }
}

interface ActiveJob {
  id: string
  controller: AbortController
}

interface PlannedFile {
  remotePath: string
  path: string
  size: number
  mtime: number
  mode: number
  sha256: string
}

interface PlannedDir {
  remotePath: string
  path: string
  mtime: number
  mode: number
}

interface BackupPlan {
  files: PlannedFile[]
  dirs: PlannedDir[]
  skipped: BackupSkippedEntry[]
  sources: BackupSourceEntry[]
  originalDir: string | null
}

const MANIFEST_FILE = 'backup-manifest.json'
const FILES_DIR = 'files'
const FORMAT = 'droplet-files-backup'
const VERSION = 1

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const INVALID_SEGMENT = /[\\/:*?"<>|\u0000-\u001f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return false
  }
  return value.split('/').every((segment) => {
    if (!segment || segment === '.' || segment === '..') return false
    if (INVALID_SEGMENT.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) {
      return false
    }
    if (process.platform === 'win32' && WINDOWS_RESERVED.test(segment)) return false
    return true
  })
}

function assertLocalSegment(name: string): void {
  if (!name || name === '.' || name === '..') {
    throw new Error(`Invalid file name in backup: "${name}"`)
  }
  if (INVALID_SEGMENT.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    throw new Error(
      `Cannot back up "${name}" — the name is not valid on this operating system`
    )
  }
  if (process.platform === 'win32' && WINDOWS_RESERVED.test(name)) {
    throw new Error(`Cannot back up "${name}" — the name is reserved on Windows`)
  }
}

function resolveInside(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new Error(`Invalid path in backup manifest: "${relative}"`)
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...relative.split('/'))
  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes the backup folder: "${relative}"`)
  }
  return resolved
}

function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation cancelled'))
      return
    }

    const hash = createHash('sha256')
    const stream = createReadStream(file)
    const onAbort = (): void => {
      stream.destroy(new Error('Operation cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

function validateManifest(value: unknown): BackupManifest {
  if (!isRecord(value)) throw new Error('Backup manifest is not an object')
  if (value.format !== FORMAT) throw new Error('Not a Droplet Files backup manifest')
  if (value.version !== VERSION) {
    throw new Error(`Unsupported backup format version: ${String(value.version)}`)
  }
  if (
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.appVersion !== 'string'
  ) {
    throw new Error('Backup manifest is missing metadata')
  }

  const connection = value.connection
  if (
    !isRecord(connection) ||
    typeof connection.host !== 'string' ||
    typeof connection.port !== 'number' ||
    !Number.isFinite(connection.port) ||
    connection.port <= 0 ||
    typeof connection.username !== 'string'
  ) {
    throw new Error('Backup manifest has an invalid connection section')
  }
  if (
    value.originalDir !== null &&
    (typeof value.originalDir !== 'string' || !path.posix.isAbsolute(value.originalDir))
  ) {
    throw new Error('Backup manifest has an invalid original directory')
  }

  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error('Backup manifest has no sources')
  }
  const sourceRoots = new Set<string>()
  const sources: BackupSourceEntry[] = value.sources.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.remotePath !== 'string' ||
      typeof entry.backupPath !== 'string' ||
      (entry.kind !== 'file' && entry.kind !== 'dir') ||
      !path.posix.isAbsolute(entry.remotePath) ||
      !isSafeRelativePath(entry.backupPath)
    ) {
      throw new Error('Backup manifest contains an invalid source')
    }
    if (sourceRoots.has(entry.backupPath)) {
      throw new Error(`Duplicate source in backup manifest: "${entry.backupPath}"`)
    }
    sourceRoots.add(entry.backupPath)
    return {
      remotePath: entry.remotePath,
      backupPath: entry.backupPath,
      kind: entry.kind
    }
  })

  const underSource = (relative: string): boolean =>
    sources.some(
      (source) =>
        relative === source.backupPath || relative.startsWith(`${source.backupPath}/`)
    )

  if (!Array.isArray(value.files)) throw new Error('Backup manifest has no file list')
  const files: BackupFileEntry[] = value.files.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !isSafeRelativePath(entry.path) ||
      typeof entry.size !== 'number' ||
      !Number.isFinite(entry.size) ||
      entry.size < 0 ||
      typeof entry.mtime !== 'number' ||
      !Number.isFinite(entry.mtime) ||
      typeof entry.mode !== 'number' ||
      !Number.isFinite(entry.mode) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256)
    ) {
      throw new Error('Backup manifest contains an invalid file entry')
    }
    if (!underSource(entry.path)) {
      throw new Error(`File is outside the backup sources: "${entry.path}"`)
    }
    return {
      path: entry.path,
      size: entry.size,
      mtime: entry.mtime,
      mode: entry.mode,
      sha256: entry.sha256.toLowerCase()
    }
  })

  if (!Array.isArray(value.dirs)) throw new Error('Backup manifest has no directory list')
  const dirs: BackupDirEntry[] = value.dirs.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !isSafeRelativePath(entry.path) ||
      typeof entry.mtime !== 'number' ||
      !Number.isFinite(entry.mtime) ||
      typeof entry.mode !== 'number' ||
      !Number.isFinite(entry.mode) ||
      !underSource(entry.path)
    ) {
      throw new Error('Backup manifest contains an invalid directory entry')
    }
    return { path: entry.path, mtime: entry.mtime, mode: entry.mode }
  })

  const skipped: BackupSkippedEntry[] = Array.isArray(value.skipped)
    ? value.skipped.map((entry) => {
        if (
          !isRecord(entry) ||
          typeof entry.remotePath !== 'string' ||
          (entry.reason !== 'symlink' && entry.reason !== 'special')
        ) {
          throw new Error('Backup manifest contains an invalid skipped entry')
        }
        return { remotePath: entry.remotePath, reason: entry.reason }
      })
    : []

  const totals = value.totals
  if (
    !isRecord(totals) ||
    typeof totals.files !== 'number' ||
    typeof totals.dirs !== 'number' ||
    typeof totals.bytes !== 'number'
  ) {
    throw new Error('Backup manifest has invalid totals')
  }

  const filePaths = new Set<string>()
  for (const file of files) {
    if (filePaths.has(file.path)) throw new Error(`Duplicate file in backup: "${file.path}"`)
    filePaths.add(file.path)
  }

  return {
    format: FORMAT,
    version: VERSION,
    createdAt: value.createdAt,
    appVersion: value.appVersion,
    connection: {
      host: connection.host,
      port: connection.port,
      username: connection.username
    },
    originalDir: value.originalDir,
    sources,
    files,
    dirs,
    skipped,
    totals: {
      files: totals.files,
      dirs: totals.dirs,
      bytes: totals.bytes
    }
  }
}

export class BackupManager {
  private active: ActiveJob | null = null

  constructor(private options: BackupManagerOptions) {}

  cancel(): void {
    this.active?.controller.abort()
  }

  /** True while a backup or restore is in progress */
  isBusy(): boolean {
    return this.active !== null
  }

  async create(input: BackupCreateInput): Promise<BackupSummary> {
    this.assertIdle()
    const job = this.begin()
    const signal = job.controller.signal
    let tempDir: string | null = null

    try {
      const connection = this.requireConnection()
      const generation = this.options.ssh.getConnectionGeneration()
      if (!path.isAbsolute(input.destination)) {
        throw new Error('Backup destination must be an absolute local path')
      }
      const destination = path.resolve(input.destination)
      const stat = await fsp.stat(destination).catch(() => null)
      if (!stat?.isDirectory()) throw new Error('Choose an existing folder for the backup')

      const name = input.name.trim()
      try {
        assertLocalSegment(name)
      } catch {
        throw new Error(
          'Backup name contains characters that are not valid on this operating system'
        )
      }

      const remotePaths = input.remotePaths.map((p) => path.posix.normalize(p.trim()))
      if (remotePaths.length === 0) throw new Error('Select at least one remote item to back up')
      for (const remotePath of remotePaths) {
        if (!path.posix.isAbsolute(remotePath)) {
          throw new Error(`Remote path must be absolute: "${remotePath}"`)
        }
        if (remotePath === '/') {
          throw new Error('Choose a folder inside / instead of backing up the whole server')
        }
      }

      this.emit(job.id, 'backup', 'scanning', {
        filesTotal: 0,
        filesDone: 0,
        bytesTotal: 0,
        bytesDone: 0,
        message: 'Scanning remote files…'
      })

      const plan = await this.plan(remotePaths, job.id, signal, generation)

      tempDir = path.join(destination, `.droplet-backup-${randomUUID()}`)
      const filesRoot = path.join(tempDir, FILES_DIR)
      await fsp.mkdir(filesRoot, { recursive: true })

      for (const dir of plan.dirs) {
        await fsp.mkdir(resolveInside(filesRoot, dir.path), { recursive: true })
      }

      let filesDone = 0
      let bytesDone = 0
      let bytesTotal = plan.files.reduce((sum, file) => sum + file.size, 0)

      this.emit(job.id, 'backup', 'downloading', {
        filesTotal: plan.files.length,
        filesDone,
        bytesTotal,
        bytesDone,
        message: 'Downloading backup…'
      })

      for (const file of plan.files) {
        this.throwIfCancelled(signal)
        const localPath = resolveInside(filesRoot, file.path)
        await fsp.mkdir(path.dirname(localPath), { recursive: true })
        const result = await this.options.ssh.downloadBackupFile(
          file.remotePath,
          localPath,
          signal,
          generation
        )

        if (result.size !== file.size) bytesTotal += result.size - file.size
        file.size = result.size
        file.mtime = result.mtime
        file.mode = result.mode & 0o7777
        file.sha256 = result.sha256
        await fsp.utimes(localPath, result.mtime, result.mtime).catch(() => undefined)
        filesDone++
        bytesDone += result.size

        this.emit(job.id, 'backup', 'downloading', {
          filesTotal: plan.files.length,
          filesDone,
          bytesTotal,
          bytesDone,
          currentPath: file.path
        })
      }

      // Set directory dates last so creating the files above doesn't overwrite them.
      for (const dir of [...plan.dirs].reverse()) {
        const localDir = resolveInside(filesRoot, dir.path)
        await fsp.utimes(localDir, dir.mtime, dir.mtime).catch(() => undefined)
      }

      this.throwIfCancelled(signal)
      this.emit(job.id, 'backup', 'finalizing', {
        filesTotal: plan.files.length,
        filesDone,
        bytesTotal,
        bytesDone,
        message: 'Writing manifest…'
      })

      const manifest: BackupManifest = {
        format: FORMAT,
        version: VERSION,
        createdAt: new Date().toISOString(),
        appVersion: this.options.appVersion,
        connection,
        originalDir: plan.originalDir,
        sources: plan.sources,
        files: plan.files.map((file) => ({
          path: file.path,
          size: file.size,
          mtime: file.mtime,
          mode: file.mode,
          sha256: file.sha256
        })),
        dirs: plan.dirs.map((dir) => ({
          path: dir.path,
          mtime: dir.mtime,
          mode: dir.mode
        })),
        skipped: plan.skipped,
        totals: {
          files: plan.files.length,
          dirs: plan.dirs.length,
          bytes: plan.files.reduce((sum, file) => sum + file.size, 0)
        }
      }

      await fsp.writeFile(
        path.join(tempDir, MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
        'utf8'
      )

      const finalDir = await this.finalize(tempDir, destination, name)
      tempDir = null

      this.emit(job.id, 'backup', 'done', {
        filesTotal: manifest.totals.files,
        filesDone: manifest.totals.files,
        bytesTotal: manifest.totals.bytes,
        bytesDone: manifest.totals.bytes,
        message: `Backup saved to ${finalDir}`
      })

      return { backupDir: finalDir, manifest }
    } catch (err) {
      if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      this.reportFailure(job.id, 'backup', signal, err)
      throw signal.aborted ? new Error('Backup cancelled') : err
    } finally {
      this.end(job.id)
    }
  }

  async inspect(backupDir: string): Promise<BackupInspection> {
    return this.loadInspection(backupDir)
  }

  async restore(input: BackupRestoreInput): Promise<RestoreResult> {
    this.assertIdle()
    const job = this.begin()
    const signal = job.controller.signal

    try {
      const connection = this.requireConnection()
      const generation = this.options.ssh.getConnectionGeneration()
      if (
        input.conflictPolicy !== 'skip' &&
        input.conflictPolicy !== 'overwrite' &&
        input.conflictPolicy !== 'keep-both'
      ) {
        throw new Error('Invalid conflict policy')
      }
      const inspection = await this.loadInspection(input.backupDir)
      const manifest = inspection.manifest

      const remoteDir = path.posix.normalize(input.remoteDir.trim())
      if (!path.posix.isAbsolute(remoteDir)) {
        throw new Error('Restore destination must be an absolute remote path')
      }

      const mismatch =
        connection.host !== manifest.connection.host ||
        connection.port !== manifest.connection.port ||
        connection.username !== manifest.connection.username
      if (mismatch && input.allowHostMismatch !== true) {
        throw new Error(
          'This backup was created on a different server. Confirm the destination before restoring.'
        )
      }

      const filesRoot = path.join(inspection.backupDir, FILES_DIR)
      const filesRootStat = await fsp.lstat(filesRoot).catch(() => null)
      if (!filesRootStat?.isDirectory() || filesRootStat.isSymbolicLink()) {
        throw new Error('The backup has no valid files/ directory')
      }
      const filesRootReal = await fsp.realpath(filesRoot)
      const verifyChecksums = input.verifyChecksums !== false

      const bytesTotal = manifest.files.reduce((sum, file) => sum + file.size, 0)
      let bytesDone = 0
      let filesDone = 0

      // Fail before touching the server if the local copy is incomplete or damaged.
      this.emit(job.id, 'restore', 'verifying', {
        filesTotal: manifest.files.length,
        filesDone: 0,
        bytesTotal,
        bytesDone: 0,
        message: 'Checking local backup…'
      })

      for (const file of manifest.files) {
        this.throwIfCancelled(signal)
        const localPath = resolveInside(filesRoot, file.path)
        const stat = await fsp.lstat(localPath).catch(() => null)
        if (!stat?.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Backup is incomplete — missing file: ${file.path}`)
        }
        if (stat.size !== file.size) {
          throw new Error(`Backup file has changed size: ${file.path}`)
        }
        const realPath = await fsp.realpath(localPath)
        if (!realPath.startsWith(filesRootReal + path.sep)) {
          throw new Error(`Backup file escapes its folder: ${file.path}`)
        }
        if (verifyChecksums) {
          const actual = await hashFile(localPath, signal)
          if (actual !== file.sha256) {
            throw new Error(`Checksum mismatch in backup file: ${file.path}`)
          }
        }

        filesDone++
        bytesDone += file.size
        this.emit(job.id, 'restore', 'verifying', {
          filesTotal: manifest.files.length,
          filesDone,
          bytesTotal,
          bytesDone,
          currentPath: file.path
        })
      }

      this.throwIfCancelled(signal)
      await this.options.ssh.mkdirpRemote(remoteDir, generation)

      const ensuredDirs = new Set<string>([remoteDir])
      const sortedDirs = [...manifest.dirs].sort(
        (a, b) => a.path.split('/').length - b.path.split('/').length
      )
      for (const dir of sortedDirs) {
        this.throwIfCancelled(signal)
        const targetDir = path.posix.join(remoteDir, dir.path)
        await this.options.ssh.mkdirpRemote(targetDir, generation)
        ensuredDirs.add(targetDir)
      }

      let restored = 0
      let skipped = 0
      let renamed = 0
      let failed = 0
      const failures: RestoreResult['failures'] = []
      filesDone = 0
      bytesDone = 0

      this.emit(job.id, 'restore', 'restoring', {
        filesTotal: manifest.files.length,
        filesDone,
        bytesTotal,
        bytesDone,
        message: 'Restoring files…'
      })

      for (const file of manifest.files) {
        this.throwIfCancelled(signal)
        const localPath = resolveInside(filesRoot, file.path)
        const target = path.posix.join(remoteDir, file.path)
        const targetDir = path.posix.dirname(target)

        try {
          if (!ensuredDirs.has(targetDir)) {
            await this.options.ssh.mkdirpRemote(targetDir, generation)
            ensuredDirs.add(targetDir)
          }
          const result = await this.options.ssh.uploadBackupFile(
            localPath,
            targetDir,
            path.posix.basename(target),
            {
              policy: input.conflictPolicy,
              sha256: verifyChecksums ? file.sha256 : undefined,
              mode: file.mode,
              mtime: file.mtime,
              signal,
              expectedGeneration: generation
            }
          )
          if (result.outcome === 'skipped') skipped++
          else if (result.outcome === 'renamed') renamed++
          else restored++
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (signal.aborted) throw err
          if (/connection changed|not connected/i.test(message)) throw err
          failed++
          failures.push({ path: file.path, error: message })
        }

        filesDone++
        bytesDone += file.size
        this.emit(job.id, 'restore', 'restoring', {
          filesTotal: manifest.files.length,
          filesDone,
          bytesTotal,
          bytesDone,
          currentPath: file.path,
          message: failed > 0 ? `${failed} file(s) failed` : undefined
        })
      }

      // Apply directory metadata last so the restored contents don't overwrite it.
      for (const dir of [...sortedDirs].reverse()) {
        try {
          await this.options.ssh.applyRemoteMetadata(
            path.posix.join(remoteDir, dir.path),
            dir.mode,
            dir.mtime,
            generation
          )
        } catch {
          /* best effort */
        }
      }

      const summary = `${restored} restored, ${skipped} skipped, ${renamed} renamed, ${failed} failed`
      this.emit(job.id, 'restore', 'done', {
        filesTotal: manifest.files.length,
        filesDone,
        bytesTotal,
        bytesDone,
        message: summary
      })

      return { restored, skipped, renamed, failed, failures }
    } catch (err) {
      this.reportFailure(job.id, 'restore', signal, err)
      throw signal.aborted ? new Error('Restore cancelled') : err
    } finally {
      this.end(job.id)
    }
  }

  // ---------------------------------------------------------------- internals

  private async plan(
    remotePaths: string[],
    operationId: string,
    signal: AbortSignal,
    generation: number
  ): Promise<BackupPlan> {
    const files: PlannedFile[] = []
    const dirs: PlannedDir[] = []
    const skipped: BackupSkippedEntry[] = []
    const sources: BackupSourceEntry[] = []
    const usedNames = new Set<string>()
    let bytes = 0
    let lastScanEmit = 0

    const emitScanProgress = (remotePath: string): void => {
      const now = Date.now()
      if (now - lastScanEmit < 100) return
      lastScanEmit = now
      this.emit(operationId, 'backup', 'scanning', {
        filesTotal: files.length,
        filesDone: 0,
        bytesTotal: bytes,
        bytesDone: 0,
        currentPath: remotePath
      })
    }

    const uniqueSourceName = (base: string): string => {
      if (!usedNames.has(base)) {
        usedNames.add(base)
        return base
      }
      let i = 1
      for (;;) {
        const candidate = `${base} (${i})`
        if (!usedNames.has(candidate)) {
          usedNames.add(candidate)
          return candidate
        }
        i++
      }
    }

    const visit = async (remotePath: string, relative: string): Promise<void> => {
      this.throwIfCancelled(signal)
      emitScanProgress(remotePath)

      const stat = await this.options.ssh.lstatRemote(remotePath, generation)
      if (stat.isSymlink) {
        skipped.push({ remotePath, reason: 'symlink' })
        return
      }
      if (stat.isDir) {
        assertLocalSegment(path.posix.basename(remotePath))
        dirs.push({
          remotePath,
          path: relative,
          mtime: stat.mtime,
          mode: stat.mode & 0o7777
        })
        const listing = await this.options.ssh.listRemote(remotePath, generation)
        for (const entry of listing.entries) {
          await visit(path.posix.join(remotePath, entry.name), `${relative}/${entry.name}`)
        }
        return
      }
      if (stat.isFile) {
        assertLocalSegment(path.posix.basename(remotePath))
        files.push({
          remotePath,
          path: relative,
          size: stat.size,
          mtime: stat.mtime,
          mode: stat.mode & 0o7777,
          sha256: ''
        })
        bytes += stat.size
        return
      }
      skipped.push({ remotePath, reason: 'special' })
    }

    for (const remotePath of remotePaths) {
      const base = path.posix.basename(remotePath)
      assertLocalSegment(base)
      const backupPath = uniqueSourceName(base)
      const stat = await this.options.ssh.lstatRemote(remotePath, generation)
      sources.push({
        remotePath,
        backupPath,
        kind: stat.isDir ? 'dir' : 'file'
      })
      await visit(remotePath, backupPath)
    }

    const parents = new Set(sources.map((source) => path.posix.dirname(source.remotePath)))
    const originalDir = parents.size === 1 ? [...parents][0] : null

    this.emit(operationId, 'backup', 'scanning', {
      filesTotal: files.length,
      filesDone: 0,
      bytesTotal: bytes,
      bytesDone: 0,
      message: `Found ${files.length} file(s)`
    })

    return { files, dirs, skipped, sources, originalDir }
  }

  private async finalize(tempDir: string, destination: string, name: string): Promise<string> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const candidate = path.join(destination, attempt === 0 ? name : `${name} (${attempt})`)
      if (await pathExists(candidate)) continue
      try {
        await fsp.rename(tempDir, candidate)
        return candidate
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM') continue
        throw err
      }
    }
    throw new Error('Could not find a free backup folder name')
  }

  private async loadInspection(backupDir: string): Promise<BackupInspection> {
    const resolved = path.resolve(backupDir)
    let raw: string
    try {
      raw = await fsp.readFile(path.join(resolved, MANIFEST_FILE), 'utf8')
    } catch {
      throw new Error(`Not a backup folder — ${MANIFEST_FILE} was not found`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Backup manifest is not valid JSON')
    }

    const manifest = validateManifest(parsed)
    const filesRoot = path.join(resolved, FILES_DIR)
    const stat = await fsp.lstat(filesRoot).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The backup has no valid files/ directory')
    }

    return { backupDir: resolved, manifest }
  }

  private begin(): ActiveJob {
    const job = { id: randomUUID(), controller: new AbortController() }
    this.active = job
    return job
  }

  private end(id: string): void {
    if (this.active?.id === id) this.active = null
  }

  private assertIdle(): void {
    if (this.active) throw new Error('A backup or restore is already running')
  }

  private requireConnection(): { host: string; port: number; username: string } {
    if (!this.options.ssh.isConnected()) throw new Error('Not connected to a server')
    const info = this.options.ssh.getConnectionInfo()
    if (!info) throw new Error('Not connected to a server')
    return info
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Operation cancelled')
  }

  private reportFailure(
    operationId: string,
    kind: BackupProgress['kind'],
    signal: AbortSignal,
    err: unknown
  ): void {
    const cancelled = signal.aborted
    this.emit(operationId, kind, cancelled ? 'cancelled' : 'error', {
      filesTotal: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      message: cancelled
        ? kind === 'backup'
          ? 'Backup cancelled'
          : 'Restore cancelled'
        : err instanceof Error
          ? err.message
          : String(err)
    })
  }

  private emit(
    operationId: string,
    kind: BackupProgress['kind'],
    phase: BackupPhase,
    patch: Omit<BackupProgress, 'operationId' | 'kind' | 'phase'>
  ): void {
    this.options.events.progress({ operationId, kind, phase, ...patch })
  }
}
