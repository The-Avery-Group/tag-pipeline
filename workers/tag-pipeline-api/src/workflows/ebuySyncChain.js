export const EBUY_ARCHIVE_FILES_PER_CHECKPOINT = 4
export const EBUY_OPPORTUNITIES_PER_CHECKPOINT = 12
const MAX_ARCHIVE_CHECKPOINTS = 1000

export function ebuyArchiveContinuationId(runId, checkpoint) {
  const safeRunId = String(runId || crypto.randomUUID())
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 70)
  return `ebuy-archive-${safeRunId}-${checkpoint}`
}

export async function scheduleEbuyArchiveContinuation({ env, step, runId, continuationKey, checkpoint, source }) {
  const nextCheckpoint = Math.max(2, Number(checkpoint || 1) + 1)
  if (nextCheckpoint > MAX_ARCHIVE_CHECKPOINTS) {
    throw new Error(`The eBuy file archive exceeded ${MAX_ARCHIVE_CHECKPOINTS} continuation checkpoints`)
  }

  // A manually resumed sync gets a new chain key, so it cannot collide with an
  // errored child retained from the previous chain. Every continuation carries
  // that stable key forward, keeping IDs short, deterministic, and idempotent.
  const chainKey = String(continuationKey || runId)
  const instanceId = ebuyArchiveContinuationId(chainKey, nextCheckpoint)
  const scheduled = await step.do(`Schedule eBuy archive checkpoint ${nextCheckpoint}`, {
    retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
    timeout: '1 minute',
  }, async () => {
    const instances = await env.EBUY_SYNC_WORKFLOW.createBatch([{
      id: instanceId,
      params: {
        mode: 'live',
        source: source || 'continuation',
        resumeRunId: runId,
        archiveCheckpoint: nextCheckpoint,
        continuationKey: chainKey,
      },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
    // createBatch is idempotent. Cloudflare excludes an already-created ID
    // from the returned array, which means an empty array is a successful
    // handoff rather than a failure.
    return {
      instanceId: instances?.[0]?.id || instanceId,
      started: Boolean(instances?.[0]),
      reused: !instances?.[0],
    }
  })

  return {
    checkpoint: nextCheckpoint,
    ...scheduled,
  }
}
