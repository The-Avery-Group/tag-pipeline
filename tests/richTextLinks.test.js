import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdownLink, RICH_TEXT_LINK_PATTERN } from '../src/utils/richTextLinks.js'

test('SharePoint markdown links retain parentheses inside the encoded file path', () => {
  const href = 'https://example.sharepoint.com/sites/Pipeline/DHA_(Program)/7.%20Reference%20Materials/Screenshot.png'
  const note = `Attachments\n- [Screenshot.png](${href})`
  const parts = note.split(RICH_TEXT_LINK_PATTERN)
  const linkedPart = parts.find((part) => part.startsWith('[Screenshot.png]'))

  assert.deepEqual(parseMarkdownLink(linkedPart), { label: 'Screenshot.png', href })
  assert.equal(parts.join(''), note)
})

test('SharePoint markdown links do not expose their encoded path as note text', () => {
  const href = 'https://example.sharepoint.com/sites/Pipeline/DHA_(Program)/Reference%20Materials/file.png'
  const parts = `- [file.png](${href})`.split(RICH_TEXT_LINK_PATTERN)
  assert.deepEqual(parts.filter(Boolean), ['- ', `[file.png](${href})`])
})
