import { useState, useCallback, useRef } from 'react'

export function useToast() {
  const [toasts, setToasts] = useState([])
  const counter = useRef(0)

  const addToast = useCallback((message, type = 'info', options = {}) => {
    const settings = typeof options === 'number' ? { duration: options } : options
    const duration = Number(settings?.duration) || 4000
    const id = ++counter.current
    const dismiss = () => setToasts((prev) => prev.filter((toast) => toast.id !== id))
    const action = settings?.action?.label && typeof settings.action.onClick === 'function'
      ? {
          label: settings.action.label,
          onClick: () => {
            dismiss()
            void Promise.resolve(settings.action.onClick()).catch(() => {})
          },
        }
      : null
    setToasts((prev) => [...prev, { id, message, type, action }])
    setTimeout(() => {
      dismiss()
    }, duration)
  }, [])

  const toast = {
    success: (msg, options) => addToast(msg, 'success', options),
    error: (msg, options) => addToast(msg, 'error', options),
    info: (msg, options) => addToast(msg, 'info', options),
  }

  return { toasts, toast }
}
