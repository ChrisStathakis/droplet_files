import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '../shared/channels'
import type { ElectronApi } from '../shared/types'

function onEvent<T>(channel: string): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.off(channel, listener)
  }
}

const api: ElectronApi = {
  connect: (input) => ipcRenderer.invoke(CH.connect, input),
  disconnect: () => ipcRenderer.invoke(CH.disconnect),
  onStatus: onEvent(CH.status),
  onHostKeyRequest: onEvent(CH.hostKeyRequest),
  respondHostKey: (requestId, trusted) => ipcRenderer.invoke(CH.hostKeyRespond, requestId, trusted),

  listLocal: (path) => ipcRenderer.invoke(CH.listLocal, path),
  listRemote: (path) => ipcRenderer.invoke(CH.listRemote, path),
  localHome: () => ipcRenderer.invoke(CH.localHome),
  localRoots: () => ipcRenderer.invoke(CH.localRoots),
  remoteHome: () => ipcRenderer.invoke(CH.remoteHome),
  mkdir: (side, path) => ipcRenderer.invoke(CH.mkdir, side, path),
  rename: (side, from, to) => ipcRenderer.invoke(CH.rename, side, from, to),
  remove: (side, path) => ipcRenderer.invoke(CH.remove, side, path),
  copyLocal: (sources, destDir) => ipcRenderer.invoke(CH.copyLocal, sources, destDir),

  upload: (localPaths, remoteDir) => ipcRenderer.invoke(CH.upload, localPaths, remoteDir),
  download: (remotePaths, localDir) => ipcRenderer.invoke(CH.download, remotePaths, localDir),
  onTransfer: onEvent(CH.transferUpdate),

  shellOpen: (options) => ipcRenderer.invoke(CH.shellOpen, options),
  shellWrite: (data) => ipcRenderer.invoke(CH.shellWrite, data),
  shellResize: (cols, rows) => ipcRenderer.invoke(CH.shellResize, cols, rows),
  shellClose: () => ipcRenderer.invoke(CH.shellClose),
  onShellData: onEvent(CH.shellData),
  onShellClosed: onEvent(CH.shellClosed),

  listProfiles: () => ipcRenderer.invoke(CH.profilesList),
  saveProfile: (profile, passphrase) => ipcRenderer.invoke(CH.profilesSave, profile, passphrase),
  deleteProfile: (id) => ipcRenderer.invoke(CH.profilesDelete, id),

  pickKeyFile: () => ipcRenderer.invoke(CH.pickKeyFile),
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('api', api)
