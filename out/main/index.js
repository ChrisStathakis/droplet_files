"use strict";
const electron = require("electron");
const path = require("path");
const ssh2 = require("ssh2");
const crypto = require("crypto");
const fs = require("fs");
const stream = require("stream");
const promises = require("stream/promises");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const PROFILES_FILE = "profiles.json";
const HOSTS_FILE = "trusted-hosts.json";
function dataFile(name) {
  const dir = electron.app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function readJson(name, fallback) {
  try {
    const file = dataFile(name);
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(name, data) {
  fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 2), "utf8");
}
const Store = {
  listProfiles() {
    const data = readJson(PROFILES_FILE, { profiles: [] });
    return Array.isArray(data.profiles) ? data.profiles : [];
  },
  getProfile(id) {
    return Store.listProfiles().find((p) => p.id === id);
  },
  saveProfile(profile, passphrase) {
    const profiles = Store.listProfiles();
    const existing = profile.id ? profiles.find((p) => p.id === profile.id) : void 0;
    const stored = {
      ...profile,
      id: existing?.id ?? crypto.randomUUID(),
      passphraseEnc: void 0
    };
    if (existing?.passphraseEnc) stored.passphraseEnc = existing.passphraseEnc;
    if (profile.rememberPassphrase && passphrase) {
      if (electron.safeStorage.isEncryptionAvailable()) {
        stored.passphraseEnc = electron.safeStorage.encryptString(passphrase).toString("base64");
      }
    }
    if (existing) {
      Object.assign(existing, stored);
      writeJson(PROFILES_FILE, { profiles });
      return existing;
    }
    profiles.push(stored);
    writeJson(PROFILES_FILE, { profiles });
    return stored;
  },
  deleteProfile(id) {
    const profiles = Store.listProfiles().filter((p) => p.id !== id);
    writeJson(PROFILES_FILE, { profiles });
  },
  /** Remember a passphrase against an existing profile (called on connect) */
  rememberPassphrase(profileId, passphrase) {
    const profiles = Store.listProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile?.rememberPassphrase || !passphrase) return;
    if (!electron.safeStorage.isEncryptionAvailable()) return;
    profile.passphraseEnc = electron.safeStorage.encryptString(passphrase).toString("base64");
    writeJson(PROFILES_FILE, { profiles });
  },
  getPassphrase(profileId) {
    const profile = Store.getProfile(profileId);
    if (!profile?.passphraseEnc) return void 0;
    try {
      return electron.safeStorage.decryptString(Buffer.from(profile.passphraseEnc, "base64"));
    } catch {
      return void 0;
    }
  },
  // Trusted SSH host fingerprints ("host:port" -> "SHA256:...")
  getTrustedFingerprint(hostPort) {
    return readJson(HOSTS_FILE, {})[hostPort];
  },
  setTrustedFingerprint(hostPort, fingerprint) {
    const hosts = readJson(HOSTS_FILE, {});
    hosts[hostPort] = fingerprint;
    writeJson(HOSTS_FILE, hosts);
  }
};
function promisify(fn) {
  return new Promise((resolve, reject) => {
    fn((err, result) => err ? reject(err) : resolve(result));
  });
}
function sftpCall(fn) {
  return new Promise((resolve, reject) => {
    fn((err) => err ? reject(err) : resolve());
  });
}
function errmsg(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
function compareEntries(a, b) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name, void 0, { numeric: true, sensitivity: "base" });
}
async function uniqueName(dir, name, join, exists) {
  if (!await exists(join(dir, name))) return name;
  const ext = path__namespace.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let i = 1;
  while (true) {
    const candidate = `${stem} (${i})${ext}`;
    if (!await exists(join(dir, candidate))) return candidate;
    i++;
  }
}
function sftpExists(sftp, p) {
  return new Promise((resolve) => sftp.stat(p, (err) => resolve(!err)));
}
const PROGRESS_INTERVAL_MS = 100;
class SshManager {
  constructor(events) {
    this.events = events;
  }
  events;
  client = null;
  sftp = null;
  pendingHostKeys = /* @__PURE__ */ new Map();
  lock = Promise.resolve();
  transferSeq = 0;
  status = { state: "disconnected" };
  setStatus(state, message) {
    this.status = { state, message };
    this.events.status(this.status);
  }
  isConnected() {
    return this.status.state === "connected" && this.sftp !== null;
  }
  // ---------------------------------------------------------------- connection
  async connect(input) {
    if (this.status.state === "connecting") throw new Error("Connection already in progress");
    await this.disconnect();
    const label = `${input.username}@${input.host}:${input.port}`;
    this.setStatus("connecting", label);
    let privateKey;
    try {
      privateKey = await fs.promises.readFile(input.keyPath);
    } catch (err) {
      this.setStatus("disconnected");
      throw new Error(`Cannot read private key file "${input.keyPath}": ${errmsg(err)}`);
    }
    const passphrase = input.passphrase || (input.profileId ? Store.getPassphrase(input.profileId) : void 0) || void 0;
    if (input.profileId && input.rememberPassphrase && input.passphrase) {
      Store.rememberPassphrase(input.profileId, input.passphrase);
    }
    const hostVerifier = (key, verify) => {
      void this.verifyHostKey(input, key, verify);
    };
    const config = {
      host: input.host,
      port: input.port,
      username: input.username,
      privateKey,
      passphrase,
      readyTimeout: 15e3,
      keepaliveInterval: 1e4,
      hostVerifier
    };
    const client = new ssh2.Client();
    let settled = false;
    try {
      await new Promise((resolve, reject) => {
        const fail = (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        client.on("ready", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        client.on("error", (err) => {
          if (!settled) fail(err);
          else if (this.client === client) this.handleUnexpectedClose(errmsg(err));
        });
        const onClosed = () => {
          if (this.client !== client) return;
          if (!settled) fail(new Error("Connection closed before reaching the server"));
          else this.handleUnexpectedClose();
        };
        client.on("close", onClosed);
        client.on("end", onClosed);
        this.client = client;
        client.connect(config);
      });
      this.sftp = await promisify((cb) => client.sftp(cb));
      this.setStatus("connected", label);
    } catch (err) {
      if (this.client === client) {
        this.client = null;
        this.sftp = null;
      }
      try {
        client.end();
      } catch {
      }
      this.rejectPendingHostKeys();
      const message = errmsg(err);
      this.setStatus("disconnected");
      throw new Error(
        /host.*verif|host.*key/i.test(message) ? "Host key verification failed — the server identity could not be confirmed" : message
      );
    }
  }
  async disconnect() {
    this.rejectPendingHostKeys();
    const client = this.client;
    this.client = null;
    this.sftp = null;
    if (client) {
      try {
        client.end();
      } catch {
      }
    }
    if (this.status.state !== "disconnected") this.setStatus("disconnected");
  }
  handleUnexpectedClose(message) {
    this.client = null;
    this.sftp = null;
    this.rejectPendingHostKeys();
    this.setStatus("disconnected", message || void 0);
  }
  rejectPendingHostKeys() {
    for (const resolve of this.pendingHostKeys.values()) resolve(false);
    this.pendingHostKeys.clear();
  }
  respondHostKey(requestId, trusted) {
    const resolve = this.pendingHostKeys.get(requestId);
    if (!resolve) return;
    this.pendingHostKeys.delete(requestId);
    resolve(trusted);
  }
  async verifyHostKey(input, rawKey, verify) {
    let done = false;
    const finish = (valid) => {
      if (done) return;
      done = true;
      verify(valid);
    };
    const fingerprint = "SHA256:" + crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "");
    const hostPort = `${input.host}:${input.port}`;
    const trusted = Store.getTrustedFingerprint(hostPort);
    if (trusted === fingerprint) return finish(true);
    const requestId = crypto.randomUUID();
    const answer = await new Promise((resolve) => {
      this.pendingHostKeys.set(requestId, resolve);
      this.events.hostKey({
        requestId,
        host: input.host,
        port: input.port,
        fingerprint,
        changed: trusted !== void 0
      });
      setTimeout(() => {
        if (this.pendingHostKeys.delete(requestId)) resolve(false);
      }, 12e4);
    });
    if (answer) Store.setTrustedFingerprint(hostPort, fingerprint);
    finish(answer);
  }
  // ----------------------------------------------------------------- filesystem
  requireSftp() {
    if (!this.isConnected() || !this.sftp) throw new Error("Not connected to a server");
    return this.sftp;
  }
  async listRemote(dir) {
    const sftp = this.requireSftp();
    const list = await promisify((cb) => sftp.readdir(dir, cb));
    const entries = list.filter((e) => e.filename !== "." && e.filename !== "..").map((e) => ({
      name: e.filename,
      isDir: e.attrs.isDirectory(),
      size: e.attrs.size,
      mtime: e.attrs.mtime,
      isSymlink: e.attrs.isSymbolicLink()
    }));
    entries.sort(compareEntries);
    return {
      path: dir,
      parent: dir === "/" ? null : path__namespace.posix.dirname(dir) || "/",
      entries
    };
  }
  async listLocal(dir) {
    let dirents;
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") {
        throw new Error(`Folder not found: ${dir}`);
      }
      if (err.code === "EACCES") {
        throw new Error(`Access denied: ${dir}`);
      }
      throw err;
    }
    const entries = await Promise.all(
      dirents.map(async (d) => {
        const full = path__namespace.join(dir, d.name);
        let isDir = d.isDirectory();
        let size = 0;
        let mtime = 0;
        try {
          const st = await fs.promises.stat(full);
          isDir = st.isDirectory();
          size = st.size;
          mtime = Math.floor(st.mtimeMs / 1e3);
        } catch {
        }
        return { name: d.name, isDir, size, mtime, isSymlink: d.isSymbolicLink() };
      })
    );
    entries.sort(compareEntries);
    const parent = path__namespace.dirname(dir);
    return {
      path: dir,
      parent: parent === dir ? null : parent,
      entries
    };
  }
  localHome() {
    return process.env.USERPROFILE || process.env.HOME || process.cwd();
  }
  localRoots() {
    if (process.platform === "win32") {
      const roots = [];
      for (let i = 65; i <= 90; i++) {
        const drive = `${String.fromCharCode(i)}:\\`;
        try {
          const dir = fs.opendirSync(drive);
          dir.closeSync();
          roots.push(drive);
        } catch {
        }
      }
      return roots;
    }
    return ["/"];
  }
  async remoteHome() {
    const sftp = this.requireSftp();
    return promisify((cb) => sftp.realpath(".", cb));
  }
  async mkdir(side, dir) {
    if (side === "local") {
      await fs.promises.mkdir(dir);
      return;
    }
    const sftp = this.requireSftp();
    await sftpCall((done) => sftp.mkdir(dir, done));
  }
  async rename(side, from, to) {
    if (side === "local") {
      await fs.promises.rename(from, to);
      return;
    }
    const sftp = this.requireSftp();
    await sftpCall((done) => sftp.rename(from, to, done));
  }
  async remove(side, target) {
    if (side === "local") {
      const st = await fs.promises.lstat(target);
      if (st.isDirectory() && !st.isSymbolicLink()) await fs.promises.rm(target, { recursive: true });
      else await fs.promises.unlink(target);
      return;
    }
    await this.remoteRemove(this.requireSftp(), target);
  }
  async remoteRemove(sftp, target) {
    const st = await promisify((cb) => sftp.lstat(target, cb));
    if (st.isDirectory() && !st.isSymbolicLink()) {
      const list = await promisify((cb) => sftp.readdir(target, cb));
      for (const entry of list) {
        await this.remoteRemove(sftp, path__namespace.posix.join(target, entry.filename));
      }
      await sftpCall((done) => sftp.rmdir(target, done));
    } else {
      await sftpCall((done) => sftp.unlink(target, done));
    }
  }
  async copyLocal(sources, destDir) {
    for (const src of sources) {
      const dest = path__namespace.join(destDir, path__namespace.basename(src));
      await fs.promises.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
    }
  }
  // ----------------------------------------------------------------- transfers
  /** Runs jobs one at a time so transfers don't interleave */
  withLock(fn) {
    const result = this.lock.then(() => fn());
    this.lock = result.then(
      () => void 0,
      () => void 0
    );
    return result;
  }
  async upload(localPaths, remoteDir) {
    const sftp = this.requireSftp();
    return this.withLock(async () => {
      for (const src of localPaths) {
        const st = await fs.promises.lstat(src);
        const base = path__namespace.basename(src);
        const destName = await uniqueName(
          remoteDir,
          base,
          (d, n) => path__namespace.posix.join(d, n),
          (p) => sftpExists(sftp, p)
        );
        const dest = path__namespace.posix.join(remoteDir, destName);
        if (st.isDirectory()) await this.uploadDir(src, dest);
        else await this.uploadFile(src, dest, destName);
      }
    });
  }
  async uploadDir(localDir, remoteDir) {
    const sftp = this.requireSftp();
    try {
      await sftpCall((done) => sftp.mkdir(remoteDir, done));
    } catch (err) {
      if (!await sftpExists(sftp, remoteDir)) throw err;
    }
    const dirents = await fs.promises.readdir(localDir, { withFileTypes: true });
    for (const d of dirents) {
      const full = path__namespace.join(localDir, d.name);
      const dest = path__namespace.posix.join(remoteDir, d.name);
      if (d.isDirectory()) await this.uploadDir(full, dest);
      else if (d.isFile()) await this.uploadFile(full, dest, d.name);
    }
  }
  async uploadFile(localPath, remotePath, name) {
    const sftp = this.requireSftp();
    const id = String(++this.transferSeq);
    let total = 0;
    try {
      const st = await fs.promises.stat(localPath);
      total = st.size;
      this.emitTransfer({ id, name, direction: "up", state: "queued", transferred: 0, total });
      this.emitTransfer({ id, name, direction: "up", state: "active", transferred: 0, total });
      const source = fs.createReadStream(localPath);
      const counter = this.counter(id, name, "up", total);
      const dest = sftp.createWriteStream(remotePath);
      await promises.pipeline(source, counter, dest);
      this.emitTransfer({ id, name, direction: "up", state: "done", transferred: total, total });
    } catch (err) {
      this.emitTransfer({
        id,
        name,
        direction: "up",
        state: "error",
        transferred: 0,
        total,
        error: errmsg(err)
      });
    }
  }
  async download(remotePaths, localDir) {
    const sftp = this.requireSftp();
    return this.withLock(async () => {
      for (const src of remotePaths) {
        const base = path__namespace.posix.basename(src);
        const destName = await uniqueName(
          localDir,
          base,
          (d, n) => path__namespace.join(d, n),
          (p) => fs.promises.access(p).then(() => true).catch(() => false)
        );
        const dest = path__namespace.join(localDir, destName);
        const st = await promisify((cb) => sftp.lstat(src, cb));
        if (st.isDirectory() && !st.isSymbolicLink()) await this.downloadDir(src, dest);
        else await this.downloadFile(src, dest, destName);
      }
    });
  }
  async downloadDir(remoteDir, localDir) {
    const sftp = this.requireSftp();
    await fs.promises.mkdir(localDir, { recursive: true });
    const list = await promisify((cb) => sftp.readdir(remoteDir, cb));
    for (const entry of list) {
      const src = path__namespace.posix.join(remoteDir, entry.filename);
      const dest = path__namespace.join(localDir, entry.filename);
      if (entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink()) {
        await this.downloadDir(src, dest);
      } else if (!entry.attrs.isSymbolicLink()) {
        await this.downloadFile(src, dest, entry.filename);
      }
    }
  }
  async downloadFile(remotePath, localPath, name) {
    const sftp = this.requireSftp();
    const id = String(++this.transferSeq);
    let total = 0;
    try {
      const st = await promisify((cb) => sftp.stat(remotePath, cb));
      total = st.size;
      this.emitTransfer({ id, name, direction: "down", state: "queued", transferred: 0, total });
      this.emitTransfer({ id, name, direction: "down", state: "active", transferred: 0, total });
      const source = sftp.createReadStream(remotePath);
      const counter = this.counter(id, name, "down", total);
      const dest = fs.createWriteStream(localPath);
      await promises.pipeline(source, counter, dest);
      this.emitTransfer({ id, name, direction: "down", state: "done", transferred: total, total });
    } catch (err) {
      this.emitTransfer({
        id,
        name,
        direction: "down",
        state: "error",
        transferred: 0,
        total,
        error: errmsg(err)
      });
    }
  }
  counter(id, name, direction, total) {
    let transferred = 0;
    let lastEmit = 0;
    return new stream.Transform({
      transform: (chunk, _enc, cb) => {
        transferred += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= PROGRESS_INTERVAL_MS || transferred >= total) {
          lastEmit = now;
          this.emitTransfer({ id, name, direction, state: "active", transferred, total });
        }
        cb(null, chunk);
      }
    });
  }
  emitTransfer(update) {
    this.events.transfer(update);
  }
}
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
  // events (main -> renderer)
  status: "conn:status",
  hostKeyRequest: "hostkey:request",
  transferUpdate: "transfer:update"
};
let win = null;
function setMainWindow(window) {
  win = window;
}
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function registerIpc() {
  const manager = new SshManager({
    status: (status) => send(CH.status, status),
    hostKey: (request) => send(CH.hostKeyRequest, request),
    transfer: (update) => send(CH.transferUpdate, update)
  });
  electron.ipcMain.handle(CH.connect, (_e, input) => manager.connect(input));
  electron.ipcMain.handle(CH.disconnect, () => manager.disconnect());
  electron.ipcMain.handle(
    CH.hostKeyRespond,
    (_e, requestId, trusted) => manager.respondHostKey(requestId, trusted)
  );
  electron.ipcMain.handle(CH.listLocal, (_e, dir) => manager.listLocal(dir));
  electron.ipcMain.handle(CH.listRemote, (_e, dir) => manager.listRemote(dir));
  electron.ipcMain.handle(CH.localHome, () => manager.localHome());
  electron.ipcMain.handle(CH.localRoots, () => manager.localRoots());
  electron.ipcMain.handle(CH.remoteHome, () => manager.remoteHome());
  electron.ipcMain.handle(CH.mkdir, (_e, side, dir) => manager.mkdir(side, dir));
  electron.ipcMain.handle(
    CH.rename,
    (_e, side, from, to) => manager.rename(side, from, to)
  );
  electron.ipcMain.handle(CH.remove, (_e, side, target) => manager.remove(side, target));
  electron.ipcMain.handle(
    CH.copyLocal,
    (_e, sources, destDir) => manager.copyLocal(sources, destDir)
  );
  electron.ipcMain.handle(
    CH.upload,
    (_e, localPaths, remoteDir) => manager.upload(localPaths, remoteDir)
  );
  electron.ipcMain.handle(
    CH.download,
    (_e, remotePaths, localDir) => manager.download(remotePaths, localDir)
  );
  electron.ipcMain.handle(
    CH.profilesList,
    () => Store.listProfiles().map(({ passphraseEnc: _ignored, ...profile }) => profile)
  );
  electron.ipcMain.handle(
    CH.profilesSave,
    (_e, profile, passphrase) => Store.saveProfile(profile, passphrase)
  );
  electron.ipcMain.handle(CH.profilesDelete, (_e, id) => Store.deleteProfile(id));
  electron.ipcMain.handle(CH.pickKeyFile, async () => {
    const options = {
      title: "Select SSH private key",
      properties: ["openFile"],
      message: "Choose the private key file used to connect (e.g. ~/.ssh/id_ed25519)"
    };
    const result = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0];
  });
}
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 560,
    title: "Droplet Files",
    backgroundColor: "#12151a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  setMainWindow(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
    setMainWindow(null);
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    mainWindow.webContents.on("console-message", (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(() => {
  registerIpc();
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
