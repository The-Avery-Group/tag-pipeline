import { useState, useEffect, useCallback, useRef } from 'react'
import { getTasks, addTask, updateTask, deleteTask, getNotesForContract } from '@/services/graphService'
import { notifyTaskCreated } from '@/services/notifyService'
import { forceRefreshCache, invalidateCache, onCacheRefresh } from '@/services/dataCache'

async function retryThrice(fn) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try { return await fn() } catch (err) { lastErr = err }
  }
  throw lastErr
}

export function useTasks(contractNumber = null) {
  const [tasks, setTasks]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  // Tracks in-flight field patches (e.g. Status toggles) not yet confirmed
  // by a server read, so a racing refresh — the background poll, or any
  // other hook's invalidateCache() call anywhere in the app — can't clobber
  // an edit before the write has actually landed. Keyed by _rowIndex -> patch.
  const pendingPatches = useRef(new Map())

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const all = await getTasks()
      const filtered = contractNumber
        ? all.filter((t) => t.ContractNumber === contractNumber)
        : all
      const reconciled = filtered.map((t) => {
        const patch = pendingPatches.current.get(t._rowIndex)
        if (!patch) return t
        const confirmed = Object.keys(patch).every((k) => t[k] === patch[k])
        if (confirmed) {
          pendingPatches.current.delete(t._rowIndex)
          return t
        }
        return { ...t, ...patch }
      })
      setTasks(reconciled)
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [contractNumber])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh((tables) => {
      if (tables?.includes('TasksTable')) return load({ silent: true })
      return undefined
    })
    return unsub
  }, [load])

  const add = useCallback(async (data, createdBy) => {
    const notes   = await getNotesForContract(data.ContractNumber)
    const dueDate = data.DueDate
      ? (data.DueDate instanceof Date
          ? data.DueDate.toISOString().split('T')[0]
          : String(data.DueDate))
      : ''
    const taskData = { ...data, DueDate: dueDate, OpportunityNotes: notes }
    await addTask(taskData, createdBy)
    notifyTaskCreated({ ...taskData, CreatedBy: createdBy }).catch(() => {})
    await invalidateCache(['TasksTable'])
  }, [])

  const update = useCallback(async (rowIndex, patch) => {
    const safePatch = { ...patch }
    if (safePatch.DueDate instanceof Date) {
      safePatch.DueDate = safePatch.DueDate.toISOString().split('T')[0]
    }
    pendingPatches.current.set(rowIndex, safePatch)
    // Optimistic update — apply patch immediately
    setTasks((prev) =>
      prev.map((t) => t._rowIndex === rowIndex ? { ...t, ...safePatch } : t)
    )
    try {
      await retryThrice(() => updateTask(rowIndex, safePatch))
      await invalidateCache(['TasksTable'])
    } catch (err) {
      // A conflicting Excel edit must not remain on screen as though it was
      // saved. Reload the authoritative row and let the caller show the
      // specific conflict message.
      pendingPatches.current.delete(rowIndex)
      await load()
      throw err
    }
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    await deleteTask(rowIndex)
    await invalidateCache(['TasksTable'])
  }, [])

  const refreshContext = useCallback(async (task) => {
    const notes = await getNotesForContract(task.ContractNumber)
    await updateTask(task._rowIndex, { OpportunityNotes: notes })
    await invalidateCache(['TasksTable'])
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['TasksTable']).catch(() => {})
    await load()
  }, [load])

  return { tasks, loading, error, refresh, add, update, remove, refreshContext }
}
