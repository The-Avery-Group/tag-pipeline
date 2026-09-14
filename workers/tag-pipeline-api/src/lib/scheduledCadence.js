export const OPPORTUNITY_PULL_CRON = '0 0,6,12,18 * * *'
export const EBUY_PULL_CRON = '5 0,6,12,18 * * *'
export const OPPORTUNITY_PULL_BACKUP_CRON = '15 0,6,12,18 * * *'
export const DAILY_MAINTENANCE_CRON = '1 12,13 * * *'

// Share one trigger without running both workloads at both hours. Accept old
// trigger names while Cloudflare propagates the replacement schedules.
export function dailyMaintenanceTask(cron, scheduledTime) {
  if (cron === '1 12 * * *') return 'capabilities'
  if (cron === '1 13 * * *') return 'notifications'
  if (cron !== DAILY_MAINTENANCE_CRON) return null
  const hour = new Date(scheduledTime).getUTCHours()
  return hour === 12 ? 'capabilities' : hour === 13 ? 'notifications' : null
}

export function isOpportunityPullCron(value) {
  return value === OPPORTUNITY_PULL_CRON || value === EBUY_PULL_CRON || value === OPPORTUNITY_PULL_BACKUP_CRON
}

export function isEbuyPullCron(value) { return value === EBUY_PULL_CRON }
export function isSAMPullCron(value) { return value === OPPORTUNITY_PULL_CRON }

export function isOpportunityPullBackupCron(value) {
  return value === OPPORTUNITY_PULL_BACKUP_CRON
}

// Backup events reuse the primary slot's timestamp. SAM and eBuy derive
// deterministic Workflow IDs from this value, so createBatch skips the
// backup when the primary event already created the instance.
export function opportunityPullSlotTime(scheduledTime, cron) {
  const timestamp = Number(scheduledTime)
  if (!Number.isFinite(timestamp)) return scheduledTime
  if (isOpportunityPullBackupCron(cron)) return timestamp - (15 * 60 * 1000)
  if (isEbuyPullCron(cron)) return timestamp - (5 * 60 * 1000)
  return timestamp
}

export function samMonitorDueAtSlot(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return false
  const weekday = date.getUTCDay()
  return (weekday >= 1 && weekday <= 5) || [0, 12].includes(date.getUTCHours())
}

export function samMonitorAlreadyRanForSlot(run, slotTime) {
  const checkedAt = new Date(run?.checkedAt || 0).getTime()
  const slot = Number(slotTime)
  return Number.isFinite(checkedAt) && Number.isFinite(slot) && checkedAt >= slot
}

export function isQuarterlyExpiringRefreshTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) &&
    date.getUTCHours() === 0 &&
    date.getUTCDate() === 1 &&
    [0, 3, 6, 9].includes(date.getUTCMonth())
}
