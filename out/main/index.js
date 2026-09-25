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
    if (profile.rememberPassphrase && existing?.passphraseEnc) {
      stored.passphraseEnc = existing.passphraseEnc;
    }
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
    if (!profile?.rememberPassphrase || !profile.passphraseEnc) return void 0;
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
  connectionGeneration = 0;
  connectAbort = null;
  shellStream = null;
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
    const label = `${input.username}@${input.host}:${input.port}`;
    this.closeCurrentConnection();
    const generation = ++this.connectionGeneration;
    const abort = new AbortController();
    this.connectAbort = abort;
    this.setStatus("connecting", label);
    try {
      let privateKey;
      try {
        privateKey = await fs.promises.readFile(input.keyPath, { signal: abort.signal });
      } catch (err) {
        if (generation === this.connectionGeneration) {
          throw new Error(`Cannot read private key file "${input.keyPath}": ${errmsg(err)}`);
        }
        throw err;
      }
      this.assertConnectionAttempt(generation);
      const passphrase = input.passphrase || (input.rememberPassphrase && input.profileId ? Store.getPassphrase(input.profileId) : void 0) || void 0;
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
      await new Promise((resolve, reject) => {
        const fail = (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        client.on("ready", () => {
          if (settled) return;
          if (generation !== this.connectionGeneration || this.client !== client) {
            fail(new Error("Connection cancelled"));
            return;
          }
          settled = true;
          resolve();
        });
        client.on("error", (err) => {
          if (!settled) fail(err);
          else if (this.client === client) this.handleUnexpectedClose(errmsg(err));
        });
        const onClosed = () => {
          if (!settled) {
            fail(new Error("Connection closed before reaching the server"));
          } else if (generation === this.connectionGeneration && this.client === client) {
            this.handleUnexpectedClose();
          }
        };
        client.on("close", onClosed);
        client.on("end", onClosed);
        this.client = client;
        client.connect(config);
      });
      const sftp = await promisify((cb) => client.sftp(cb));
      this.assertConnectionAttempt(generation);
      this.sftp = sftp;
      this.connectAbort = null;
      this.setStatus("connected", label);
    } catch (err) {
      if (generation === this.connectionGeneration) {
        this.connectAbort = null;
        this.closeCurrentConnection();
        this.setStatus("disconnected");
        this.rejectPendingHostKeys();
      }
      const message = errmsg(err);
      throw new Error(
        /host.*verif|host.*key/i.test(message) ? "Host key verification failed — the server identity could not be confirmed" : message
      );
    }
  }
  async disconnect() {
    this.connectionGeneration++;
    this.connectAbort?.abort();
    this.connectAbort = null;
    this.closeCurrentConnection();
    if (this.status.state !== "disconnected") this.setStatus("disconnected");
  }
  closeCurrentConnection() {
    this.rejectPendingHostKeys();
    this.endShell();
    const client = this.client;
    this.client = null;
    this.sftp = null;
    if (client) {
      try {
        client.end();
      } catch {
      }
    }
  }
  assertConnectionAttempt(generation) {
    if (generation !== this.connectionGeneration) throw new Error("Connection cancelled");
  }
  handleUnexpectedClose(message) {
    this.client = null;
    this.sftp = null;
    this.endShell(message);
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
  // ---------------------------------------------------------------------- shell
  /**
   * Opens an interactive shell (PTY) on the existing connection.
   * Any previous session is replaced silently — only the new stream emits events.
   */
  async openShell(options) {
    const client = this.client;
    const generation = this.connectionGeneration;
    if (!client || this.status.state !== "connected") {
      throw new Error("Not connected to a server");
    }
    this.endShell(void 0, true);
    const stream2 = await promisify(
      (cb) => client.shell(
        {
          term: "xterm-256color",
          cols: Math.max(2, Math.floor(options.cols)),
          rows: Math.max(1, Math.floor(options.rows))
        },
        cb
      )
    );
    if (generation !== this.connectionGeneration || this.client !== client) {
      stream2.destroy();
      throw new Error("Connection changed while opening the shell");
    }
    this.shellStream = stream2;
    stream2.setEncoding("utf8");
    stream2.stderr.setEncoding("utf8");
    stream2.on("data", (chunk) => {
      if (this.shellStream === stream2) this.events.shellData(chunk);
    });
    stream2.stderr.on("data", (chunk) => {
      if (this.shellStream === stream2) this.events.shellData(chunk);
    });
    const finish = (reason) => {
      if (this.shellStream !== stream2) return;
      this.shellStream = null;
      this.events.shellClosed({ reason });
    };
    stream2.on("error", (err) => finish(err.message));
    stream2.on("close", () => finish());
  }
  /** Sends keystrokes to the shell; ignored when no session is open */
  writeShell(data) {
    const stream2 = this.shellStream;
    if (!stream2) return;
    stream2.write(data);
  }
  /** Tells the remote PTY about a terminal resize; ignored when no session is open */
  resizeShell(cols, rows) {
    const stream2 = this.shellStream;
    if (!stream2) return;
    stream2.setWindow(Math.max(1, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0);
  }
  closeShell() {
    this.endShell();
  }
  /** Ends the shell channel; `silent` skips the shellClosed event (session swap) */
  endShell(reason, silent = false) {
    const stream2 = this.shellStream;
    if (!stream2) return;
    this.shellStream = null;
    try {
      stream2.destroy();
    } catch {
    }
    if (!silent) this.events.shellClosed({ reason });
  }
  // ----------------------------------------------------------------- filesystem
  requireSftp() {
    if (!this.isConnected() || !this.sftp) throw new Error("Not connected to a server");
    return this.sftp;
  }
  captureTransferSession() {
    return { sftp: this.requireSftp(), generation: this.connectionGeneration };
  }
  assertTransferSession(session) {
    if (session.generation !== this.connectionGeneration || this.sftp !== session.sftp || !this.isConnected()) {
      throw new Error("Connection changed during transfer; the transfer was stopped");
    }
  }
  isCurrentTransferSession(session) {
    return session.generation === this.connectionGeneration && this.sftp === session.sftp && this.isConnected();
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
      const base = path__namespace.basename(src);
      for (; ; ) {
        const name = await uniqueName(
          destDir,
          base,
          (dir, entry) => path__namespace.join(dir, entry),
          async (candidate) => {
            try {
              await fs.promises.lstat(candidate);
              return true;
            } catch (err) {
              if (err.code === "ENOENT") return false;
              throw err;
            }
          }
        );
        try {
          await fs.promises.cp(src, path__namespace.join(destDir, name), {
            recursive: true,
            force: false,
            errorOnExist: true
          });
          break;
        } catch (err) {
          const code = err.code;
          if (code !== "EEXIST" && code !== "ERR_FS_CP_EEXIST") throw err;
        }
      }
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
    const session = this.captureTransferSession();
    return this.withLock(async () => {
      this.assertTransferSession(session);
      for (const src of localPaths) {
        this.assertTransferSession(session);
        const st = await fs.promises.lstat(src);
        const base = path__namespace.basename(src);
        const destName = await uniqueName(
          remoteDir,
          base,
          (d, n) => path__namespace.posix.join(d, n),
          (p) => sftpExists(session.sftp, p)
        );
        const dest = path__namespace.posix.join(remoteDir, destName);
        if (st.isDirectory()) await this.uploadDir(session, src, dest);
        else await this.uploadFile(session, src, dest, destName);
      }
    });
  }
  async uploadDir(session, localDir, remoteDir) {
    this.assertTransferSession(session);
    await sftpCall((done) => session.sftp.mkdir(remoteDir, done));
    const dirents = await fs.promises.readdir(localDir, { withFileTypes: true });
    for (const d of dirents) {
      this.assertTransferSession(session);
      const full = path__namespace.join(localDir, d.name);
      const dest = path__namespace.posix.join(remoteDir, d.name);
      if (d.isDirectory()) await this.uploadDir(session, full, dest);
      else if (d.isFile()) await this.uploadFile(session, full, dest, d.name);
    }
  }
  async uploadFile(session, localPath, remotePath, name) {
    const id = String(++this.transferSeq);
    let total = 0;
    let transferred = 0;
    let tempPath = null;
    try {
      this.assertTransferSession(session);
      const st = await fs.promises.stat(localPath);
      total = st.size;
      this.emitTransfer({ id, name, direction: "up", state: "queued", transferred: 0, total });
      this.emitTransfer({ id, name, direction: "up", state: "active", transferred: 0, total });
      tempPath = path__namespace.posix.join(
        path__namespace.posix.dirname(remotePath),
        `.droplet-${crypto.randomUUID()}.part`
      );
      const source = fs.createReadStream(localPath);
      const counter = this.counter(id, name, "up", total, (count) => transferred = count);
      const dest = session.sftp.createWriteStream(tempPath, { flags: "wx" });
      await promises.pipeline(source, counter, dest);
      this.assertTransferSession(session);
      if (await sftpExists(session.sftp, remotePath)) {
        throw new Error(`Destination already exists: ${remotePath}`);
      }
      await sftpCall((done) => session.sftp.rename(tempPath, remotePath, done));
      tempPath = null;
      this.emitTransfer({ id, name, direction: "up", state: "done", transferred: total, total });
    } catch (err) {
      let message = errmsg(err);
      if (tempPath && this.isCurrentTransferSession(session)) {
        try {
          await sftpCall((done) => session.sftp.unlink(tempPath, done));
          tempPath = null;
        } catch {
          message += ` (partial remote file may remain at ${tempPath})`;
        }
      } else if (tempPath) {
        message += ` (partial remote file may remain at ${tempPath})`;
      }
      this.emitTransfer({
        id,
        name,
        direction: "up",
        state: "error",
        transferred,
        total,
        error: message
      });
    }
  }
  async download(remotePaths, localDir) {
    const session = this.captureTransferSession();
    return this.withLock(async () => {
      this.assertTransferSession(session);
      for (const src of remotePaths) {
        this.assertTransferSession(session);
        const base = path__namespace.posix.basename(src);
        const destName = await uniqueName(
          localDir,
          base,
          (d, n) => path__namespace.join(d, n),
          (p) => fs.promises.access(p).then(() => true).catch(() => false)
        );
        const dest = path__namespace.join(localDir, destName);
        const st = await promisify((cb) => session.sftp.lstat(src, cb));
        if (st.isDirectory() && !st.isSymbolicLink()) await this.downloadDir(session, src, dest);
        else await this.downloadFile(session, src, dest, destName);
      }
    });
  }
  async downloadDir(session, remoteDir, localDir) {
    this.assertTransferSession(session);
    await fs.promises.mkdir(localDir, { recursive: true });
    const list = await promisify(
      (cb) => session.sftp.readdir(remoteDir, cb)
    );
    for (const entry of list) {
      this.assertTransferSession(session);
      const src = path__namespace.posix.join(remoteDir, entry.filename);
      const dest = path__namespace.join(localDir, entry.filename);
      if (entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink()) {
        await this.downloadDir(session, src, dest);
      } else if (!entry.attrs.isSymbolicLink()) {
        await this.downloadFile(session, src, dest, entry.filename);
      }
    }
  }
  async downloadFile(session, remotePath, localPath, name) {
    const id = String(++this.transferSeq);
    let total = 0;
    let transferred = 0;
    const tempPath = path__namespace.join(path__namespace.dirname(localPath), `.droplet-${crypto.randomUUID()}.part`);
    let tempExists = false;
    try {
      this.assertTransferSession(session);
      const st = await promisify((cb) => session.sftp.stat(remotePath, cb));
      total = st.size;
      this.emitTransfer({ id, name, direction: "down", state: "queued", transferred: 0, total });
      this.emitTransfer({ id, name, direction: "down", state: "active", transferred: 0, total });
      const source = session.sftp.createReadStream(remotePath);
      const counter = this.counter(id, name, "down", total, (count) => transferred = count);
      const dest = fs.createWriteStream(tempPath, { flags: "wx" });
      tempExists = true;
      await promises.pipeline(source, counter, dest);
      this.assertTransferSession(session);
      await fs.promises.copyFile(tempPath, localPath, fs.constants.COPYFILE_EXCL);
      await fs.promises.rm(tempPath, { force: true });
      tempExists = false;
      this.emitTransfer({ id, name, direction: "down", state: "done", transferred: total, total });
    } catch (err) {
      if (tempExists) await fs.promises.rm(tempPath, { force: true }).catch(() => void 0);
      this.emitTransfer({
        id,
        name,
        direction: "down",
        state: "error",
        transferred,
        total,
        error: errmsg(err)
      });
    }
  }
  counter(id, name, direction, total, onProgress) {
    let transferred = 0;
    let lastEmit = 0;
    return new stream.Transform({
      transform: (chunk, _enc, cb) => {
        transferred += chunk.length;
        onProgress(transferred);
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
    transfer: (update) => send(CH.transferUpdate, update),
    shellData: (chunk) => send(CH.shellData, chunk),
    shellClosed: (event) => send(CH.shellClosed, event)
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
  electron.ipcMain.handle(CH.shellOpen, (_e, options) => manager.openShell(options));
  electron.ipcMain.handle(CH.shellWrite, (_e, data) => manager.writeShell(data));
  electron.ipcMain.handle(
    CH.shellResize,
    (_e, cols, rows) => manager.resizeShell(cols, rows)
  );
  electron.ipcMain.handle(CH.shellClose, () => manager.closeShell());
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
