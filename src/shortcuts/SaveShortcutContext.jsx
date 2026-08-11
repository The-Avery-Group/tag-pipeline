import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import Modal from '@/components/Common/Modal'

const SaveShortcutContext = createContext(null)

function mostSpecificRegistration(registrations, activeElement) {
  const scoped = registrations.filter((registration) => {
    const element = registration.scopeRef?.current
    return element && activeElement && element.contains(activeElement)
  })
  if (!scoped.length) return registrations.length === 1 ? registrations[0] : registrations[registrations.length - 1]

  return scoped.reduce((best, candidate) => {
    const bestElement = best.scopeRef?.current
    const candidateElement = candidate.scopeRef?.current
    return bestElement?.contains(candidateElement) ? candidate : best
  })
}

export function SaveShortcutProvider({ children }) {
  const registrationsRef = useRef(new Map())
  const [pending, setPending] = useState(null)

  useEffect(() => {
    const handleShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return
      if (pending) return
      const registrations = [...registrationsRef.current.values()].filter((registration) => registration.enabled)
      if (!registrations.length) return
      const registration = mostSpecificRegistration(registrations, document.activeElement)
      if (!registration) return
      event.preventDefault()
      setPending(registration)
    }
    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [pending])

  const register = useCallback((registration) => {
    registrationsRef.current.set(registration.id, registration)
    return () => registrationsRef.current.delete(registration.id)
  }, [])

  const confirmSave = () => {
    const action = pending?.actionRef?.current
    setPending(null)
    if (action) Promise.resolve().then(() => action())
  }

  return (
    <SaveShortcutContext.Provider value={register}>
      {children}
      {pending && (
        <Modal
          title="Save changes?"
          onClose={() => setPending(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setPending(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={confirmSave} autoFocus>Save</button>
            </>
          )}
        >
          <p className="text-sm" style={{ margin: 0, color: 'var(--gray-600)', lineHeight: 1.6 }}>
            Save {pending.label || 'these changes'}?
          </p>
        </Modal>
      )}
    </SaveShortcutContext.Provider>
  )
}

export function useSaveShortcut({ enabled, label, onSave, scopeRef = null }) {
  const register = useContext(SaveShortcutContext)
  const id = useId()
  const actionRef = useRef(onSave)
  actionRef.current = onSave

  useEffect(() => {
    if (!register) return undefined
    return register({ id, enabled: Boolean(enabled), label, actionRef, scopeRef })
  }, [enabled, id, label, register, scopeRef])
}
