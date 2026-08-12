import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agencyAbbreviation,
  opportunityWorkspaceFolderName,
  safeSharePointSegment,
  workspaceCalendarYear,
} from '../src/lib/opportunityWorkspaceDomain.js'

test('opportunity workspace uses known agency abbreviations and a safe title', () => {
  assert.equal(agencyAbbreviation('Department of Defense Education Activity'), 'DODEA')
  assert.equal(
    opportunityWorkspaceFolderName({ agency: 'Department of Defense Education Activity', title: 'Esports: Program / Support?' }),
    'DODEA_Esports_ Program _ Support_',
  )
})

test('SharePoint folder segments remove reserved characters and trailing periods', () => {
  assert.equal(safeSharePointSegment('Office #4 / Capture. '), 'Office _4 _ Capture')
})

test('workspace year uses the supplied calendar year rather than a fiscal-year calculation', () => {
  assert.equal(workspaceCalendarYear(2026, new Date('2025-10-01T00:00:00Z')), 2026)
  assert.equal(workspaceCalendarYear('', new Date('2026-06-30T12:00:00Z')), 2026)
})
