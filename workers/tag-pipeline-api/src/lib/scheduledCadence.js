export function isQuarterlyExpiringRefreshTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) &&
    date.getUTCHours() === 0 &&
    date.getUTCDate() === 1 &&
    [0, 3, 6, 9].includes(date.getUTCMonth())
}
