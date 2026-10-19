import type { ActionDefinition, ActionIntervalUnit } from './types'

/** The subset of an action needed to compute its next run time */
export type SchedulableAction = Pick<
  ActionDefinition,
  'intervalValue' | 'intervalUnit' | 'timeOfDay' | 'lastRunAt'
>

const UNIT_MS: Record<ActionIntervalUnit, number> = {
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value)
}

export function isIntervalUnit(value: unknown): value is ActionIntervalUnit {
  return value === 'hours' || value === 'days' || value === 'weeks'
}

export function intervalLabel(unit: ActionIntervalUnit, value = 1): string {
  const base = unit === 'hours' ? 'hour' : unit === 'days' ? 'day' : 'week'
  return value === 1 ? base : `${base}s`
}

/** Human-readable schedule, e.g. "Every 3 days at 03:00" */
export function describeSchedule(
  action: Pick<ActionDefinition, 'intervalValue' | 'intervalUnit' | 'timeOfDay'>
): string {
  const every = `Every ${action.intervalValue} ${intervalLabel(action.intervalUnit, action.intervalValue)}`
  if (action.timeOfDay && action.intervalUnit !== 'hours') {
    return `${every} at ${action.timeOfDay}`
  }
  return every
}

/**
 * The next time the action should run, as an ISO timestamp.
 * `from` is the reference "now"; the result is always strictly after it.
 * When the action has never run, the interval is anchored on `from`.
 */
export function computeNextRun(action: SchedulableAction, from: Date): string {
  const intervalValue = Math.max(1, Math.round(action.intervalValue))
  const intervalMs = intervalValue * UNIT_MS[action.intervalUnit]
  const anchor = action.lastRunAt ? Date.parse(action.lastRunAt) : Number.NaN
  const base = Number.isFinite(anchor) ? anchor : from.getTime()

  const match = action.timeOfDay ? TIME_OF_DAY.exec(action.timeOfDay) : null
  if (match && action.intervalUnit !== 'hours') {
    // Calendar-based so the time of day stays fixed across DST changes.
    const stepDays = action.intervalUnit === 'weeks' ? intervalValue * 7 : intervalValue
    const start = new Date(base)
    start.setHours(0, 0, 0, 0)
    const next = new Date(start)
    next.setDate(next.getDate() + stepDays)
    next.setHours(Number(match[1]), Number(match[2]), 0, 0)
    while (next.getTime() <= from.getTime()) next.setDate(next.getDate() + stepDays)
    return next.toISOString()
  }

  let next = base + intervalMs
  while (next <= from.getTime()) next += intervalMs
  return new Date(next).toISOString()
}

const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/** A filesystem-safe, timestamped backup folder name for an action */
export function makeActionBackupName(label: string, date: Date): string {
  const cleaned = label
    .replace(INVALID_NAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '')
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}`
  return `${cleaned || 'scheduled-backup'}_${stamp}`
}
