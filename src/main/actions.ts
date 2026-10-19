import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import * as path from 'path'
import { app, Notification } from 'electron'
import {
  computeNextRun,
  isIntervalUnit,
  isValidTimeOfDay,
  makeActionBackupName
} from '../shared/actionSchedule'
import { Store } from './store'
import type { BackupManager } from './backup'
import type { SshManager } from './ssh'
import type {
  ActionDefinition,
  ActionInput,
  ActionRunEntry,
  ActionStatus,
  ActionsSnapshot
} from '../shared/types'

export type ActionTrigger = 'schedule' | 'manual'

export interface ActionManagerOptions {
  ssh: SshManager
  backups: BackupManager
  events: {
    changed(snapshot: ActionsSnapshot): void
    /** Called when the set of enabled actions changes, so the app can keep a tray icon */
    enabledChanged?(hasEnabled: boolean): void
  }
}

const ACTIONS_FILE = 'actions.json'
const HISTORY_FILE = 'actions-history.json'
const HISTORY_LIMIT = 100
const TICK_MS = 30_000
const FIRST_TICK_MS = 5_000
const RETRY_MS = 10 * 60_000
const DEFER_MS = 5 * 60_000
const MAX_ATTEMPTS = 3
const CONNECT_TIMEOUT_MS = 60_000

interface ActionsFile {
  actions: ActionDefinition[]
}

interface HistoryFile {
  runs: ActionRunEntry[]
}

function dataFile(name: string): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const file = dataFile(name)
    if (!existsSync(file)) return fallback
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  try {
    writeFileSync(dataFile(name), JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error(`[actions] could not write ${name}:`, err)
  }
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asStatus(value: unknown): ActionStatus {
  return value === 'running' ||
    value === 'success' ||
    value === 'failed' ||
    value === 'skipped' ||
    value === 'cancelled'
    ? value
    : 'idle'
}

function normalizeAction(raw: unknown): ActionDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = asString(record.id)
  const label = asString(record.label)
  const profileId = asString(record.profileId)
  const remotePaths = Array.isArray(record.remotePaths)
    ? record.remotePaths
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
    : []
  const destination = asString(record.destination)
  if (!id || !label || !profileId || remotePaths.length === 0 || !destination) return null

  const intervalUnit = isIntervalUnit(record.intervalUnit) ? record.intervalUnit : 'days'
  const intervalValue =
    typeof record.intervalValue === 'number' && Number.isFinite(record.intervalValue)
      ? Math.max(1, Math.round(record.intervalValue))
      : 3
  const timeOfDay =
    typeof record.timeOfDay === 'string' && isValidTimeOfDay(record.timeOfDay)
      ? record.timeOfDay
      : null

  return {
    id,
    label,
    profileId,
    remotePaths,
    destination,
    intervalValue,
    intervalUnit,
    timeOfDay,
    enabled: asBoolean(record.enabled, true),
    catchUp: asBoolean(record.catchUp, true),
    createdAt: asString(record.createdAt, new Date().toISOString()),
    updatedAt: asString(record.updatedAt, new Date().toISOString()),
    lastRunAt: typeof record.lastRunAt === 'string' ? record.lastRunAt : null,
    nextRunAt:
      typeof record.nextRunAt === 'string' && !Number.isNaN(Date.parse(record.nextRunAt))
        ? record.nextRunAt
        : null,
    lastStatus: asStatus(record.lastStatus),
    lastError: typeof record.lastError === 'string' ? record.lastError : null
  }
}

