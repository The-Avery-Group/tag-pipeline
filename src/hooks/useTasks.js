import { useState, useEffect, useCallback, useRef } from 'react'
import { getTasks, addTask, updateTask, deleteTask, getNotesForContract } from '@/services/graphService'
import { notifyTaskCreated } from '@/services/notifyService'
import {
  forceRefreshCache,
  invalidateCache,
  onCacheRefresh,
  publishCacheUpdate,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { createStableId, retryIdempotent } from '@/services/workbookMutations'

export function useTasks(contractNumber = null, { enabled = true } = {}) {
  const [tasks, setTasks]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)
  const tasksRef = useRef([])

  useEffect(() => { tasksRef.current = tasks }, [tasks])

  // Tracks in-flight field patches (e.g. Status toggles) not yet confirmed
  // by a server read, so a racing refresh — the background poll, or any
  // other hook's invalidateCache() call anywhere in the app — can't clobber
  // an edit before the write has actually landed. Keyed by stable TaskID.
  const pendingPatches = useRef(new Map())

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!enabled) { setLoading(false); return }
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
        const identity = String(t.TaskID || '').trim()
        const patch = pendingPatches.current.get(identity)
        if (!patch) return t
        const confirmed = Object.keys(patch).every((k) => t[k] === patch[k])
        if (confirmed) {
          pendingPatches.current.delete(identity)
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
  }, [contractNumber, enabled])

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
    const taskId = createStableId('T')
    const optimistic = {
      ...taskData,
      TaskID: taskId,
      Status: 'To Do',
      CreatedBy: createdBy,
      CreatedDate: new Date().toISOString().split('T')[0],
      UpdatedDate: new Date().toISOString().split('T')[0],
      _rowIndex: -1,
    }
    setTasks((current) => current.some((task) => task.TaskID === taskId)
      ? current
      : [...current, optimistic])
    try {
      const saved = await addTask(taskData, createdBy, taskId)
      setTasks((current) => current.map((task) => task.TaskID === taskId ? saved : task))
      if (!saved._alreadyExisted) {
        notifyTaskCreated({ ...saved, CreatedBy: createdBy }).catch(() => {})
      }
      await publishCacheUpdate(['TasksTable'])
      verifyCacheInBackground(['TasksTable'])
      return saved
    } catch (error) {
      setTasks((current) => current.filter((task) => task.TaskID !== taskId))
      throw error
    }
  }, [])

  const update = useCallback(async (rowIndex, patch) => {
    const original = tasksRef.current.find((task) => task._rowIndex === rowIndex)
    const identity = String(original?.TaskID || '').trim()
    const safePatch = { ...patch }
    if (safePatch.DueDate instanceof Date) {
      safePatch.DueDate = safePatch.DueDate.toISOString().split('T')[0]
    }
    if (identity) pendingPatches.current.set(identity, safePatch)
    // Optimistic update — apply patch immediately
    setTasks((prev) =>
      prev.map((t) => t._rowIndex === rowIndex ? { ...t, ...safePatch } : t)
    )
    try {
      await retryIdempotent(() => updateTask(rowIndex, safePatch, original))
      await publishCacheUpdate(['TasksTable'])
      verifyCacheInBackground(['TasksTable'])
    } catch (err) {
      // A conflicting Excel edit must not remain on screen as though it was
      // saved. Reload the authoritative row and let the caller show the
      // specific conflict message.
      if (identity) pendingPatches.current.delete(identity)
      await load()
      throw err
    }
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    const original = tasksRef.current.find((task) => task._rowIndex === rowIndex)
    setTasks((current) => current.filter((task) => task._rowIndex !== rowIndex))
    try {
      await retryIdempotent(() => deleteTask(rowIndex, original))
      await publishCacheUpdate(['TasksTable'])
      verifyCacheInBackground(['TasksTable'])
    } catch (error) {
      await load()
      throw error
    }
  }, [load])

  const refreshContext = useCallback(async (task) => {
    const notes = await getNotesForContract(task.ContractNumber)
    await retryIdempotent(() => updateTask(task._rowIndex, { OpportunityNotes: notes }, task))
    await invalidateCache(['TasksTable'])
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['TasksTable']).catch(() => {})
    await load()
  }, [load])

  return { tasks, loading, error, refresh, add, update, remove, refreshContext }
}
