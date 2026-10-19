export type Side = 'local' | 'remote'

export interface DirEntry {
  name: string
  isDir: boolean
  size: number
  /** Modified time in seconds since epoch */
  mtime: number
  isSymlink: boolean
}

export interface DirListing {
  path: string
  /** Parent directory path, or null when already at the root */
  parent: string | null
  entries: DirEntry[]
}

export interface Profile {
  id: string
  label: string
  host: string
  port: number
  username: string
  keyPath: string
  rememberPassphrase: boolean
}

export interface ConnectInput {
  host: string
  port: number
  username: string
  keyPath: string
  passphrase?: string
  rememberPassphrase: boolean
  /** When set, a remembered passphrase for this profile is used as a fallback */
  profileId?: string
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface ConnectionStatus {
  state: ConnectionState
  /** Human-readable message, e.g. an error or the connected address */
  message?: string
}

export interface HostKeyRequest {
  requestId: string
  host: string
  port: number
  /** OpenSSH-style fingerprint, e.g. "SHA256:abc..." */
  fingerprint: string
  /** True when we already trust a *different* key for this host (possible MITM) */
  changed: boolean
}

export type TransferState = 'queued' | 'active' | 'done' | 'error'

export interface TransferUpdate {
  id: string
  /** Base name of the file being transferred */
  name: string
  direction: 'up' | 'down'
  state: TransferState
  transferred: number
  total: number
  error?: string
}

export interface ShellOpenOptions {
  /** Terminal width in columns */
  cols: number
  /** Terminal height in rows */
  rows: number
}

export interface ShellClosedEvent {
  /** Human-readable reason; undefined for a clean close */
  reason?: string
}

// ------------------------------------------------------------------- backups

export interface BackupConnectionInfo {
  host: string
  port: number
  username: string
}

export interface BackupSourceEntry {
  /** Absolute remote path that was backed up */
  remotePath: string
  /** Relative path of the source root under the backup's files/ directory */
  backupPath: string
  kind: 'file' | 'dir'
}

export interface BackupFileEntry {
  /** Relative path under the backup's files/ directory, using / separators */
  path: string
  size: number
  mtime: number
  mode: number
  sha256: string
}

export interface BackupDirEntry {
  /** Relative path under the backup's files/ directory, using / separators */
  path: string
  mtime: number
  mode: number
}

export interface BackupSkippedEntry {
  remotePath: string
  reason: 'symlink' | 'special'
}

export interface BackupManifest {
  format: 'droplet-files-backup'
  version: 1
  createdAt: string
  appVersion: string
  connection: BackupConnectionInfo
  /** Common parent of the sources, used as the default restore destination */
  originalDir: string | null
  sources: BackupSourceEntry[]
  files: BackupFileEntry[]
  dirs: BackupDirEntry[]
  skipped: BackupSkippedEntry[]
  totals: { files: number; dirs: number; bytes: number }
}

export interface BackupCreateInput {
  /** Absolute remote paths selected in the remote pane */
  remotePaths: string[]
  /** Local parent directory that will contain the backup folder */
  destination: string
  /** Name of the backup folder */
  name: string
}

export interface BackupSummary {
  backupDir: string
  manifest: BackupManifest
}

export interface BackupInspection {
  backupDir: string
  manifest: BackupManifest
}

export type BackupConflictPolicy = 'skip' | 'overwrite' | 'keep-both'

export interface BackupRestoreInput {
  backupDir: string
  /** Absolute remote directory that will receive the restored files */
  remoteDir: string
  conflictPolicy: BackupConflictPolicy
  verifyChecksums: boolean
  /** Set once the user has acknowledged restoring to a different server */
  allowHostMismatch?: boolean
}

export interface RestoreResult {
  restored: number
  skipped: number
  renamed: number
  failed: number
  failures: Array<{ path: string; error: string }>
}

export type BackupPhase =
  | 'scanning'
  | 'verifying'
  | 'downloading'
  | 'restoring'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface BackupProgress {
  operationId: string
  kind: 'backup' | 'restore'
  phase: BackupPhase
  filesTotal: number
  filesDone: number
  bytesTotal: number
  bytesDone: number
  currentPath?: string
  message?: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: string
}

// ------------------------------------------------------------------- actions

export type ActionIntervalUnit = 'hours' | 'days' | 'weeks'

export type ActionStatus = 'idle' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

export interface ActionDefinition {
  id: string
  label: string
  /** Saved connection profile used to connect for unattended runs */
  profileId: string
  /** Absolute remote paths that are backed up */
  remotePaths: string[]
  /** Local folder that receives the timestamped backup folders */
  destination: string
  intervalValue: number
  intervalUnit: ActionIntervalUnit
  /** "HH:MM" for days/weeks schedules; null to keep the time of the last run */
  timeOfDay: string | null
  enabled: boolean
  /** Run a missed backup when the app opens again */
  catchUp: boolean
  createdAt: string
  updatedAt: string
  lastRunAt: string | null
  nextRunAt: string | null
  lastStatus: ActionStatus
  lastError: string | null
}

export interface ActionInput {
  label: string
  profileId: string
  remotePaths: string[]
  destination: string
  intervalValue: number
  intervalUnit: ActionIntervalUnit
  timeOfDay: string | null
  enabled: boolean
  catchUp: boolean
}

export type ActionRunStatus = 'running' | 'success' | 'failed' | 'skipped' | 'cancelled'

export interface ActionRunEntry {
  id: string
  actionId: string
  actionLabel: string
  startedAt: string
  finishedAt: string | null
  status: ActionRunStatus
  trigger: 'schedule' | 'manual'
  /** Backup folder produced by this run, when it succeeded */
  backupDir: string | null
  files: number
  bytes: number
  error: string | null
}

export interface ActionsSnapshot {
  actions: ActionDefinition[]
  history: ActionRunEntry[]
  /** Action currently running, if any */
  runningActionId: string | null
  /** True while any backup or restore (manual or scheduled) is running */
  busy: boolean
}

export interface ElectronApi {
  // Connection
  connect(input: ConnectInput): Promise<void>
  disconnect(): Promise<void>
  onStatus(cb: (status: ConnectionStatus) => void): () => void
  onHostKeyRequest(cb: (req: HostKeyRequest) => void): () => void
  respondHostKey(requestId: string, trusted: boolean): Promise<void>

