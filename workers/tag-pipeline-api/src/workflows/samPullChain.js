const MAX_CHECKPOINTS = 1000
const PERMANENT_ERROR = /not configured|does not contain any NAICS|API key expired|API key invalid/i

function cursorKey(cursor) {
  return `${Number(cursor?.naicsIndex) || 0}:${Number(cursor?.offset) || 0}`
}

function continuationInstanceId(pull, checkpoint) {
  const runId = String(pull?.runId || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 70)
  return `sam-pull-${runId}-${checkpoint}`
}

export async function runSAMPullWorkflowCheckpoint({
  env,
  event,
  step,
  runCheckpoint,
}) {
  const continuation = event?.payload?.continuation || null
  const checkpoint = Math.max(1, Number(event?.payload?.checkpoint) || 1)
  const priorCursor = continuation?.nextCursor

  if (checkpoint > MAX_CHECKPOINTS) {
    throw new Error(`Scheduled SAM pull exceeded ${MAX_CHECKPOINTS} checkpoints`)
  }

  const outcome = await step.do(
    `SAM pull checkpoint ${checkpoint}`,
    {
      retries: {
        limit: 3,
        delay: '10 seconds',
        backoff: 'exponential',
      },
      timeout: '5 minutes',
    },
    async () => {
      const result = await runCheckpoint(env, continuation)
      if (!result.ok && !result.skipped && !PERMANENT_ERROR.test(result.error || '')) {
        throw new Error(result.error || 'Scheduled SAM checkpoint failed')
      }
      return result
    },
  )

  if (!outcome.ok || outcome.skipped) {
    console.error(JSON.stringify({
      event: 'scheduled_sam_pull_workflow',
      status: outcome.skipped ? 'skipped' : 'error',
      instanceId: event?.instanceId,
      checkpoint,
      message: outcome.message || outcome.error || 'Unknown error',
    }))
    return outcome
  }

  const pull = outcome.result
  if (pull.status !== 'partial') {
    console.log(JSON.stringify({
      event: 'scheduled_sam_pull_workflow',
      status: 'complete',
      instanceId: event?.instanceId,
      checkpoints: checkpoint,
      runId: pull.runId,
      totalFetched: pull.totalFetched,
      totalWritten: pull.totalWritten,
      completedAt: pull.completedAt,
    }))
    return {
      ok: true,
      status: 'complete',
      checkpoints: checkpoint,
      runId: pull.runId,
      totalFetched: pull.totalFetched,
      totalWritten: pull.totalWritten,
      completedAt: pull.completedAt,
    }
  }

  if (priorCursor && cursorKey(priorCursor) === cursorKey(pull.nextCursor)) {
    throw new Error(`Scheduled SAM pull did not advance beyond checkpoint ${cursorKey(priorCursor)}`)
  }

  if (checkpoint >= MAX_CHECKPOINTS) {
    throw new Error(`Scheduled SAM pull exceeded ${MAX_CHECKPOINTS} checkpoints`)
  }

  // A Workers Free Workflow instance is capped at 50 total subrequests.
  // Starting the next durable instance here gives every pull checkpoint a
  // fresh subrequest budget while preserving the same run totals and cursor.
  const nextCheckpoint = checkpoint + 1
  const nextInstanceId = continuationInstanceId(pull, nextCheckpoint)
  const scheduled = await step.do(
    `Schedule SAM pull checkpoint ${nextCheckpoint}`,
    async () => {
      const instances = await env.SAM_PULL_WORKFLOW.createBatch([{
        id: nextInstanceId,
        params: {
          checkpoint: nextCheckpoint,
          continuation: pull,
        },
        retention: { successRetention: '1 day', errorRetention: '3 days' },
      }])
      return {
        instanceId: instances[0]?.id || nextInstanceId,
        started: Boolean(instances[0]),
      }
    },
  )

  console.log(JSON.stringify({
    event: 'scheduled_sam_pull_workflow',
    status: 'continuing',
    instanceId: event?.instanceId,
    checkpoint,
    nextCheckpoint,
    nextInstanceId: scheduled.instanceId,
    runId: pull.runId,
    nextCursor: pull.nextCursor,
    totalFetched: pull.totalFetched,
    totalWritten: pull.totalWritten,
  }))

  return {
    ok: true,
    status: 'continuing',
    checkpoint,
    nextCheckpoint,
    nextInstanceId: scheduled.instanceId,
    runId: pull.runId,
    nextCursor: pull.nextCursor,
    totalFetched: pull.totalFetched,
    totalWritten: pull.totalWritten,
  }
}
