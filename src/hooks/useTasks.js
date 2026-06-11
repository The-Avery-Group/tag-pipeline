import { useState, useEffect, useCallback, useRef } from 'react'
import { getTasks, addTask, updateTask, deleteTask, getNotesForContract } from '@/services/graphService'
import { notifyTaskDueSoon, notifyTaskOverdue } from '@/services/notifyService'
import { isOverdue } from '@/utils/kpiHelpers'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useTasks(contractNumber = null) {
  const [tasks, setTasks]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)
  const notifiedIds = useRef(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all = await getTasks()
      const filtered = contractNumber
        ? all.filter((t) => t.ContractNumber === contractNumber)
        : all
      setTasks(filtered)

      const today    = new Date()
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      filtered.forEach((t) => {
        if (t.Status === 'Done') return
        const key = `${t.TaskID}-${t.DueDate}`
        if (notifiedIds.current.has(key)) return
        if (isOverdue(t.DueDate)) {
          notifyTaskOverdue(t).catch(() => {})
          notifiedIds.current.add(key)
        } else {
          const due = new Date(t.DueDate)
          if (!isNaN(due) && due.toDateString() === tomorrow.toDateString()) {
            notifyTaskDueSoon(t).catch(() => {})
            notifiedIds.current.add(key)
          }
        }
      })
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
    await addTask({ ...data, DueDate: dueDate, OpportunityNotes: notes }, createdBy)
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