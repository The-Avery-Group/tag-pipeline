import { forwardRef, useCallback, useLayoutEffect, useRef } from 'react'

// Shared by all multiline editors. Keep sizing local: no document-wide
// observers or polling, and no changes to controlled values or event behavior.
const AutoTextarea = forwardRef(function AutoTextarea({ onInput, ...props }, forwardedRef) {
  const elementRef = useRef(null)
  const setRef = useCallback((element) => {
    elementRef.current = element
    if (typeof forwardedRef === 'function') forwardedRef(element)
    else if (forwardedRef) forwardedRef.current = element
  }, [forwardedRef])

  const resize = useCallback(() => {
    const element = elementRef.current
    if (!element || !element.getClientRects().length) return
    // Reset before measuring so removing text also shrinks the editor.
    element.style.height = 'auto'
    const style = getComputedStyle(element)
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const height = element.scrollHeight + (style.boxSizing === 'border-box' ? border : -padding)
    element.style.height = `${Math.ceil(height)}px`
  }, [])

  // Runs after controlled/programmatic changes as well as the initial mount.
  useLayoutEffect(resize)
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    let previousWidth = -1
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width
      if (width === previousWidth) return
      previousWidth = width
      resize()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [resize])

  return <textarea {...props} ref={setRef} onInput={(event) => {
    onInput?.(event)
    resize()
  }} />
})

export default AutoTextarea
