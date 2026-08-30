import test from 'node:test'
import assert from 'node:assert/strict'
import { APP_UPDATE_DEFERRAL_MS, createAppUpdateDeferral, isAppUpdateDeferred, isNewerAppVersion, reloadWithCacheBypass } from '../src/services/appUpdateService.js'

test('prompts only when the deployed build is newer than the running build', () => {
  const current = { buildId: 'old', builtAt: '2026-08-15T10:00:00.000Z' }
  assert.equal(isNewerAppVersion({ buildId: 'new', builtAt: '2026-08-15T10:01:00.000Z' }, current), true)
  assert.equal(isNewerAppVersion({ buildId: 'old', builtAt: '2026-08-15T10:01:00.000Z' }, current), false)
  assert.equal(isNewerAppVersion({ buildId: 'older', builtAt: '2026-08-15T09:59:00.000Z' }, current), false)
})

test('reloads the base entry with a build-specific cache bypass and preserves the current route', () => {
  let destination = ''
  const location = {
    href: 'https://the-avery-group.github.io/tag-pipeline/opportunities?tab=New',
    replace(value) { destination = value },
  }
  reloadWithCacheBypass('release-123', location)
  const url = new URL(destination)
  assert.equal(url.origin, 'https://the-avery-group.github.io')
  // GitHub Pages must receive the known app entry URL directly. The SPA route
  // is restored by index.html after the fresh build has loaded.
  assert.equal(url.pathname, '/tag-pipeline/')
  assert.equal(url.searchParams.get('_tag_build'), 'release-123')
  assert.equal(url.searchParams.get('redirect'), '/opportunities?tab=New')
})

test('defers the same build for one hour but never suppresses a newer build', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z')
  const deferral = createAppUpdateDeferral('release-123', now)
  assert.equal(deferral.deferredUntil, now + APP_UPDATE_DEFERRAL_MS)
  assert.equal(isAppUpdateDeferred(deferral, 'release-123', now + APP_UPDATE_DEFERRAL_MS - 1), true)
  assert.equal(isAppUpdateDeferred(deferral, 'release-123', now + APP_UPDATE_DEFERRAL_MS), false)
  assert.equal(isAppUpdateDeferred(deferral, 'release-124', now + 1), false)
})
