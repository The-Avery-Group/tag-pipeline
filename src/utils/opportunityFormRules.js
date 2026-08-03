import { isRfiWorkflowNoticeType } from './noticeTypes.js'

export function needsRfiActivityPhasePrompt(existing, next, columns) {
  return isRfiWorkflowNoticeType(next[columns.noticeType]) &&
    Boolean(next[columns.submissionDate]) &&
    !next[columns.activityPhase] &&
    (!isRfiWorkflowNoticeType(existing[columns.noticeType]) || !existing[columns.submissionDate])
}
