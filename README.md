# Droplet Files

A desktop SFTP client for connecting to DigitalOcean droplets (or any SSH server) and moving files — browse both machines side by side, drag & drop between them, and watch transfers with progress bars.

Built with Electron + React + TypeScript and the [`ssh2`](https://github.com/mscdex/ssh2) library (SFTP subsystem).

## Quick start

```bash
npm install
npm run dev
```

> If `npm install` finishes without downloading the Electron binary (offline/CI), run
> `node node_modules/electron/install.js` once to fetch it.

### Connecting

1. **Host** — your droplet's IP (DigitalOcean → Droplets → copy the IPv4), port `22`
2. **User** — `root` (or your deploy user)
3. **Private key** — the OpenSSH private key whose public half is registered with the droplet,
   e.g. `C:\Users\you\.ssh\id_ed25519` (use the `…` button to browse)
4. Press **Connect**. The first time, you'll be shown the server's **SHA256 host fingerprint** —
   verify it against your provider's console before trusting. The app then remembers the key and
   warns loudly if it ever changes (possible man-in-the-middle attack).

**💾 Save** stores the connection as a profile (host, port, user, key path). Tick **Remember** to
also store the key passphrase, encrypted via your OS keychain (`safeStorage`).

### Moving files

- **Drag rows** from one pane to the other to upload/download (folders are transferred recursively)
- **Drag files from Explorer** into a pane to copy them there
- Name collisions don't overwrite — they get `name (1).ext` style suffixes
- Toolbar: new folder, rename (F2), delete (Del), refresh, up
- The bottom queue shows every transfer with progress; failed transfers don't block the rest

### Droplet command line

- Press **⌨ Terminal** (or `Ctrl+\``) while connected to open a shell drawer on the same SSH
  connection — file transfers keep working alongside it
- Real xterm.js terminal: colors, tab completion, shell history, and TUI programs (`vim`, `htop`)
- Drag the drawer's top edge to resize; every resize is sent to the remote PTY (`window-change`),
  so full-screen programs reflow correctly
- Scrollback survives hiding the drawer; the session closes when you disconnect

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run dev`       | Start with hot reload (devtools attached)           |
| `npm run build`     | Production bundle in `out/`                         |
| `npm run typecheck` | Type-check main, preload, and renderer              |
| `npm test`          | SSH/SFTP loopback tests and renderer behavior tests  |
| `npm run dist`     | Windows NSIS installer in `dist/` (`Droplet Files Setup X.Y.Z.exe`) |
| `npm run dist:dir`  | Unpacked Windows build in `dist/win-unpacked/` (fast smoke test)    |

## Architecture

```
src/
├── main/                 Electron main process — owns all I/O
│   ├── index.ts          window lifecycle, dev logging
│   ├── ssh.ts            SshManager: ssh2 connection, SFTP browse/transfers, host-key verify
│   ├── ipc.ts            typed IPC handlers (channels in src/shared/channels.ts)
│   └── store.ts          profiles + trusted host fingerprints (userData JSON, safeStorage)
├── preload/index.ts      contextBridge → window.api (no Node access in the renderer)
├── renderer/             React UI (two panes, connection bar, terminal drawer, transfer queue, dialogs)
├── shared/types.ts       IPC contract shared by both sides
└── scripts/e2e.mjs       end-to-end test: real SshManager ↔ loopback ssh2 server
```

Security posture: `contextIsolation: true`, no `nodeIntegration`, CSP on the renderer, host key
verification on every connect (trust-on-first-use + tamper detection), passphrases encrypted with
the OS keychain, private keys read only in the main process.

## Known limitations / future work

- One droplet connection at a time
- No folder sync or remote file editing yet
- Dropping onto a specific subfolder uploads to the pane's current folder instead
- Unsigned Windows installer triggers a SmartScreen prompt until the binary is code-signed
