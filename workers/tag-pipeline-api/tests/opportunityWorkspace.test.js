import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agencyAbbreviation,
  opportunityWorkspaceFolderName,
  safeSharePointSegment,
  workspaceCalendarYear,
} from '../src/lib/opportunityWorkspaceDomain.js'
import { resetWorkspaceForRebuild } from '../src/lib/opportunityWorkspaceRepository.js'
import { opportunityUploadValidation } from '../src/lib/opportunityWorkspaceSharePoint.js'

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

test('workspace rebuild clears stale SharePoint and attachment metadata together', async () => {
  const batched = []
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this },
        async first() {
          return {
            opportunity_key: 'notice-1', pipeline_id: 'notice-1', notice_id: '', solicitation_number: '',
            title: 'Test', department: '', agency: '', notice_type: 'RFI', calendar_year: 2026,
            status: 'new', progress_phase: 'Ready to rebuild', attachment_total: 0,
            archived_count: 0, failed_count: 0, created_at: '', updated_at: '', completed_at: null,
          }
        },
      }
    },
    async batch(statements) { batched.push(...statements) },
  }

  const result = await resetWorkspaceForRebuild(db, 'NOTICE-1')
  assert.equal(batched.length, 2)
  assert.match(batched[0].sql, /DELETE FROM opportunity_workspace_files/)
  assert.match(batched[1].sql, /root_folder_id = NULL/)
  assert.equal(result.status, 'new')
  assert.equal(result.rootFolderId, undefined)
})

test('opportunity reference uploads sanitize names and reject executable files', () => {
  assert.deepEqual(opportunityUploadValidation('Research #1.pdf', 1024), {
    valid: true,
    name: 'Research _1.pdf',
    size: 1024,
  })
  assert.equal(opportunityUploadValidation('run.cmd', 10).valid, false)
  assert.equal(opportunityUploadValidation('empty.docx', 0).valid, false)
})
