import { useCallback, useEffect, useState } from 'react'
import {
  addContactInteraction,
  getContactInteractions,
} from '@/services/graphService'
import {
  forceRefreshCache,
  onCacheRefresh,
  publishCacheUpdate,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { createStableId } from '@/services/workbookMutations'

export function useContactEngagement(enabled = false) {
  const [interactions, setInteractions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      setInteractions(await getContactInteractions())
    } catch (err) {
      setInteractions(null)
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    load()
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) return undefined
    return onCacheRefresh((tables) => {
      if (tables?.includes('ContactInteractionsTable')) return load({ silent: true })
      return undefined
    })
  }, [enabled, load])

  const addInteraction = useCallback(async (data) => {
    const interactionId = createStableId('CI')
    const optimistic = {
      ...data,
      InteractionID: interactionId,
      _rowIndex: -1,
      _temp: true,
    }
    setInteractions((current) => [...(current || []), optimistic])
    try {
      const saved = await addContactInteraction(data, interactionId)
      setInteractions((current) => (current || []).map((interaction) =>
        interaction.InteractionID === interactionId ? saved : interaction
      ))
      await publishCacheUpdate(['ContactInteractionsTable'])
      verifyCacheInBackground(['ContactInteractionsTable'])
      return saved
    } catch (err) {
      setInteractions((current) => (current || []).filter(
        (interaction) => interaction.InteractionID !== interactionId
      ))
      throw err
    }
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['ContactInteractionsTable']).catch(() => {})
    await load()
  }, [load])

  return {
    interactions: interactions || [],
    interactionsConfigured: interactions !== null,
    loading,
    error,
    refresh,
    addInteraction,
  }
}
