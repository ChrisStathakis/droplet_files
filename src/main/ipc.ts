import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type OpenDialogOptions
} from 'electron'
import { ActionManager } from './actions'
import { BackupManager } from './backup'
import { SshManager } from './ssh'
import { Store } from './store'
import { CH } from '../shared/channels'
import type {
  ActionInput,
  BackupCreateInput,
  BackupRestoreInput,
  ConnectInput,
  Profile,
  ShellOpenOptions,
  Side
} from '../shared/types'

let win: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow | null): void {
  win = window
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export interface IpcCallbacks {
  /** Lets the app keep a tray icon while scheduled actions are enabled */
  onActionsEnabledChange?(hasEnabled: boolean): void
}

export function registerIpc(callbacks: IpcCallbacks = {}): void {
  const manager = new SshManager({
    status: (status) => send(CH.status, status),
    hostKey: (request) => send(CH.hostKeyRequest, request),
    transfer: (update) => send(CH.transferUpdate, update),
    shellData: (chunk) => send(CH.shellData, chunk),
    shellClosed: (event) => send(CH.shellClosed, event)
  })

  const backups = new BackupManager({
    ssh: manager,
    appVersion: app.getVersion(),
    events: { progress: (update) => send(CH.backupProgress, update) }
  })

  const actions = new ActionManager({
    ssh: manager,
    backups,
    events: {
      changed: (snapshot) => send(CH.actionsChanged, snapshot),
      enabledChanged: (hasEnabled) => callbacks.onActionsEnabledChange?.(hasEnabled)
    }
  })
  actions.start()

  // Connection
  ipcMain.handle(CH.connect, (_e, input: ConnectInput) => manager.connect(input))
  ipcMain.handle(CH.disconnect, () => manager.disconnect())
  ipcMain.handle(CH.hostKeyRespond, (_e, requestId: string, trusted: boolean) =>
    manager.respondHostKey(requestId, trusted)
  )

  // Filesystem
  ipcMain.handle(CH.listLocal, (_e, dir: string) => manager.listLocal(dir))
  ipcMain.handle(CH.listRemote, (_e, dir: string) => manager.listRemote(dir))
  ipcMain.handle(CH.localHome, () => manager.localHome())
  ipcMain.handle(CH.localRoots, () => manager.localRoots())
  ipcMain.handle(CH.remoteHome, () => manager.remoteHome())
  ipcMain.handle(CH.mkdir, (_e, side: Side, dir: string) => manager.mkdir(side, dir))
  ipcMain.handle(CH.rename, (_e, side: Side, from: string, to: string) =>
    manager.rename(side, from, to)
  )
  ipcMain.handle(CH.remove, (_e, side: Side, target: string) => manager.remove(side, target))
  ipcMain.handle(CH.copyLocal, (_e, sources: string[], destDir: string) =>
    manager.copyLocal(sources, destDir)
  )

  // Transfers
  ipcMain.handle(CH.upload, (_e, localPaths: string[], remoteDir: string) =>
    manager.upload(localPaths, remoteDir)
  )
  ipcMain.handle(CH.download, (_e, remotePaths: string[], localDir: string) =>
    manager.download(remotePaths, localDir)
  )

  // Shell
  ipcMain.handle(CH.shellOpen, (_e, options: ShellOpenOptions) => manager.openShell(options))
  ipcMain.handle(CH.shellWrite, (_e, data: string) => manager.writeShell(data))
  ipcMain.handle(CH.shellResize, (_e, cols: number, rows: number) =>
    manager.resizeShell(cols, rows)
  )
  ipcMain.handle(CH.shellClose, () => manager.closeShell())

  // Backups
  ipcMain.handle(CH.backupCreate, async (_e, input: BackupCreateInput) => {
    const summary = await backups.create(input)
    Store.setBackupDir(input.destination)
    return summary
  })
  ipcMain.handle(CH.backupInspect, (_e, backupDir: string) => backups.inspect(backupDir))
  ipcMain.handle(CH.backupRestore, (_e, input: BackupRestoreInput) => backups.restore(input))
  ipcMain.handle(CH.backupCancel, () => backups.cancel())
  ipcMain.handle(CH.backupLastDestination, () => Store.getBackupDir() ?? null)
  ipcMain.handle(CH.pickBackupDestination, async () => {
    const options: OpenDialogOptions = {
      title: 'Choose where to save the backup',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: Store.getBackupDir()
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    Store.setBackupDir(result.filePaths[0])
    return result.filePaths[0]
  })
  ipcMain.handle(CH.pickBackupFolder, async () => {
    const options: OpenDialogOptions = {
      title: 'Select a backup folder',
      buttonLabel: 'Open backup',
      properties: ['openDirectory'],
      defaultPath: Store.getBackupDir()
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  // Help / app info
  ipcMain.handle(CH.appInfo, () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    platform: process.platform
  }))

  // Scheduled actions
  ipcMain.handle(CH.actionsList, () => actions.snapshot())
  ipcMain.handle(CH.actionsSave, (_e, input: ActionInput & { id?: string }) => actions.save(input))
  ipcMain.handle(CH.actionsDelete, (_e, id: string) => actions.remove(id))
  ipcMain.handle(CH.actionsSetEnabled, (_e, id: string, enabled: boolean) =>
    actions.setEnabled(id, enabled)
  )
  ipcMain.handle(CH.actionsRunNow, (_e, id: string) => actions.runAction(id, 'manual'))
  ipcMain.handle(CH.actionsCancelRun, () => actions.cancelRun())
  ipcMain.handle(CH.actionsDeleteBackup, (_e, runId: string) => actions.deleteBackup(runId))
  ipcMain.handle(CH.actionsOpenFolder, async (_e, dir: string) => {
    const message = await shell.openPath(dir)
    if (message) throw new Error(message)
  })

  // Clipboard for the terminal right-click menu
  ipcMain.handle(CH.clipboardReadText, () => clipboard.readText())
  ipcMain.handle(CH.clipboardWriteText, (_e, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })

  // Profiles
  ipcMain.handle(CH.profilesList, (): Profile[] =>
    Store.listProfiles().map(({ passphraseEnc: _ignored, ...profile }) => profile)
  )
  ipcMain.handle(CH.profilesSave, (_e, profile: Omit<Profile, 'id'> & { id?: string }, passphrase?: string) =>
    Store.saveProfile(profile, passphrase)
  )
  ipcMain.handle(CH.profilesDelete, (_e, id: string) => Store.deleteProfile(id))

  // Dialogs
  ipcMain.handle(CH.pickKeyFile, async () => {
    const options: OpenDialogOptions = {
      title: 'Select SSH private key',
      properties: ['openFile'],
      message: 'Choose the private key file used to connect (e.g. ~/.ssh/id_ed25519)'
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
}
