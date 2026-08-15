import test from 'node:test'
import assert from 'node:assert/strict'
import { followUpCandidate, requestedFollowUpTypes } from '../src/handlers/sam.js'

const source = {
  noticeId: 'SOURCE-12345',
  solicitationNumber: 'W91-OLD-001',
  title: 'Esports program management and event support',
  department: 'DEPT OF DEFENSE',
  agency: 'DEPT OF THE ARMY',
  office: 'MICC FT KNOX',
  naicsCode: '541611',
  pocEmail: 'buyer@example.mil',
  submissionDate: '2026-01-10',
  rules: { departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Exact', titleOverlapPercent: 40 },
}

test('follow-on procurement types always include RFP and RFQ paths', () => {
  assert.deepEqual(requestedFollowUpTypes('RFP, RFQ'), ['o', 'k'])
  assert.deepEqual(requestedFollowUpTypes('RFQ'), ['o', 'k'])
})

test('weighted evidence returns a likely RFQ without requiring every exact signal', () => {
  const candidate = followUpCandidate({
    noticeId: 'RFQ-99999',
    solicitationNumber: 'W91-NEW-002',
    title: 'Esports event and league operations support',
    type: 'k',
    postedDate: '2026-03-01',
    responseDeadLine: '2026-04-01',
    fullParentPathName: 'DEPT OF DEFENSE.DEPT OF THE ARMY.DIFFERENT OFFICE',
    naicsCode: '541611',
    pointOfContact: [{ email: 'new-buyer@example.mil', fullName: 'New Buyer' }],
  }, source)

  assert.ok(candidate)
  assert.equal(candidate.type, 'k')
  assert.equal(candidate.noticeType, 'RFQ')
  assert.ok(candidate.matchScore >= 30)
  assert.ok(candidate.matchReasons.includes('Same agency'))
  assert.ok(candidate.matchReasons.includes('Same NAICS'))
})

test('weighted evidence can return an RFP following an RFQ source', () => {
  const candidate = followUpCandidate({
    noticeId: 'RFP-12345',
    solicitationNumber: 'W91-RFP-003',
    title: 'Esports program management and event support solicitation',
    type: 'o',
    postedDate: '2026-03-02',
    fullParentPathName: 'DEPT OF DEFENSE.DEPT OF THE ARMY.MICC FT KNOX',
    naicsCode: '541611',
    pointOfContact: [{ email: 'buyer@example.mil', fullName: 'Buyer' }],
  }, { ...source, noticeId: 'RFQ-SOURCE-123', submissionDate: '2026-02-01' })

  assert.ok(candidate)
  assert.equal(candidate.noticeType, 'RFP')
  assert.ok(candidate.matchReasons.includes('Same point of contact'))
})

test('organization matching tolerates SAM and eBuy department word-order differences', () => {
  const candidate = followUpCandidate({
    noticeId: 'RFP-STATE-001',
    solicitationNumber: 'STATE-NEW-001',
    title: 'Esports program management and event support solicitation',
    type: 'o',
    postedDate: '2026-03-02',
    fullParentPathName: 'Department of State.BUREAU OF EDUCATIONAL AND CULTURAL AFFAIRS',
    pointOfContact: [],
  }, { ...source, department: 'STATE, DEPARTMENT OF', agency: '', office: '', pocEmail: '' })

  assert.ok(candidate)
  assert.ok(candidate.matchReasons.includes('Same department'))
})

test('low-evidence records are excluded', () => {
  const candidate = followUpCandidate({
    noticeId: 'RFQ-UNRELATED',
    title: 'Janitorial supplies',
    type: 'k',
    postedDate: '2026-03-01',
    fullParentPathName: 'DEPARTMENT OF TRANSPORTATION.FEDERAL HIGHWAY ADMINISTRATION.OFFICE',
    naicsCode: '339999',
    pointOfContact: [],
  }, source)
  assert.equal(candidate, null)
})
