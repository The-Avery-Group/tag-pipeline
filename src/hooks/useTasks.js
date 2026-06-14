import { useState, useEffect, useCallback } from 'react'
import { getTasks, addTask, updateTask, deleteTask, getNotesForContract } from '@/services/graphService'
import { notifyTaskCreated } from '@/services/notifyService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useTasks(contractNumber = null) {
  const [tasks, setTasks]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all = await getTasks()
      const filtered = contractNumber
        ? all.filter((t) => t.ContractNumber === contractNumber)
        : all
      setTasks(filtered)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [contractNumber])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh(load)
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
    await invalidateCache()
  }, [])

  const update = useCallback(async (rowIndex, patch) => {
    const safePatch = { ...patch }
    if (safePatch.DueDate instanceof Date) {
      safePatch.DueDate = safePatch.DueDate.toISOString().split('T')[0]
    }
    await updateTask(rowIndex, safePatch)
    await invalidateCache()
  }, [])

  const remove = useCallback(async (rowIndex) => {
    await deleteTask(rowIndex)
    await invalidateCache()
  }, [])

  const refreshContext = useCallback(async (task) => {
    const notes = await getNotesForContract(task.ContractNumber)
    await updateTask(task._rowIndex, { OpportunityNotes: notes })
    await invalidateCache()
  }, [])

  return { tasks, loading, error, refresh: load, add, update, remove, refreshContext }
}
