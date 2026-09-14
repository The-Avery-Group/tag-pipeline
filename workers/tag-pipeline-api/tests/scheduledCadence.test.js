import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  DAILY_MAINTENANCE_CRON,
  dailyMaintenanceTask,
  isOpportunityPullCron,
  isQuarterlyExpiringRefreshTime,
  opportunityPullSlotTime,
  samMonitorAlreadyRanForSlot,
  samMonitorDueAtSlot,
} from '../src/lib/scheduledCadence.js'

test('combined maintenance trigger preserves separate UTC run times and legacy schedules', () => {
  assert.equal(dailyMaintenanceTask(DAILY_MAINTENANCE_CRON, Date.parse('2026-09-14T12:01:00Z')), 'capabilities')
  assert.equal(dailyMaintenanceTask(DAILY_MAINTENANCE_CRON, Date.parse('2026-09-14T13:01:00Z')), 'notifications')
  assert.equal(dailyMaintenanceTask(DAILY_MAINTENANCE_CRON, Date.parse('2026-09-14T14:01:00Z')), null)
  assert.equal(dailyMaintenanceTask(DAILY_MAINTENANCE_CRON, NaN), null)
  assert.equal(dailyMaintenanceTask('0 0,6,12,18 * * *', Date.parse('2026-09-14T12:00:00Z')), null)
  assert.equal(dailyMaintenanceTask('1 12 * * *', 0), 'capabilities')
  assert.equal(dailyMaintenanceTask('1 13 * * *', 0), 'notifications')
})

test('Worker configuration fits five free-plan cron definitions including Fathom', () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
  const crons = JSON.parse(config.match(/^crons\s*=\s*(\[[^\n]+\])/m)[1])
  assert.ok(crons.length <= 5)
  assert.equal(new Set(crons).size, crons.length)
  assert.ok(crons.includes(DAILY_MAINTENANCE_CRON))
  assert.ok(crons.includes('2,7,12,17,22,27,32,37,42,47,52,57 * * * *'))
})

test('quarterly expiring refresh runs at midnight UTC on the first day of each calendar quarter', () => {
  for (const month of ['01', '04', '07', '10']) {
    assert.equal(isQuarterlyExpiringRefreshTime(`2027-${month}-01T00:00:00.000Z`), true)
  }
})

test('quarterly expiring refresh does not run on other days or hours', () => {
  assert.equal(isQuarterlyExpiringRefreshTime('2027-01-02T00:00:00.000Z'), false)
  assert.equal(isQuarterlyExpiringRefreshTime('2027-01-01T12:00:00.000Z'), false)
  assert.equal(isQuarterlyExpiringRefreshTime('2027-02-01T00:00:00.000Z'), false)
  assert.equal(isQuarterlyExpiringRefreshTime('not-a-date'), false)
})

test('opportunity pull backup maps to the same deterministic slot', () => {
  const primary = Date.parse('2026-09-02T06:00:00.000Z')
  const backup = Date.parse('2026-09-02T06:15:00.000Z')
  assert.equal(isOpportunityPullCron('0 0,6,12,18 * * *'), true)
  assert.equal(isOpportunityPullCron('15 0,6,12,18 * * *'), true)
  assert.equal(opportunityPullSlotTime(primary, '0 0,6,12,18 * * *'), primary)
  assert.equal(opportunityPullSlotTime(backup, '15 0,6,12,18 * * *'), primary)
})

test('SAM monitoring covers every weekday slot and twice-daily weekends', () => {
  assert.equal(samMonitorDueAtSlot('2026-09-02T06:00:00.000Z'), true)
  assert.equal(samMonitorDueAtSlot('2026-09-05T00:00:00.000Z'), true)
  assert.equal(samMonitorDueAtSlot('2026-09-05T06:00:00.000Z'), false)
  assert.equal(samMonitorDueAtSlot('2026-09-05T12:00:00.000Z'), true)
})

test('SAM monitor backup skips only a slot completed by its primary event', () => {
  const slot = Date.parse('2026-09-02T06:00:00.000Z')
  assert.equal(samMonitorAlreadyRanForSlot({ checkedAt: '2026-09-02T06:01:00.000Z' }, slot), true)
  assert.equal(samMonitorAlreadyRanForSlot({ checkedAt: '2026-09-02T00:01:00.000Z' }, slot), false)
  assert.equal(samMonitorAlreadyRanForSlot(null, slot), false)
})