function normalizeRun(raw: unknown): ActionRunEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const id = asString(record.id)
  const actionId = asString(record.actionId)
  const actionLabel = asString(record.actionLabel, 'Backup')
  const startedAt = asString(record.startedAt)
  if (!id || !actionId || !startedAt) return null
  const status = record.status
  return {
    id,
    actionId,
    actionLabel,
    startedAt,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    status:
      status === 'running' || status === 'success' || status === 'failed' ||
      status === 'skipped' || status === 'cancelled'
        ? status
        : 'failed',
    trigger: record.trigger === 'manual' ? 'manual' : 'schedule',
    backupDir: typeof record.backupDir === 'string' ? record.backupDir : null,
    files: typeof record.files === 'number' && Number.isFinite(record.files) ? record.files : 0,
    bytes: typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : 0,
    error: typeof record.error === 'string' ? record.error : null
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

/** SSH errors that mean the saved passphrase is missing or wrong */
function isCredentialProblem(message: string): boolean {
  return /encrypted private key|bad passphrase|no passphrase|passphrase.*(required|missing|incorrect)|integrity check failed/i.test(
    message
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function sameServer(
  connection: { host: string; port: number; username: string },
  profile: { host: string; port: number; username: string }
): boolean {
  return (
    connection.host === profile.host &&
    connection.port === profile.port &&
    connection.username === profile.username
  )
}

/**
 * Runs scheduled backups while the app is open. Actions are stored in
 * actions.json; a run history is kept in actions-history.json.
 */
export class ActionManager {
  private actions: ActionDefinition[] = []
  private history: ActionRunEntry[] = []
  private runningActionId: string | null = null
  private timer: NodeJS.Timeout | null = null
  private firstTick: NodeJS.Timeout | null = null
  private ticking = false
  private attempts = new Map<string, number>()
  private lastEnabledState: boolean | null = null

  constructor(private options: ActionManagerOptions) {}

  start(): void {
    try {
      const actionsFile = readJson<ActionsFile>(ACTIONS_FILE, { actions: [] })
      this.actions = Array.isArray(actionsFile.actions)
        ? actionsFile.actions
            .map(normalizeAction)
            .filter((action): action is ActionDefinition => action !== null)
        : []

      const historyFile = readJson<HistoryFile>(HISTORY_FILE, { runs: [] })
      this.history = Array.isArray(historyFile.runs)
        ? historyFile.runs.map(normalizeRun).filter((run): run is ActionRunEntry => run !== null)
        : []
    } catch (err) {
      console.error('[actions] could not load saved actions:', err)
      this.actions = []
      this.history = []
    }

    const now = new Date()
    let dirty = false
    for (const run of this.history) {
      if (run.status === 'running') {
        run.status = 'failed'
        run.finishedAt = now.toISOString()
        run.error = 'Interrupted — the app was closed while the backup was running'
        dirty = true
      }
    }
    for (const action of this.actions) {
      if (action.lastStatus === 'running') {
        action.lastStatus = 'failed'
        action.lastError = 'Interrupted — the app was closed while the backup was running'
        dirty = true
      }
      if (action.enabled && !action.nextRunAt) {
        action.nextRunAt = computeNextRun(action, now)
        dirty = true
      }
    }
    if (dirty) {
      this.persistActions()
      this.persistHistory()
    }

    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.firstTick = setTimeout(() => void this.tick(), FIRST_TICK_MS)
    this.emitChanged()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstTick) clearTimeout(this.firstTick)
    this.timer = null
    this.firstTick = null
  }

  snapshot(): ActionsSnapshot {
    return {
      actions: this.actions.map((action) => ({ ...action })),
      history: [...this.history]
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, HISTORY_LIMIT),
      runningActionId: this.runningActionId,
      busy: this.options.backups.isBusy()
    }
  }

  // ------------------------------------------------------------------ editing

  save(input: ActionInput & { id?: string }): ActionsSnapshot {
    const existing = input.id ? this.findAction(input.id) : undefined
    if (input.id && !existing) throw new Error('Action not found')
    if (existing && this.runningActionId === existing.id) {
      throw new Error('This action is currently running')
    }

    const label = asString(input.label).trim()
    if (!label) throw new Error('Give the action a name')
    if (!Store.getProfile(input.profileId)) {
      throw new Error('Choose a saved connection profile')
    }

    const remotePaths = (Array.isArray(input.remotePaths) ? input.remotePaths : [])
      .map((p) => path.posix.normalize(String(p).trim()))
      .filter((p) => p.length > 0)
    if (remotePaths.length === 0) throw new Error('Add at least one remote folder to back up')
    for (const remotePath of remotePaths) {
      if (!path.posix.isAbsolute(remotePath)) {
        throw new Error(`Remote path must be absolute: "${remotePath}"`)
      }
      if (remotePath === '/') {
        throw new Error('Choose a folder inside / instead of backing up the whole server')
      }
    }

    const rawDestination = asString(input.destination).trim()
    if (!rawDestination) throw new Error('Choose a local folder for the backups')
    const destination = path.resolve(rawDestination)
    let destinationStat
    try {
      destinationStat = statSync(destination, { throwIfNoEntry: false })
    } catch {
      destinationStat = undefined
    }
    if (!destinationStat?.isDirectory()) {
      throw new Error('Choose an existing local folder for the backups')
    }

    const intervalUnit = isIntervalUnit(input.intervalUnit) ? input.intervalUnit : 'days'
    const intervalValue = Math.max(1, Math.round(Number(input.intervalValue) || 3))

    let timeOfDay: string | null = null
    if (input.timeOfDay) {
      if (intervalUnit === 'hours') {
        throw new Error('Pick a time of day only for daily or weekly schedules')
      }
      if (!isValidTimeOfDay(input.timeOfDay)) throw new Error('Time of day must look like 03:00')
      timeOfDay = input.timeOfDay
    }

    const now = new Date()
    const action: ActionDefinition = {
      id: existing?.id ?? randomUUID(),
      label,
      profileId: input.profileId,
      remotePaths,
      destination,
      intervalValue,
      intervalUnit,
      timeOfDay,
      enabled: input.enabled !== false,
      catchUp: input.catchUp !== false,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      lastRunAt: existing?.lastRunAt ?? null,
      nextRunAt: null,
      lastStatus: existing?.lastStatus ?? 'idle',
      lastError: existing?.lastError ?? null
    }
    action.nextRunAt = action.enabled ? computeNextRun(action, now) : null

    if (existing) Object.assign(existing, action)
    else this.actions.push(action)

    this.persistActions()
    this.emitChanged()
    return this.snapshot()
  }

  remove(id: string): ActionsSnapshot {
    const action = this.findAction(id)
    if (!action) throw new Error('Action not found')
    if (this.runningActionId === id) throw new Error('This action is currently running')
    this.actions = this.actions.filter((a) => a.id !== id)
    this.history = this.history.filter((run) => run.actionId !== id)
    this.attempts.delete(id)
    this.persistActions()
    this.persistHistory()
    this.emitChanged()
    return this.snapshot()
  }

  setEnabled(id: string, enabled: boolean): ActionsSnapshot {
    const action = this.findAction(id)
    if (!action) throw new Error('Action not found')
    if (this.runningActionId === id && !enabled) {
      throw new Error('This action is currently running')
    }
    action.enabled = enabled
    action.updatedAt = new Date().toISOString()
    action.nextRunAt = enabled ? computeNextRun(action, new Date()) : null
    this.persistActions()
    this.emitChanged()
    return this.snapshot()
  }

  // -------------------------------------------------------------------- runs

  async runAction(id: string, trigger: ActionTrigger): Promise<void> {
    const action = this.findAction(id)
    if (!action) throw new Error('Action not found')
    if (!action.enabled && trigger === 'schedule') return
    if (this.runningActionId) {
      if (trigger === 'manual') throw new Error('Another action is already running')
      return
    }
    if (this.options.backups.isBusy()) {
      if (trigger === 'manual') throw new Error('A backup or restore is already running')
      this.defer(action, 'Busy with another backup or restore')
      return
    }

    const profile = Store.getProfile(action.profileId)
    if (!profile) {
      const message = 'The saved connection profile was deleted — edit the action and pick a profile'
      this.failWithoutRun(action, trigger, message)
      if (trigger === 'manual') throw new Error(message)
      return
    }

    const current = this.options.ssh.getConnectionInfo()
    if (current && !sameServer(current, profile)) {
      if (trigger === 'manual') {
        throw new Error(
          `The app is connected to ${current.username}@${current.host}:${current.port}. ` +
            'Disconnect first, or run an action for that server.'
        )
      }
      this.defer(action, `Waiting — connected to ${current.username}@${current.host}:${current.port}`)
      return
    }

    this.runningActionId = action.id
    const startedAt = new Date()
    action.lastStatus = 'running'
    action.lastError = null
    action.updatedAt = startedAt.toISOString()

    const run: ActionRunEntry = {
      id: randomUUID(),
      actionId: action.id,
      actionLabel: action.label,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      status: 'running',
      trigger,
      backupDir: null,
      files: 0,
      bytes: 0,
      error: null
    }
    this.history.unshift(run)
    this.trimHistory()
    this.persistActions()
    this.persistHistory()
    this.emitChanged()

    let owned = false
    let generation = this.options.ssh.getConnectionGeneration()
    let failure: string | null = null

    try {
      if (!this.options.ssh.isConnected()) {
        owned = true
        const passphrase = Store.getPassphrase(profile.id)
        const connecting = this.options.ssh.connect({
          host: profile.host,
          port: profile.port,
          username: profile.username,
          keyPath: profile.keyPath,
          passphrase,
          rememberPassphrase: false
        })
        // connect() bumps the generation synchronously, so this pins the
        // attempt and lets the finally block cancel it if we time out.
        generation = this.options.ssh.getConnectionGeneration()
        await withTimeout(connecting, CONNECT_TIMEOUT_MS, 'Timed out while connecting to the server')
        generation = this.options.ssh.getConnectionGeneration()
      }

      const summary = await this.options.backups.create({
        remotePaths: action.remotePaths,
        destination: action.destination,
        name: makeActionBackupName(action.label, startedAt)
      })

      const finishedAt = new Date()
      run.status = 'success'
      run.finishedAt = finishedAt.toISOString()
      run.backupDir = summary.backupDir
      run.files = summary.manifest.totals.files
      run.bytes = summary.manifest.totals.bytes
      action.lastRunAt = finishedAt.toISOString()
      action.lastStatus = 'success'
      action.lastError = null
      action.nextRunAt = action.enabled ? computeNextRun(action, finishedAt) : null
      this.attempts.delete(action.id)
      if (trigger === 'schedule') {
        this.notify(
          'Scheduled backup complete',
          `${action.label} — ${run.files} file(s), ${formatBytes(run.bytes)}`
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failure = message
      const finishedAt = new Date()
      const cancelled = /cancelled/i.test(message)
      run.status = cancelled ? 'cancelled' : 'failed'
      run.finishedAt = finishedAt.toISOString()
      run.error = message
      action.lastStatus = run.status
      action.lastError = message

      if (trigger === 'schedule') {
        if (isCredentialProblem(message)) {
          // The profile cannot connect unattended: pause instead of retrying.
          this.attempts.delete(action.id)
          action.enabled = false
          action.nextRunAt = null
          action.lastError =
            'The saved passphrase is missing or incorrect. Edit the connection profile with ' +
            '“Remember” ticked, then enable this action again.'
        } else {
          const attempts = (this.attempts.get(action.id) ?? 0) + 1
          if (!cancelled && attempts < MAX_ATTEMPTS) {
            this.attempts.set(action.id, attempts)
            action.nextRunAt = new Date(finishedAt.getTime() + RETRY_MS).toISOString()
            action.lastError = `${message} — retrying in 10 minutes`
          } else {
            // Final attempt failed or the user cancelled: move on to the next cycle.
            this.attempts.delete(action.id)
            action.lastRunAt = finishedAt.toISOString()
            action.nextRunAt = action.enabled ? computeNextRun(action, finishedAt) : null
          }
        }
      }

      if (trigger === 'schedule') {
        this.notify('Scheduled backup failed', `${action.label} — ${message}`)
      }
    } finally {
      if (owned && this.options.ssh.getConnectionGeneration() === generation) {
        await this.options.ssh.disconnect().catch(() => undefined)
      }
      this.runningActionId = null
      action.updatedAt = new Date().toISOString()
      this.persistActions()
      this.persistHistory()
      this.emitChanged()
    }

    if (trigger === 'manual' && failure) throw new Error(failure)
  }

  cancelRun(): void {
    this.options.backups.cancel()
  }

  deleteBackup(runId: string): ActionsSnapshot {
    const run = this.history.find((entry) => entry.id === runId)
    if (!run) throw new Error('Run not found')
    if (!run.backupDir) throw new Error('This run has no backup folder any more')
    const action = this.findAction(run.actionId)
    if (!action) throw new Error('Action not found')

    const target = path.resolve(run.backupDir)
    const destination = path.resolve(action.destination)
    if (target === destination || path.dirname(target) !== destination) {
      throw new Error('Refusing to delete a folder that is not a direct backup of this action')
    }
    const manifest = statSync(path.join(target, 'backup-manifest.json'), { throwIfNoEntry: false })
    if (!manifest?.isFile()) {
      throw new Error('Refusing to delete a folder without a backup manifest')
    }

    rmSync(target, { recursive: true, force: true })
    run.backupDir = null
    this.persistHistory()
    this.emitChanged()
    return this.snapshot()
  }

  // --------------------------------------------------------------- internals

  private findAction(id: string): ActionDefinition | undefined {
    return this.actions.find((action) => action.id === id)
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (this.runningActionId || this.options.backups.isBusy()) return
      const now = Date.now()
      const due = this.actions
        .filter((action) => action.enabled && action.nextRunAt !== null)
        .filter((action) => Date.parse(action.nextRunAt as string) <= now)
        .sort((a, b) => Date.parse(a.nextRunAt as string) - Date.parse(b.nextRunAt as string))
      const action = due[0]
      if (!action) return

      const missedAt = new Date(Date.parse(action.nextRunAt as string))
      const overdue = now - missedAt.getTime()
      if (!action.catchUp && overdue > TICK_MS) {
        action.nextRunAt = computeNextRun(action, new Date(now))
        action.lastStatus = 'skipped'
        action.lastError = 'Missed while the app was closed (catch-up is off)'
        this.history.unshift({
          id: randomUUID(),
          actionId: action.id,
          actionLabel: action.label,
          startedAt: missedAt.toISOString(),
          finishedAt: missedAt.toISOString(),
          status: 'skipped',
          trigger: 'schedule',
          backupDir: null,
          files: 0,
          bytes: 0,
          error: 'Missed while the app was closed (catch-up is off)'
        })
        this.trimHistory()
        this.persistActions()
        this.persistHistory()
        this.emitChanged()
        return
      }

      await this.runAction(action.id, 'schedule')
    } catch (err) {
      console.error('[actions] tick failed:', err)
    } finally {
      this.ticking = false
    }
  }

  private defer(action: ActionDefinition, reason: string): void {
    action.nextRunAt = new Date(Date.now() + DEFER_MS).toISOString()
    action.lastError = `${reason} — will try again shortly`
    action.updatedAt = new Date().toISOString()
    this.persistActions()
    this.emitChanged()
  }

  private failWithoutRun(action: ActionDefinition, trigger: ActionTrigger, message: string): void {
    const now = new Date()
    if (trigger === 'schedule') {
      this.history.unshift({
        id: randomUUID(),
        actionId: action.id,
        actionLabel: action.label,
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        status: 'failed',
        trigger,
        backupDir: null,
        files: 0,
        bytes: 0,
        error: message
      })
      this.trimHistory()
      this.persistHistory()
      this.notify('Scheduled backup failed', `${action.label} — ${message}`)
    }
    action.lastStatus = 'failed'
    action.lastError = message
    // Needs user attention — don't keep retrying (or holding the app in the tray) silently.
    action.enabled = false
    action.nextRunAt = null
    action.updatedAt = now.toISOString()
    this.persistActions()
    this.emitChanged()
  }

  private trimHistory(): void {
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT
  }

  private persistActions(): void {
    writeJson(ACTIONS_FILE, { actions: this.actions })
  }

  private persistHistory(): void {
    writeJson(HISTORY_FILE, { runs: this.history })
  }

  private notify(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return
      new Notification({ title, body }).show()
    } catch {
      /* notifications are best effort */
    }
  }

  private emitChanged(): void {
    this.options.events.changed(this.snapshot())
    const hasEnabled = this.actions.some((action) => action.enabled)
    if (hasEnabled !== this.lastEnabledState) {
      this.lastEnabledState = hasEnabled
      try {
        this.options.events.enabledChanged?.(hasEnabled)
      } catch (err) {
        console.error('[actions] enabledChanged callback failed:', err)
      }
    }
  }
}
