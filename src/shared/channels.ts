/** IPC channel names, shared between main and preload to avoid typos */
export const CH = {
  // invoke
  connect: 'conn:connect',
  disconnect: 'conn:disconnect',
  hostKeyRespond: 'hostkey:respond',
  listLocal: 'fs:list:local',
  listRemote: 'fs:list:remote',
  localHome: 'fs:home',
  localRoots: 'fs:roots',
  remoteHome: 'fs:remote-home',
  mkdir: 'fs:mkdir',
  rename: 'fs:rename',
  remove: 'fs:remove',
  copyLocal: 'fs:copy-local',
  upload: 'transfer:upload',
  download: 'transfer:download',
  profilesList: 'profiles:list',
  profilesSave: 'profiles:save',
  profilesDelete: 'profiles:delete',
  pickKeyFile: 'dialog:keyfile',
  shellOpen: 'shell:open',
  shellWrite: 'shell:write',
  shellResize: 'shell:resize',
  shellClose: 'shell:close',
  // events (main -> renderer)
  status: 'conn:status',
  hostKeyRequest: 'hostkey:request',
  transferUpdate: 'transfer:update',
  shellData: 'shell:data',
  shellClosed: 'shell:closed'
} as const
