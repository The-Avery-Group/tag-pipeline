import test from 'node:test'
import assert from 'node:assert/strict'
import {
  noteWithReferenceLinks,
  validateOpportunityReferenceFile,
} from '../src/utils/opportunityReferenceFiles.js'

test('reference uploads reject empty and executable files but allow normal documents', () => {
  assert.match(validateOpportunityReferenceFile({ name: 'payload.exe', size: 120 }), /cannot be uploaded/)
  assert.match(validateOpportunityReferenceFile({ name: 'empty.pdf', size: 0 }), /empty/)
  assert.equal(validateOpportunityReferenceFile({ name: 'research notes.pdf', size: 120 }), '')
})

test('attachment-only notes retain clickable filenames', () => {
  assert.equal(
    noteWithReferenceLinks('', [{ name: 'Market Research.pdf', webUrl: 'https://example.sharepoint.com/file' }]),
    'Attachments\n- [Market Research.pdf](https://example.sharepoint.com/file)',
  )
})

test('written notes place all attachment links beneath the note', () => {
  assert.equal(
    noteWithReferenceLinks('Useful customer research.', [
      { name: 'One.pdf', webUrl: 'https://example.sharepoint.com/one' },
      { name: 'Two.docx', webUrl: 'https://example.sharepoint.com/two' },
    ]),
    'Useful customer research.\n\nAttachments\n- [One.pdf](https://example.sharepoint.com/one)\n- [Two.docx](https://example.sharepoint.com/two)',
  )
})
