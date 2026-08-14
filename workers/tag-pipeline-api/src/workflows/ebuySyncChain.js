export const EBUY_ARCHIVE_FILES_PER_CHECKPOINT = 4
const MAX_ARCHIVE_CHECKPOINTS = 1000

export function ebuyArchiveContinuationId(runId, checkpoint) {
  const safeRunId = String(runId || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 70)
  return `ebuy-archive-${safeRunId}-${checkpoint}`
}

export async function scheduleEbuyArchiveContinuation({ env, step, runId, checkpoint, source }) {
  const nextCheckpoint = Math.max(2, Number(checkpoint || 1) + 1)
  if (nextCheckpoint > MAX_ARCHIVE_CHECKPOINTS) {
    throw new Error(`The eBuy file archive exceeded ${MAX_ARCHIVE_CHECKPOINTS} continuation checkpoints`)
  }

  const instanceId = ebuyArchiveContinuationId(runId, nextCheckpoint)
  const instances = await step.do(`Schedule eBuy archive checkpoint ${nextCheckpoint}`, async () => (
    env.EBUY_SYNC_WORKFLOW.createBatch([{
      id: instanceId,
      params: {
        mode: 'live',
        source: source || 'continuation',
        resumeRunId: runId,
        archiveCheckpoint: nextCheckpoint,
      },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
  ))

  return {
    checkpoint: nextCheckpoint,
    instanceId: instances[0]?.id || instanceId,
    started: Boolean(instances[0]),
  }
}
