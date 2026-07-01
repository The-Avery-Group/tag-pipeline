import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// Module-level (survives component unmount/remount within the SPA session,
// but intentionally NOT sessionStorage/localStorage — scroll position for a
// page you haven't visited in a while shouldn't survive an actual browser
// reload, only in-app back/forward navigation).
const scrollPositions = new Map()

// This app uses React Router's declarative <BrowserRouter>/<Routes> (see
// App.jsx), not the data router (createBrowserRouter/RouterProvider), so
// the built-in <ScrollRestoration> component isn't available regardless of
// react-router-dom version — hence this custom hook.

/**
 * useScrollRestoration
 *
 * Saves a list page's scroll position before navigating away (e.g. into a
 * detail page) and restores it when navigating back, so the user lands
 * where they left off instead of at the top.
 *
 * Most pages render their content inside the standard `.page-body` scroll
 * container (see global.css) and can just call this with no arguments.
 * Pages with their own bespoke scroll container (e.g. Tasks' `.listPane`)
 * should pass a ref to that container instead.
 *
 * Usage — standard pages (Opportunities, PipelineBoard, Dashboard, …):
 *   useScrollRestoration()
 *
 * Usage — pages with a custom scroll container:
 *   const listRef = useRef(null)
 *   useScrollRestoration(listRef)
 *   <div ref={listRef} className={styles.listPane}>...</div>
 */
export function useScrollRestoration(containerRef) {
  const location = useLocation()
  const key = location.pathname

  const getContainer = () => containerRef?.current || document.querySelector('.page-body')

  // Restore. Retries across a bounded number of animation frames rather
  // than a single attempt, since list content is usually still loading
  // (async data fetch) right after mount — restoring scrollTop against a
  // container that's still short (e.g. a loading skeleton) would silently
  // fail once real content grows it taller a moment later.
  useEffect(() => {
    const saved = scrollPositions.get(key)
    if (!saved) return

    let attempts = 0
    let raf
    const tryRestore = () => {
      const el = getContainer()
      if (el && el.scrollHeight - el.clientHeight >= saved) {
        el.scrollTop = saved
        return
      }
      attempts++
      if (attempts < 30) raf = requestAnimationFrame(tryRestore)   // ~0.5s at 60fps — generous for async data to arrive
    }
    raf = requestAnimationFrame(tryRestore)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Save continuously while scrolling (not just on unmount) so navigating
  // away at any moment still has an up-to-date position to restore later.
  useEffect(() => {
    const el = getContainer()
    if (!el) return
    const onScroll = () => { scrollPositions.set(key, el.scrollTop) }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}