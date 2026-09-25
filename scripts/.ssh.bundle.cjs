var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scripts/electron-stub.cjs
var require_electron_stub = __commonJS({
  "scripts/electron-stub.cjs"(exports2, module2) {
    var fs = require("fs");
    var os = require("os");
    var path2 = require("path");
    var userData = path2.join(os.tmpdir(), "droplet-files-e2e-userdata");
    fs.mkdirSync(userData, { recursive: true });
    module2.exports = {
      app: {
        getPath: () => userData
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s) => Buffer.from(String(s), "utf8"),
        decryptString: (b) => Buffer.from(b).toString("utf8")
      }
    };
  }
});

// src/main/ssh.ts
var ssh_exports = {};
__export(ssh_exports, {
  SshManager: () => SshManager
});
module.exports = __toCommonJS(ssh_exports);
var import_ssh2 = require("ssh2");
var import_crypto2 = require("crypto");
var import_fs2 = require("fs");
var path = __toESM(require("path"));
var import_stream = require("stream");
var import_promises = require("stream/promises");

// src/main/store.ts
var import_electron = __toESM(require_electron_stub());
var import_crypto = require("crypto");
var import_fs = require("fs");
var import_path = require("path");
var PROFILES_FILE = "profiles.json";
var HOSTS_FILE = "trusted-hosts.json";
function dataFile(name) {
  const dir = import_electron.app.getPath("userData");
  if (!(0, import_fs.existsSync)(dir)) (0, import_fs.mkdirSync)(dir, { recursive: true });
  return (0, import_path.join)(dir, name);
}
function readJson(name, fallback) {
  try {
    const file = dataFile(name);
    if (!(0, import_fs.existsSync)(file)) return fallback;
    return JSON.parse((0, import_fs.readFileSync)(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(name, data) {
  (0, import_fs.writeFileSync)(dataFile(name), JSON.stringify(data, null, 2), "utf8");
}
var Store = {
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
      id: existing?.id ?? (0, import_crypto.randomUUID)(),
      passphraseEnc: void 0
    };
    if (existing?.passphraseEnc) stored.passphraseEnc = existing.passphraseEnc;
    if (profile.rememberPassphrase && passphrase) {
      if (import_electron.safeStorage.isEncryptionAvailable()) {
        stored.passphraseEnc = import_electron.safeStorage.encryptString(passphrase).toString("base64");
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
    if (!import_electron.safeStorage.isEncryptionAvailable()) return;
    profile.passphraseEnc = import_electron.safeStorage.encryptString(passphrase).toString("base64");
    writeJson(PROFILES_FILE, { profiles });
  },
  getPassphrase(profileId) {
    const profile = Store.getProfile(profileId);
    if (!profile?.passphraseEnc) return void 0;
    try {
      return import_electron.safeStorage.decryptString(Buffer.from(profile.passphraseEnc, "base64"));
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

// src/main/ssh.ts
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
async function uniqueName(dir, name, join3, exists) {
  if (!await exists(join3(dir, name))) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let i = 1;
  while (true) {
    const candidate = `${stem} (${i})${ext}`;
    if (!await exists(join3(dir, candidate))) return candidate;
    i++;
  }
}
function sftpExists(sftp, p) {
  return new Promise((resolve) => sftp.stat(p, (err) => resolve(!err)));
}
var PROGRESS_INTERVAL_MS = 100;
var SshManager = class {
  constructor(events) {
    this.events = events;
  }
  client = null;
  sftp = null;
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
    await this.disconnect();
    const label = `${input.username}@${input.host}:${input.port}`;
    this.setStatus("connecting", label);
    let privateKey;
    try {
      privateKey = await import_fs2.promises.readFile(input.keyPath);
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
    const client = new import_ssh2.Client();
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
        /host.*verif|host.*key/i.test(message) ? "Host key verification failed \u2014 the server identity could not be confirmed" : message
      );
    }
  }
  async disconnect() {
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
    if (this.status.state !== "disconnected") this.setStatus("disconnected");
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
    const fingerprint = "SHA256:" + (0, import_crypto2.createHash)("sha256").update(rawKey).digest("base64").replace(/=+$/, "");
    const hostPort = `${input.host}:${input.port}`;
    const trusted = Store.getTrustedFingerprint(hostPort);
    if (trusted === fingerprint) return finish(true);
    const requestId = (0, import_crypto2.randomUUID)();
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
    if (!client || this.status.state !== "connected") {
      throw new Error("Not connected to a server");
    }
    this.endShell(void 0, true);
    const stream = await promisify(
      (cb) => client.shell(
        {
          term: "xterm-256color",
          cols: Math.max(2, Math.floor(options.cols)),
          rows: Math.max(1, Math.floor(options.rows))
        },
        cb
      )
    );
    this.shellStream = stream;
    stream.setEncoding("utf8");
    stream.stderr.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (this.shellStream === stream) this.events.shellData(chunk);
    });
    stream.stderr.on("data", (chunk) => {
      if (this.shellStream === stream) this.events.shellData(chunk);
    });
    const finish = (reason) => {
      if (this.shellStream !== stream) return;
      this.shellStream = null;
      this.events.shellClosed({ reason });
    };
    stream.on("error", (err) => finish(err.message));
    stream.on("close", () => finish());
  }
  /** Sends keystrokes to the shell; ignored when no session is open */
  writeShell(data) {
    const stream = this.shellStream;
    if (!stream) return;
    stream.write(data);
  }
  /** Tells the remote PTY about a terminal resize; ignored when no session is open */
  resizeShell(cols, rows) {
    const stream = this.shellStream;
    if (!stream) return;
    stream.setWindow(Math.max(1, Math.floor(rows)), Math.max(2, Math.floor(cols)), 0, 0);
  }
  closeShell() {
    this.endShell();
  }
  /** Ends the shell channel; `silent` skips the shellClosed event (session swap) */
  endShell(reason, silent = false) {
    const stream = this.shellStream;
    if (!stream) return;
    this.shellStream = null;
    try {
      stream.destroy();
    } catch {
    }
    if (!silent) this.events.shellClosed({ reason });
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
      parent: dir === "/" ? null : path.posix.dirname(dir) || "/",
      entries
    };
  }
  async listLocal(dir) {
    let dirents;
    try {
      dirents = await import_fs2.promises.readdir(dir, { withFileTypes: true });
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
        const full = path.join(dir, d.name);
        let isDir = d.isDirectory();
        let size = 0;
        let mtime = 0;
        try {
          const st = await import_fs2.promises.stat(full);
          isDir = st.isDirectory();
          size = st.size;
          mtime = Math.floor(st.mtimeMs / 1e3);
        } catch {
        }
        return { name: d.name, isDir, size, mtime, isSymlink: d.isSymbolicLink() };
      })
    );
    entries.sort(compareEntries);
    const parent = path.dirname(dir);
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
          const dir = (0, import_fs2.opendirSync)(drive);
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
      await import_fs2.promises.mkdir(dir);
      return;
    }
    const sftp = this.requireSftp();
    await sftpCall((done) => sftp.mkdir(dir, done));
  }
  async rename(side, from, to) {
    if (side === "local") {
      await import_fs2.promises.rename(from, to);
      return;
    }
    const sftp = this.requireSftp();
    await sftpCall((done) => sftp.rename(from, to, done));
  }
  async remove(side, target) {
    if (side === "local") {
      const st = await import_fs2.promises.lstat(target);
      if (st.isDirectory() && !st.isSymbolicLink()) await import_fs2.promises.rm(target, { recursive: true });
      else await import_fs2.promises.unlink(target);
      return;
    }
    await this.remoteRemove(this.requireSftp(), target);
  }
  async remoteRemove(sftp, target) {
    const st = await promisify((cb) => sftp.lstat(target, cb));
    if (st.isDirectory() && !st.isSymbolicLink()) {
      const list = await promisify((cb) => sftp.readdir(target, cb));
      for (const entry of list) {
        await this.remoteRemove(sftp, path.posix.join(target, entry.filename));
      }
      await sftpCall((done) => sftp.rmdir(target, done));
    } else {
      await sftpCall((done) => sftp.unlink(target, done));
    }
  }
  async copyLocal(sources, destDir) {
    for (const src of sources) {
      const dest = path.join(destDir, path.basename(src));
      await import_fs2.promises.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
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
        const st = await import_fs2.promises.lstat(src);
        const base = path.basename(src);
        const destName = await uniqueName(
          remoteDir,
          base,
          (d, n) => path.posix.join(d, n),
          (p) => sftpExists(sftp, p)
        );
        const dest = path.posix.join(remoteDir, destName);
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
    const dirents = await import_fs2.promises.readdir(localDir, { withFileTypes: true });
    for (const d of dirents) {
      const full = path.join(localDir, d.name);
      const dest = path.posix.join(remoteDir, d.name);
      if (d.isDirectory()) await this.uploadDir(full, dest);
      else if (d.isFile()) await this.uploadFile(full, dest, d.name);
    }
  }
  async uploadFile(localPath, remotePath, name) {
    const sftp = this.requireSftp();
    const id = String(++this.transferSeq);
    let total = 0;
    try {
      const st = await import_fs2.promises.stat(localPath);
      total = st.size;
      this.emitTransfer({ id, name, direction: "up", state: "queued", transferred: 0, total });
      this.emitTransfer({ id, name, direction: "up", state: "active", transferred: 0, total });
      const source = (0, import_fs2.createReadStream)(localPath);
      const counter = this.counter(id, name, "up", total);
      const dest = sftp.createWriteStream(remotePath);
      await (0, import_promises.pipeline)(source, counter, dest);
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
        const base = path.posix.basename(src);
        const destName = await uniqueName(
          localDir,
          base,
          (d, n) => path.join(d, n),
          (p) => import_fs2.promises.access(p).then(() => true).catch(() => false)
        );
        const dest = path.join(localDir, destName);
        const st = await promisify((cb) => sftp.lstat(src, cb));
        if (st.isDirectory() && !st.isSymbolicLink()) await this.downloadDir(src, dest);
        else await this.downloadFile(src, dest, destName);
      }
    });
  }
  async downloadDir(remoteDir, localDir) {
    const sftp = this.requireSftp();
    await import_fs2.promises.mkdir(localDir, { recursive: true });
    const list = await promisify((cb) => sftp.readdir(remoteDir, cb));
    for (const entry of list) {
      const src = path.posix.join(remoteDir, entry.filename);
      const dest = path.join(localDir, entry.filename);
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
      const dest = (0, import_fs2.createWriteStream)(localPath);
      await (0, import_promises.pipeline)(source, counter, dest);
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
    return new import_stream.Transform({
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
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SshManager
});
