import { useCallback, useRef, useState } from 'react'

/**
 * useAsyncAction
 *
 * Shared primitive for "is something happening right now" feedback (per the
 * CRM improvement asking for consistent in-progress indicators everywhere,
 * so users never have to guess whether a click registered and don't fire
 * the same action twice).
 *
 * Wraps a single async action with:
 *   - isLoading:  boolean for disabling the button / swapping its label
 *   - run(fn):    re-entrancy guarded — a second call while one is already
 *                 in flight is ignored rather than firing a duplicate write
 *
 * Use this for buttons where only one instance of the action can be
 * happening at a time (Save, Delete, Add, Trigger pull, etc).
 *
 * Usage:
 *   const { run, isLoading } = useAsyncAction()
 *   <button disabled={isLoading} onClick={() => run(() => saveThing(), {
 *     onError: (err) => toast?.error(err.message),
 *   })}>
 *     {isLoading ? 'Saving…' : 'Save'}
 *   </button>
 */
export function useAsyncAction() {
  const [isLoading, setIsLoading] = useState(false)
  const inFlight = useRef(false)

  const run = useCallback(async (fn, { onError } = {}) => {
    if (inFlight.current) return   // ignore rapid double-clicks / re-submits
    inFlight.current = true
    setIsLoading(true)
    try {
      return await fn()
    } catch (err) {
      onError?.(err)
      throw err
    } finally {
      inFlight.current = false
      setIsLoading(false)
    }
  }, [])

  return { run, isLoading }
}

/**
 * useAsyncActionKeyed
 *
 * Same idea as useAsyncAction, but for tables/lists where several rows can
 * each have their own independent action in flight at once (e.g. per-row
 * dismiss/delete buttons). Tracks a set of in-flight keys instead of one
 * boolean, so isPending(key) tells you whether *that specific row* is busy
 * without disabling the whole table.
 *
 * Usage:
 *   const { run, isPending } = useAsyncActionKeyed()
 *   <button disabled={isPending(row.id)} onClick={() =>
 *     run(row.id, () => dismiss(row.id), { onError: (err) => toast?.error(err.message) })
 *   }>
 *     {isPending(row.id) ? '…' : 'Dismiss'}
 *   </button>
 */
export function useAsyncActionKeyed() {
  // Guard lives in a ref (synchronous, immune to any re-render timing issues);
  // the state counter below exists only to force a re-render so isPending()
  // reflects the latest ref contents after each change.
  const inFlightKeys = useRef(new Set())
  const [, forceRender] = useState(0)

  const run = useCallback(async (key, fn, { onError } = {}) => {
    if (inFlightKeys.current.has(key)) return
    inFlightKeys.current.add(key)
    forceRender((n) => n + 1)
    try {
      return await fn()
    } catch (err) {
      onError?.(err)
      throw err
    } finally {
      inFlightKeys.current.delete(key)
      forceRender((n) => n + 1)
    }
  }, [])

  const isPending = useCallback((key) => inFlightKeys.current.has(key), [])
  const pendingCount = inFlightKeys.current.size

  return { run, isPending, pendingCount }
}