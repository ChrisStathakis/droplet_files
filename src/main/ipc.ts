import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { SshManager } from './ssh'
import { Store } from './store'
import { CH } from '../shared/channels'
import type { ConnectInput, Profile, Side } from '../shared/types'

let win: BrowserWindow | null = null

export function setMainWindow(window: BrowserWindow | null): void {
  win = window
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function registerIpc(): void {
  const manager = new SshManager({
    status: (status) => send(CH.status, status),
    hostKey: (request) => send(CH.hostKeyRequest, request),
    transfer: (update) => send(CH.transferUpdate, update)
  })

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
