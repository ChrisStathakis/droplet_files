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

### Backup & restore

- Select files/folders in the **Remote** pane (or select nothing to back up the current folder) and
  press **🗄 Backup**. Choose a name and a local destination.
- Each backup is a normal folder that you can browse outside the app:

  ```
  www_2026-10-19_1430/
    backup-manifest.json
    files/
      www/...
  ```

- `backup-manifest.json` records the server, source paths, original parent folder, file sizes,
  permissions, modification times, and a SHA-256 for every file.
- Press **♻ Restore** in the **Local** pane, pick a backup folder, and choose the remote destination.
  Existing files can be **skipped**, **overwritten**, or **kept alongside** the restored copies
  (`name (1).ext`). Checksums are verified before the server is touched (on by default).
- Hidden files and empty folders are included. Symlinks and special files are skipped and listed in
  the manifest. Backups are written to a temporary folder first, so a failed/interrupted backup never
  leaves a half-written backup with a manifest.

### Help & version

- Press **? Help** in the top bar to see the running app version, the Electron version, and a quick
  reminder of the Backup/Restore steps.

### Scheduled actions (automatic backups)

- Press **⏱ Actions** in the top bar to create a backup that repeats on its own — e.g. every 3 days
  at 03:00, or every 6 hours.
- Each action uses a **saved connection profile**, the remote folders you list (e.g. `/var/www`),
  and one local destination folder. Every run writes a timestamped snapshot
  (`Nightly website_2026-10-22_03-00/`) next to the previous ones.
- Runs happen **while the app is open**. While at least one action is enabled, closing the window
  keeps Droplet Files running in the **tray**; use the tray icon to reopen it or quit. If the app was
  closed at the due time, a missed run is started on the next launch (unless you untick *Catch up*).
- Automatic runs need the profile to have **Remember** ticked so the passphrase is available. If the
  app is connected to a different server, or a manual backup/restore is running, the action waits a
  few minutes and tries again. Failed runs retry up to 3 times (10 minutes apart), and Windows
  notifications report success or failure.
- **Nothing is deleted automatically** — the history at the bottom of the dialog lists every run
  with **Open** and **Delete backup** buttons, so you decide which snapshots to keep.
- **▶ Run now** starts an action immediately; while a scheduled run is in progress you can cancel it
  from the same dialog.

### Droplet command line

- Press **⌨ Terminal** (or `Ctrl+\``) while connected to open a shell drawer on the same SSH
  connection — file transfers keep working alongside it
- Real xterm.js terminal: colors, tab completion, shell history, and TUI programs (`vim`, `htop`)
- Drag the drawer's top edge to resize; every resize is sent to the remote PTY (`window-change`),
  so full-screen programs reflow correctly
- Right-click for **Copy / Paste / Select all / Clear** (or use `Ctrl+Shift+C` and `Ctrl+Shift+V`)
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
│   ├── index.ts          window lifecycle (tray while actions are enabled), dev logging
│   ├── ssh.ts            SshManager: ssh2 connection, SFTP browse/transfers, host-key verify
│   ├── backup.ts         BackupManager: manifest, remote backup, restore + conflict policies
│   ├── actions.ts        ActionManager: scheduled backups, history, retries, notifications
│   ├── ipc.ts            typed IPC handlers (channels in src/shared/channels.ts)
│   └── store.ts          profiles, trusted fingerprints, last backup folder (userData JSON, safeStorage)
├── preload/index.ts      contextBridge → window.api (no Node access in the renderer)
├── renderer/             React UI (two panes, connection bar, terminal drawer, transfer queue, dialogs)
├── shared/types.ts       IPC contract shared by both sides
├── shared/actionSchedule.ts  next-run math and backup folder names (shared, unit-tested)
└── scripts/e2e.mjs       end-to-end test: real SshManager ↔ loopback ssh2 server
```

Security posture: `contextIsolation: true`, no `nodeIntegration`, CSP on the renderer, host key
verification on every connect (trust-on-first-use + tamper detection), passphrases encrypted with
the OS keychain, private keys read only in the main process.

## Known limitations / future work

- One droplet connection at a time
- No folder sync or remote file editing yet
- Dropping onto a specific subfolder uploads to the pane's current folder instead
- Scheduled actions only run while the app is open (tray counts) — no Windows Task Scheduler mode;
  every backup is a full snapshot with no incremental/delta support
- Symlinks and special files are skipped, and ownership/ACLs are not preserved
- Unsigned Windows installer triggers a SmartScreen prompt until the binary is code-signed
