"use strict";
const electron = require("electron");
const CH = {
  // invoke
  connect: "conn:connect",
  disconnect: "conn:disconnect",
  hostKeyRespond: "hostkey:respond",
  listLocal: "fs:list:local",
  listRemote: "fs:list:remote",
  localHome: "fs:home",
  localRoots: "fs:roots",
  remoteHome: "fs:remote-home",
  mkdir: "fs:mkdir",
  rename: "fs:rename",
  remove: "fs:remove",
  copyLocal: "fs:copy-local",
  upload: "transfer:upload",
  download: "transfer:download",
  profilesList: "profiles:list",
  profilesSave: "profiles:save",
  profilesDelete: "profiles:delete",
  pickKeyFile: "dialog:keyfile",
  shellOpen: "shell:open",
  shellWrite: "shell:write",
  shellResize: "shell:resize",
  shellClose: "shell:close",
  // events (main -> renderer)
  status: "conn:status",
  hostKeyRequest: "hostkey:request",
  transferUpdate: "transfer:update",
  shellData: "shell:data",
  shellClosed: "shell:closed"
};
function onEvent(channel) {
  return (cb) => {
    const listener = (_event, payload) => cb(payload);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.off(channel, listener);
  };
}
const api = {
  connect: (input) => electron.ipcRenderer.invoke(CH.connect, input),
  disconnect: () => electron.ipcRenderer.invoke(CH.disconnect),
  onStatus: onEvent(CH.status),
  onHostKeyRequest: onEvent(CH.hostKeyRequest),
  respondHostKey: (requestId, trusted) => electron.ipcRenderer.invoke(CH.hostKeyRespond, requestId, trusted),
  listLocal: (path) => electron.ipcRenderer.invoke(CH.listLocal, path),
  listRemote: (path) => electron.ipcRenderer.invoke(CH.listRemote, path),
  localHome: () => electron.ipcRenderer.invoke(CH.localHome),
  localRoots: () => electron.ipcRenderer.invoke(CH.localRoots),
  remoteHome: () => electron.ipcRenderer.invoke(CH.remoteHome),
  mkdir: (side, path) => electron.ipcRenderer.invoke(CH.mkdir, side, path),
  rename: (side, from, to) => electron.ipcRenderer.invoke(CH.rename, side, from, to),
  remove: (side, path) => electron.ipcRenderer.invoke(CH.remove, side, path),
  copyLocal: (sources, destDir) => electron.ipcRenderer.invoke(CH.copyLocal, sources, destDir),
  upload: (localPaths, remoteDir) => electron.ipcRenderer.invoke(CH.upload, localPaths, remoteDir),
  download: (remotePaths, localDir) => electron.ipcRenderer.invoke(CH.download, remotePaths, localDir),
  onTransfer: onEvent(CH.transferUpdate),
  shellOpen: (options) => electron.ipcRenderer.invoke(CH.shellOpen, options),
  shellWrite: (data) => electron.ipcRenderer.invoke(CH.shellWrite, data),
  shellResize: (cols, rows) => electron.ipcRenderer.invoke(CH.shellResize, cols, rows),
  shellClose: () => electron.ipcRenderer.invoke(CH.shellClose),
  onShellData: onEvent(CH.shellData),
  onShellClosed: onEvent(CH.shellClosed),
  listProfiles: () => electron.ipcRenderer.invoke(CH.profilesList),
  saveProfile: (profile, passphrase) => electron.ipcRenderer.invoke(CH.profilesSave, profile, passphrase),
  deleteProfile: (id) => electron.ipcRenderer.invoke(CH.profilesDelete, id),
  pickKeyFile: () => electron.ipcRenderer.invoke(CH.pickKeyFile),
  getPathForFile: (file) => electron.webUtils.getPathForFile(file)
};
electron.contextBridge.exposeInMainWorld("api", api);
