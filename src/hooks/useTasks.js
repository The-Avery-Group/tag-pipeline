import { useState, useEffect, useCallback } from 'react'
import { getTasks, addTask, updateTask, deleteTask, getNotesForContract } from '@/services/graphService'
import { notifyTaskDueSoon, notifyTaskOverdue } from '@/services/notifyService'
import { isOverdue } from '@/utils/kpiHelpers'

export function useTasks(contractNumber = null) {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all = await getTasks()
      const filtered = contractNumber
        ? all.filter((t) => t.ContractNumber === contractNumber)
        : all
      setTasks(filtered)

      // Check for overdue / due-tomorrow and fire notifications (best-effort)
      const today = new Date()
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      filtered.forEach((t) => {
        if (t.Status === 'Done') return
        if (isOverdue(t.DueDate)) notifyTaskOverdue(t).catch(() => {})
        else {
          const due = new Date(t.DueDate)
          if (!isNaN(due) && due.toDateString() === tomorrow.toDateString()) {
            notifyTaskDueSoon(t).catch(() => {})
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

  const add = useCallback(async (data, createdBy) => {
    // Auto-attach opportunity notes at creation time
    const notes = await getNotesForContract(data.ContractNumber)
    await addTask({ ...data, OpportunityNotes: notes }, createdBy)
    await load()
  }, [load])

  const update = useCallback(async (rowIndex, patch) => {
    await updateTask(rowIndex, patch)
    await load()
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    await deleteTask(rowIndex)
    await load()
  }, [load])

  const refreshContext = useCallback(async (task) => {
    const notes = await getNotesForContract(task.ContractNumber)
    await updateTask(task._rowIndex, { OpportunityNotes: notes })
    await load()
  }, [load])

  return { tasks, loading, error, refresh: load, add, update, remove, refreshContext }
}