  // Filesystem
  listLocal(path: string): Promise<DirListing>
  listRemote(path: string): Promise<DirListing>
  localHome(): Promise<string>
  localRoots(): Promise<string[]>
  remoteHome(): Promise<string>
  mkdir(side: Side, path: string): Promise<void>
  rename(side: Side, from: string, to: string): Promise<void>
  remove(side: Side, path: string): Promise<void>
  copyLocal(sources: string[], destDir: string): Promise<void>

  // Transfers
  upload(localPaths: string[], remoteDir: string): Promise<void>
  download(remotePaths: string[], localDir: string): Promise<void>
  onTransfer(cb: (update: TransferUpdate) => void): () => void

  // Shell (droplet command line)
  shellOpen(options: ShellOpenOptions): Promise<void>
  shellWrite(data: string): Promise<void>
  shellResize(cols: number, rows: number): Promise<void>
  shellClose(): Promise<void>
  onShellData(cb: (data: string) => void): () => void
  onShellClosed(cb: (event: ShellClosedEvent) => void): () => void

  // Profiles
  listProfiles(): Promise<Profile[]>
  saveProfile(
    profile: Omit<Profile, 'id'> & { id?: string },
    passphrase?: string
  ): Promise<Profile>
  deleteProfile(id: string): Promise<void>

  // Backups
  backupCreate(input: BackupCreateInput): Promise<BackupSummary>
  backupInspect(backupDir: string): Promise<BackupInspection>
  backupRestore(input: BackupRestoreInput): Promise<RestoreResult>
  backupCancel(): Promise<void>
  backupLastDestination(): Promise<string | null>
  pickBackupDestination(): Promise<string | null>
  pickBackupFolder(): Promise<string | null>
  onBackupProgress(cb: (update: BackupProgress) => void): () => void

  // Help / app info
  appInfo(): Promise<AppInfo>

  // Scheduled actions
  actionsList(): Promise<ActionsSnapshot>
  actionsSave(input: ActionInput & { id?: string }): Promise<ActionsSnapshot>
  actionsDelete(id: string): Promise<ActionsSnapshot>
  actionsSetEnabled(id: string, enabled: boolean): Promise<ActionsSnapshot>
  actionsRunNow(id: string): Promise<void>
  actionsCancelRun(): Promise<void>
  actionsDeleteBackup(runId: string): Promise<ActionsSnapshot>
  actionsOpenFolder(dir: string): Promise<void>
  onActionsChanged(cb: (snapshot: ActionsSnapshot) => void): () => void

  // Clipboard (terminal right-click menu)
  clipboardReadText(): Promise<string>
  clipboardWriteText(text: string): Promise<void>

  // Helpers
  pickKeyFile(): Promise<string | null>
  getPathForFile(file: File): string
}
