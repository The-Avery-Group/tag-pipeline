import test from 'node:test'
import assert from 'node:assert/strict'
import { isNewerAppVersion, reloadWithCacheBypass } from '../src/services/appUpdateService.js'

test('prompts only when the deployed build is newer than the running build', () => {
  const current = { buildId: 'old', builtAt: '2026-08-15T10:00:00.000Z' }
  assert.equal(isNewerAppVersion({ buildId: 'new', builtAt: '2026-08-15T10:01:00.000Z' }, current), true)
  assert.equal(isNewerAppVersion({ buildId: 'old', builtAt: '2026-08-15T10:01:00.000Z' }, current), false)
  assert.equal(isNewerAppVersion({ buildId: 'older', builtAt: '2026-08-15T09:59:00.000Z' }, current), false)
})

test('reloads the current route with a build-specific cache bypass', () => {
  let destination = ''
  const location = {
    href: 'https://the-avery-group.github.io/tag-pipeline/opportunities?tab=New',
    replace(value) { destination = value },
  }
  reloadWithCacheBypass('release-123', location)
  const url = new URL(destination)
  assert.equal(url.pathname, '/tag-pipeline/')
  assert.equal(url.searchParams.get('_tag_build'), 'release-123')
  assert.equal(url.searchParams.get('redirect'), '/opportunities?tab=New')
})
