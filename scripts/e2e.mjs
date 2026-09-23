/**
 * Loopback end-to-end test: runs the real SshManager (src/main/ssh.ts) against
 * a local ssh2 server with an in-memory SFTP filesystem. No network required.
 *
 * Usage: node scripts/e2e.mjs
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const {
  Server,
  utils: {
    parseKey,
    sftp: { STATUS_CODE, OPEN_MODE }
  }
} = require('ssh2')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const abs = (p) => path.join(root, p)

// Fresh user-data dir so host-key trust state starts empty every run
const USERDATA = path.join(require('os').tmpdir(), 'droplet-files-e2e-userdata')
fs.rmSync(USERDATA, { recursive: true, force: true })

// ---------------------------------------------------------------- assertions

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${extra}` : ''}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

// ------------------------------------------------------------------- MemFS

function dirNode() {
  const now = Date.now()
  return { type: 'dir', mode: 0o40755, uid: 0, gid: 0, atime: now, mtime: now }
}

function fileNode(content) {
  const now = Date.now()
  return { type: 'file', mode: 0o100644, uid: 0, gid: 0, atime: now, mtime: now, content }
}

class MemFS {
  constructor() {
    this.nodes = new Map([['/', dirNode()]])
  }

  normalize(p) {
    if (p === undefined || p === null || p === '' || p === '.') p = '/'
    const abs = p.startsWith('/') ? p : `/${p}`
    const parts = []
    for (const seg of abs.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    return `/${parts.join('/')}`
  }

  parent(p) {
    const idx = p.lastIndexOf('/')
    return idx <= 0 ? '/' : p.slice(0, idx)
  }

  basename(p) {
    return p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1)
  }

  get(p) {
    return this.nodes.get(p)
  }

  children(dir) {
    const prefix = dir === '/' ? '/' : `${dir}/`
    const out = []
    for (const [p, node] of this.nodes) {
      if (p === dir) continue
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (!rest.includes('/')) out.push([rest, node])
    }
    return out.sort((a, b) => a[0].localeCompare(b[0]))
  }

  hasChildren(dir) {
    return this.children(dir).length > 0
  }

  mkdirAt(p, mode) {
    if (this.nodes.has(p)) return false
    const parent = this.parent(p)
    if (!this.nodes.has(parent) || this.nodes.get(parent).type !== 'dir') return false
    const node = dirNode()
    if (mode) node.mode = 0o40000 | (mode & 0o7777)
    this.nodes.set(p, node)
    return true
  }

  createFile(p, content) {
    const parent = this.parent(p)
    if (!this.nodes.has(parent) || this.nodes.get(parent).type !== 'dir') return null
    const node = fileNode(content ?? Buffer.alloc(0))
    this.nodes.set(p, node)
    return node
  }

  attrs(node) {
    return {
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      size: node.type === 'file' ? node.content.length : 0,
      atime: Math.floor(node.atime / 1000),
      mtime: Math.floor(node.mtime / 1000)
    }
  }

  longname(name, node) {
    const perms = node.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--'
    const size = node.type === 'file' ? node.content.length : 0
    return `${perms} 1 root root ${size} Jan  1 00:00 ${name}`
  }
}

function writeAt(node, offset, data) {
  const end = offset + data.length
  let buf = node.content
  if (end > buf.length) {
    const nb = Buffer.alloc(end)
    buf.copy(nb)
    buf = nb
    node.content = nb
  }
  data.copy(buf, offset)
}

// ------------------------------------------------------- SFTP server wiring

function wireSftp(sftp, mem) {
  let nextHandle = 1
  const open = new Map()

  const handleFor = (rec) => {
    const id = nextHandle++
    open.set(id, rec)
    const h = Buffer.alloc(4)
    h.writeUInt32BE(id, 0)
    return h
  }
  const idOf = (handle) => (handle.length === 4 ? handle.readUInt32BE(0) : -1)
  const nofile = (reqid) => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)

  sftp
    .on('REALPATH', (reqid, p) => {
      const resolved = mem.normalize(p)
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: mem.attrs(dirNode()) }])
    })
    .on('STAT', (reqid, p) => {
      const node = mem.get(mem.normalize(p))
      if (!node) return nofile(reqid)
      sftp.attrs(reqid, mem.attrs(node))
    })
    .on('LSTAT', (reqid, p) => {
      const node = mem.get(mem.normalize(p))
      if (!node) return nofile(reqid)
      sftp.attrs(reqid, mem.attrs(node))
    })
    .on('FSTAT', (reqid, handle) => {
      const rec = open.get(idOf(handle))
      const node = rec && mem.get(rec.path)
      if (!node) return nofile(reqid)
      sftp.attrs(reqid, mem.attrs(node))
    })
    .on('OPENDIR', (reqid, p) => {
      const dir = mem.normalize(p)
      const node = mem.get(dir)
      if (!node) return nofile(reqid)
      if (node.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
      sftp.handle(reqid, handleFor({ type: 'dir', path: dir, pos: 0 }))
    })
    .on('READDIR', (reqid, handle) => {
      const rec = open.get(idOf(handle))
      if (!rec || rec.type !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
      if (rec.pos === 0) {
        rec.pos = 1
        const dnode = dirNode()
        const names = [
          { name: '.', node: mem.get(rec.path) ?? dnode },
          { name: '..', node: mem.get(mem.parent(rec.path)) ?? dnode },
          ...mem.children(rec.path).map(([name, node]) => ({ name, node }))
        ]
        return sftp.name(
          reqid,
          names.map(({ name, node }) => ({
            filename: name,
            longname: mem.longname(name, node),
            attrs: mem.attrs(node)
          }))
        )
      }
      sftp.status(reqid, STATUS_CODE.EOF)
    })
    .on('CLOSE', (reqid, handle) => {
      open.delete(idOf(handle))
      sftp.status(reqid, STATUS_CODE.OK)
    })
    .on('OPEN', (reqid, filename, pflags) => {
      const p = mem.normalize(filename)
      let node = mem.get(p)
      const wantsWrite = (pflags & OPEN_MODE.WRITE) === OPEN_MODE.WRITE
      if (wantsWrite) {
        if (!node && (pflags & OPEN_MODE.CREAT)) node = mem.createFile(p)
        if (!node) return nofile(reqid)
        if (node.type !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
        if ((pflags & OPEN_MODE.TRUNC) === OPEN_MODE.TRUNC) node.content = Buffer.alloc(0)
        return sftp.handle(reqid, handleFor({ type: 'file', path: p }))
      }
      if (!node || node.type !== 'file') return nofile(reqid)
      sftp.handle(reqid, handleFor({ type: 'file', path: p }))
    })
    .on('READ', (reqid, handle, offset, len) => {
      const rec = open.get(idOf(handle))
      const node = rec && mem.get(rec.path)
      if (!node || node.type !== 'file') return nofile(reqid)
      if (offset >= node.content.length) return sftp.status(reqid, STATUS_CODE.EOF)
      sftp.data(reqid, node.content.subarray(offset, offset + len))
    })
    .on('WRITE', (reqid, handle, offset, data) => {
      const rec = open.get(idOf(handle))
      const node = rec && mem.get(rec.path)
      if (!node || node.type !== 'file') return nofile(reqid)
      writeAt(node, offset, data)
      node.mtime = Date.now()
      sftp.status(reqid, STATUS_CODE.OK)
    })
    .on('MKDIR', (reqid, p, attrs) => {
      const ok = mem.mkdirAt(mem.normalize(p), attrs && attrs.mode)
      sftp.status(reqid, ok ? STATUS_CODE.OK : STATUS_CODE.FAILURE)
    })
    .on('REMOVE', (reqid, p) => {
      const target = mem.normalize(p)
      const node = mem.get(target)
      if (!node) return nofile(reqid)
      if (node.type === 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
      mem.nodes.delete(target)
      sftp.status(reqid, STATUS_CODE.OK)
    })
    .on('RMDIR', (reqid, p) => {
      const target = mem.normalize(p)
      const node = mem.get(target)
      if (!node) return nofile(reqid)
      if (node.type !== 'dir' || mem.hasChildren(target)) {
        return sftp.status(reqid, STATUS_CODE.FAILURE)
      }
      mem.nodes.delete(target)
      sftp.status(reqid, STATUS_CODE.OK)
    })
    .on('RENAME', (reqid, oldPath, newPath) => {
      const src = mem.normalize(oldPath)
      const dst = mem.normalize(newPath)
      const node = mem.get(src)
      if (!node) return nofile(reqid)
      const existing = mem.get(dst)
      if (existing) {
        if (existing.type === 'dir' && mem.hasChildren(dst)) {
          return sftp.status(reqid, STATUS_CODE.FAILURE)
        }
        mem.nodes.delete(dst)
      }
      if (!mem.nodes.has(mem.parent(dst))) return sftp.status(reqid, STATUS_CODE.FAILURE)
      mem.nodes.delete(src)
      mem.nodes.set(dst, node)
      sftp.status(reqid, STATUS_CODE.OK)
    })
    .on('SETSTAT', (reqid, p, attrs) => {
      const node = mem.get(mem.normalize(p))
      if (!node) return nofile(reqid)
      if (attrs.mode !== undefined) node.mode = attrs.mode
      if (attrs.mtime !== undefined) node.mtime = attrs.mtime * 1000
      if (attrs.atime !== undefined) node.atime = attrs.atime * 1000
      if (node.type === 'file' && attrs.size !== undefined) {
        const buf = Buffer.alloc(attrs.size)
        node.content.copy(buf, 0, 0, Math.min(node.content.length, attrs.size))
        node.content = buf
      }
      sftp.status(reqid, STATUS_CODE.OK)
    })
}

// ---------------------------------------------------------------- key material

function generateKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  return privateKey
}

// ---------------------------------------------------------------- helpers

const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'droplet-files-e2e-'))

function seedLocal(dir) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>\n')
  fs.writeFileSync(path.join(dir, 'assets', 'app.css'), 'body{color:red}\n')
}

function compareDirs(a, b) {
  const walk = (base, rel) => {
    const left = path.join(base, rel)
    const names = fs.readdirSync(left).sort()
    const rightNames = fs.readdirSync(path.join(b, rel)).sort()
    if (JSON.stringify(names) !== JSON.stringify(rightNames)) return false
    for (const name of names) {
      const la = path.join(left, name)
      const ra = path.join(b, rel, name)
      if (fs.statSync(la).isDirectory()) {
        if (!fs.statSync(ra).isDirectory()) return false
        if (!walk(base, path.join(rel, name))) return false
      } else {
        if (fs.statSync(ra).isDirectory()) return false
        if (!fs.readFileSync(la).equals(fs.readFileSync(ra))) return false
      }
    }
    return true
  }
  return walk(a, '.')
}

// ================================================================ main test

async function main() {
  // 1. Bundle the real SshManager for plain Node
  section('bundle')
  const outfile = abs('scripts/.ssh.bundle.cjs')
  await build({
    entryPoints: [abs('src/main/ssh.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['ssh2'],
    alias: { electron: abs('scripts/electron-stub.cjs') },
    outfile,
    logLevel: 'warning'
  })
  check('esbuild bundled src/main/ssh.ts', fs.existsSync(outfile))
  const { SshManager } = require(outfile)
  check('SshManager exported', typeof SshManager === 'function')

  // 2. Start loopback SSH server with in-memory SFTP
  const mem = new MemFS()
  mem.createFile('/readme.txt', Buffer.from('hello droplet\n'))
  mem.mkdirAt('/data')
  mem.createFile('/data/nested.txt', Buffer.from('nested\n'))

  const hostKeyPem = generateKeyPem()
  check('server host key parses', !!parseKey(hostKeyPem))

  const server = new Server({ hostKeys: [hostKeyPem] }, (client) => {
    // The client disconnects mid-handshake when it rejects our host key;
    // that's an expected test scenario, not a server crash.
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') ctx.accept()
      else ctx.reject()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => wireSftp(acceptSftp(), mem))
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  check(`server listening on 127.0.0.1:${port}`, port > 0)

  // 3. Client key on disk
  const keyPath = path.join(tmp, 'id_test')
  fs.writeFileSync(keyPath, generateKeyPem(), { mode: 0o600 })

  // 4. Drive SshManager
  const statuses = []
  const transfers = []
  const transferLog = []
  const hostKeyRequests = []
  // 'accept' | 'reject' | 'hold' — how the test answers host-key prompts
  let hostKeyMode = 'accept'
  const manager = new SshManager({
    status: (s) => statuses.push(s),
    hostKey: (req) => {
      hostKeyRequests.push(req)
      if (hostKeyMode !== 'hold') manager.respondHostKey(req.requestId, hostKeyMode === 'accept')
    },
    transfer: (u) => {
      transferLog.push({ ...u })
      const idx = transfers.findIndex((t) => t.id === u.id)
      if (idx === -1) transfers.push(u)
      else transfers[idx] = u
    }
  })

  const connectInput = {
    host: '127.0.0.1',
    port,
    username: 'tester',
    keyPath,
    rememberPassphrase: false
  }

  section('connect + host key trust')
  await manager.connect(connectInput)
  check('connected (status event)', statuses.some((s) => s.state === 'connected'))
  check('manager reports isConnected', manager.isConnected())
  check('exactly one host-key request', hostKeyRequests.length === 1)
  const fp = hostKeyRequests[0]?.fingerprint
  check('fingerprint is SHA256 format', /^SHA256:[A-Za-z0-9+/]+$/.test(fp ?? ''), fp)
  check('request marks host unknown (changed=false)', hostKeyRequests[0]?.changed === false)

  section('trusted host on reconnect')
  await manager.disconnect()
  await manager.connect(connectInput)
  check('second connect sends no host-key request', hostKeyRequests.length === 1)
  await manager.disconnect()

  section('changed host key rejected')
  const hostsFile = path.join(USERDATA, 'trusted-hosts.json')
  const trustKey = `127.0.0.1:${port}`
  fs.writeFileSync(hostsFile, JSON.stringify({ [trustKey]: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
  hostKeyMode = 'reject'
  let rejected = ''
  try {
    await manager.connect(connectInput)
  } catch (err) {
    rejected = err.message
  }
  check('connect rejected on tampered trust', /Host key verification failed/.test(rejected), rejected)
  check('request flagged as changed (possible MITM)', hostKeyRequests.at(-1)?.changed === true)
  hostKeyMode = 'accept'
  await manager.disconnect()

  section('trusting a changed key replaces the stored fingerprint')
  fs.writeFileSync(hostsFile, JSON.stringify({ [trustKey]: 'SHA256:ZpZpZpZpZpZpZpZpZpZpZpZpZpZpZpZpZpZpZpA' }))
  await manager.connect(connectInput)
  check('connect ok after user trusts changed key', manager.isConnected())
  await manager.disconnect()
  const countBefore = hostKeyRequests.length
  await manager.connect(connectInput)
  check('replaced fingerprint now trusted (no new request)', hostKeyRequests.length === countBefore)

  section('remote listing')
  const rootList = await manager.listRemote('/')
  const names = rootList.entries.map((e) => e.name)
  check('parent of / is null', rootList.parent === null)
  check("contains 'readme.txt'", names.includes('readme.txt'))
  check("contains 'data' dir", names.includes('data'))
  check("'.' and '..' filtered out", !names.includes('.') && !names.includes('..'))
  const readme = rootList.entries.find((e) => e.name === 'readme.txt')
  check('readme.txt size', readme?.size === 14, readme?.size)
  const dataListing = await manager.listRemote('/data')
  check('parent of /data is /', dataListing.parent === '/')
  check("/data contains 'nested.txt'", dataListing.entries.some((e) => e.name === 'nested.txt'))
  const home = await manager.remoteHome()
  check('remoteHome resolves to /', home === '/', home)

  section('local listing')
  const localHome = manager.localHome()
  check('localHome is a directory', fs.existsSync(localHome))
  const localList = await manager.listLocal(tmp)
  check('localRoots non-empty', manager.localRoots().length > 0)

  section('upload file with progress')
  const bigSize = 200 * 1024
  const bigContent = crypto.randomBytes(bigSize)
  const bigPath = path.join(tmp, 'up.bin')
  fs.writeFileSync(bigPath, bigContent)
  await manager.upload([bigPath], '/')
  const uploaded = mem.get('/up.bin')
  check('uploaded file exists on server', uploaded?.type === 'file')
  check('uploaded content matches (200 KB)', uploaded && uploaded.content.equals(bigContent))
  const upDone = transfers.find((t) => t.name === 'up.bin' && t.state === 'done')
  check('upload emitted done progress', !!upDone)
  check('upload done carries full byte count', upDone?.total === bigSize && upDone?.transferred === bigSize)
  check(
    'upload emitted active progress reaching total',
    transferLog.some((t) => t.name === 'up.bin' && t.state === 'active' && t.transferred === t.total)
  )
  check(
    'upload progress event order: queued → active → done',
    (() => {
      const seq = transferLog.filter((t) => t.name === 'up.bin').map((t) => t.state)
      return seq[0] === 'queued' && seq.at(-1) === 'done' && seq.includes('active')
    })(),
    transferLog.filter((t) => t.name === 'up.bin').map((t) => t.state).join(',')
  )

  section('upload name collision gets suffixed')
  const readLocal = path.join(tmp, 'readme.txt')
  fs.writeFileSync(readLocal, Buffer.from('local copy\n'))
  await manager.upload([readLocal], '/')
  check('original untouched', mem.get('/readme.txt').content.equals(Buffer.from('hello droplet\n')))
  check('collision saved as "readme (1).txt"', mem.get('/readme (1).txt')?.type === 'file')
  check(
    'collision content correct',
    mem.get('/readme (1).txt')?.content.equals(Buffer.from('local copy\n'))
  )

  section('recursive folder upload')
  const siteDir = path.join(tmp, 'site')
  seedLocal(siteDir)
  await manager.upload([siteDir], '/')
  check('/site created', mem.get('/site')?.type === 'dir')
  check('/site/index.html uploaded', mem.get('/site/index.html')?.type === 'file')
  check('/site/assets/app.css uploaded', mem.get('/site/assets/app.css')?.type === 'file')

  section('recursive folder download + byte compare')
  const outDir = path.join(tmp, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  await manager.download(['/site'], outDir)
  check('downloaded tree matches uploaded tree', compareDirs(siteDir, path.join(outDir, 'site')))

  section('single file download')
  await manager.upload([bigPath], '/data')
  await manager.download(['/data/up.bin'], outDir)
  const backPath = path.join(outDir, 'up.bin')
  check('single download bytes match', fs.existsSync(backPath) && fs.readFileSync(backPath).equals(bigContent))

  section('remote mkdir / rename / recursive remove')
  await manager.mkdir('remote', '/newdir')
  check('mkdir created /newdir', mem.get('/newdir')?.type === 'dir')
  await manager.rename('remote', '/data/nested.txt', '/data/renamed.txt')
  check('rename moved the file', !mem.get('/data/nested.txt') && mem.get('/data/renamed.txt')?.type === 'file')
  await manager.remove('remote', '/site')
  check('recursive remove deleted /site', mem.get('/site') === undefined)
  check('recursive remove deleted /site/assets/app.css', mem.get('/site/assets/app.css') === undefined)
  await manager.remove('remote', '/up.bin')
  check('remove deleted a file', mem.get('/up.bin') === undefined)

  section('local file ops')
  const copyDst = path.join(tmp, 'copydst')
  fs.mkdirSync(copyDst, { recursive: true })
  await manager.copyLocal([readLocal], copyDst)
  check('copyLocal copied the file', fs.readFileSync(path.join(copyDst, 'readme.txt')).equals(Buffer.from('local copy\n')))
  let mkdirFailed = false
  try {
    await manager.mkdir('remote', '/readme.txt/nested')
  } catch {
    mkdirFailed = true
  }
  check('mkdir under a file fails with an error', mkdirFailed)

  section('disconnect')
  await manager.disconnect()
  check('status reports disconnected', statuses.at(-1).state === 'disconnected')
  let listFailed = false
  try {
    await manager.listRemote('/')
  } catch (err) {
    listFailed = /Not connected/.test(err.message)
  }
  check('operations after disconnect throw', listFailed)

  // ---------------------------------------------------------------- summary
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('Failures:', failures.join('; '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('\nE2E crashed:', err)
  process.exit(1)
})
