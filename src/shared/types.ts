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

  // Profiles
  listProfiles(): Promise<Profile[]>
  saveProfile(
    profile: Omit<Profile, 'id'> & { id?: string },
    passphrase?: string
  ): Promise<Profile>
  deleteProfile(id: string): Promise<void>

  // Helpers
  pickKeyFile(): Promise<string | null>
  getPathForFile(file: File): string
}
