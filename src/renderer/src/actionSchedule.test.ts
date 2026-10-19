// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  computeNextRun,
  describeSchedule,
  makeActionBackupName
} from '../../shared/actionSchedule'

const base = {
  intervalValue: 3,
  intervalUnit: 'days' as const,
  timeOfDay: null,
  lastRunAt: null
}

describe('computeNextRun', () => {
  it('schedules the first run one interval after now', () => {
    const from = new Date(2026, 9, 19, 10, 0, 0)
    expect(computeNextRun({ ...base }, from)).toBe(new Date(2026, 9, 22, 10, 0, 0).toISOString())
  })

  it('anchors the schedule to the previous run', () => {
    const lastRunAt = new Date(2026, 9, 19, 10, 0, 0).toISOString()
    const from = new Date(2026, 9, 19, 10, 0, 5)
    expect(computeNextRun({ ...base, lastRunAt }, from)).toBe(
      new Date(2026, 9, 22, 10, 0, 0).toISOString()
    )
  })

  it('uses the fixed time of day for daily schedules', () => {
    const from = new Date(2026, 9, 19, 10, 0, 0)
    const next = new Date(computeNextRun({ ...base, intervalValue: 1, timeOfDay: '03:00' }, from))
    expect(next.getFullYear()).toBe(2026)
    expect(next.getMonth()).toBe(9)
    expect(next.getDate()).toBe(20)
    expect(next.getHours()).toBe(3)
    expect(next.getMinutes()).toBe(0)
  })

  it('skips forward to the next occurrence when the anchor is far in the past', () => {
    const lastRunAt = new Date(2026, 9, 1, 3, 0, 0).toISOString()
    const from = new Date(2026, 9, 19, 10, 0, 0)
    const next = new Date(
      computeNextRun({ ...base, intervalValue: 1, timeOfDay: '03:00', lastRunAt }, from)
    )
    expect(next.getDate()).toBe(20)
    expect(next.getHours()).toBe(3)
  })

  it('supports hourly schedules', () => {
    const from = new Date(2026, 9, 19, 10, 15, 0)
    expect(
      computeNextRun({ ...base, intervalValue: 2, intervalUnit: 'hours' }, from)
    ).toBe(new Date(2026, 9, 19, 12, 15, 0).toISOString())
  })
})

describe('describeSchedule', () => {
  it('renders intervals with a fixed time', () => {
    expect(describeSchedule({ intervalValue: 3, intervalUnit: 'days', timeOfDay: '03:00' })).toBe(
      'Every 3 days at 03:00'
    )
    expect(describeSchedule({ intervalValue: 1, intervalUnit: 'weeks', timeOfDay: null })).toBe(
      'Every 1 week'
    )
    expect(describeSchedule({ intervalValue: 6, intervalUnit: 'hours', timeOfDay: null })).toBe(
      'Every 6 hours'
    )
  })
})

describe('makeActionBackupName', () => {
  it('builds a safe timestamped folder name', () => {
    expect(makeActionBackupName('My:Site / data', new Date(2026, 0, 2, 3, 4))).toBe(
      'My-Site - data_2026-01-02_03-04'
    )
  })

  it('falls back when the label has no usable characters', () => {
    expect(makeActionBackupName('', new Date(2026, 0, 2, 3, 4))).toBe(
      'scheduled-backup_2026-01-02_03-04'
    )
  })
})
