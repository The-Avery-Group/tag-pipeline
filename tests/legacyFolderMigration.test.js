import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLegacyFolderMatches,
  normalizeMigrationText,
  scoreLegacyFolder,
} from '../src/utils/legacyFolderMigration.js'

const opportunity = {
  'Contract Number / Notice ID': 'SSN-26-7571',
  'Project Title / Description*': 'Data Analytics and Program Support',
  'Department*': 'Department of Health and Human Services',
  'Agency*': 'Centers for Disease Control and Prevention',
  'Fiscal Year': '2026',
  'Link to Folder': '',
}

const folder = {
  id: 'folder-1',
  name: 'CDC_Data Analytics and Program Support_SSN-26-7571',
  path: 'FY 2026 / Department of Health and Human Services / Centers for Disease Control and Prevention / CDC_Data Analytics and Program Support_SSN-26-7571',
  year: 'FY 2026',
  department: 'Department of Health and Human Services',
  agency: 'Centers for Disease Control and Prevention',
  webUrl: 'https://tenant.sharepoint.com/sites/Pipeline/Shared%20Documents/RFI%20Pipeline%20and%20Responses/FY%202026/HHS/CDC/folder',
}

test('normalizes punctuation, symbols, spacing, and accents for migration matching', () => {
  assert.equal(normalizeMigrationText('  RFI & Program—Support  '), 'rfi and program support')
})

test('selects and approves an exact identifier match', () => {
  const [match] = buildLegacyFolderMatches([opportunity], [folder])
  assert.equal(match.confidence, 'exact')
  assert.equal(match.selectedFolderId, folder.id)
  assert.equal(match.approved, true)
})

test('uses title and agency context when an identifier is not in the folder name', () => {
  const result = scoreLegacyFolder({ ...opportunity, 'Contract Number / Notice ID': '' }, {
    ...folder,
    name: 'CDC_Data Analytics and Program Support',
    path: 'FY 2026 / HHS / CDC / CDC_Data Analytics and Program Support',
  })
  assert.ok(result.score >= 82)
})

test('requires review when two folders are equally plausible', () => {
  const folders = [folder, { ...folder, id: 'folder-2', webUrl: `${folder.webUrl}-2` }]
  const [match] = buildLegacyFolderMatches([opportunity], folders)
  assert.equal(match.confidence, 'ambiguous')
  assert.equal(match.selectedFolderId, '')
  assert.equal(match.approved, false)
})

test('does not mistake a legacy OneDrive sharepoint.com URL for a migrated link', () => {
  const [match] = buildLegacyFolderMatches([{ ...opportunity, 'Link to Folder': 'https://tenant-my.sharepoint.com/personal/user/Documents/CDC_Data%20Analytics%20and%20Program%20Support_SSN-26-7571' }], [folder])
  assert.notEqual(match.confidence, 'linked')
})

test('recognizes only the exact scanned SharePoint destination as already linked', () => {
  const [match] = buildLegacyFolderMatches([{ ...opportunity, 'Link to Folder': `${folder.webUrl}/` }], [folder])
  assert.equal(match.confidence, 'linked')
  assert.equal(match.approved, false)
})
