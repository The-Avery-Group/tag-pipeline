import { isRfiWorkflowNoticeType } from './noticeTypes.js'

export const AWARD_FIELDS = [
  ['Award Contract Number', 'Award / contract number', 'text'],
  ['Award Signed Date', 'Award date', 'date'],
  ['Award Recipient', 'Awardee', 'text'],
  ['Award Recipient UEI', 'Awardee UEI', 'text'],
  ['Award Amount', 'Awarded amount ($)', 'number'],
  ['Award Performance Start', 'Period of performance start', 'date'],
  ['Award Performance End', 'Period of performance end', 'date'],
  ['Award Notice Link', 'Award notice link', 'url'],
]

export function awardInformationPatch(draft) {
  const patch = Object.fromEntries(AWARD_FIELDS.map(([column]) => [column, String(draft[column] ?? '').trim()]))
  const amount = patch['Award Amount']
  if (amount !== '' && (!Number.isFinite(Number(amount)) || Number(amount) < 0)) throw new Error('Enter a valid non-negative awarded amount.')
  if (amount !== '') patch['Award Amount'] = Number(amount)
  for (const [column, label, type] of AWARD_FIELDS) {
    const value = patch[column]
    if (type === 'date' && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`Enter a valid ${label.toLowerCase()}.`)
  }
  if (patch['Award Performance Start'] && patch['Award Performance End'] && patch['Award Performance End'] < patch['Award Performance Start']) throw new Error('Performance end must not precede the start date.')
  if (patch['Award Notice Link'] && !/^https?:\/\//i.test(patch['Award Notice Link'])) throw new Error('Award notice link must start with https:// or http://.')
  return patch
}

export function needsRfiActivityPhasePrompt(existing, next, columns) {
  return isRfiWorkflowNoticeType(next[columns.noticeType]) &&
    Boolean(next[columns.submissionDate]) &&
    !next[columns.activityPhase] &&
    (!isRfiWorkflowNoticeType(existing[columns.noticeType]) || !existing[columns.submissionDate])
}
