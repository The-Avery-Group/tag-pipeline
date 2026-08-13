const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  'app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'exe', 'gadget', 'hta', 'inf', 'ins',
  'isp', 'jar', 'js', 'jse', 'lnk', 'mjs', 'msc', 'msi', 'msp', 'mst', 'pif',
  'ps1', 'reg', 'scr', 'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'ws', 'wsc',
  'wsf', 'wsh',
])

function extensionOf(name) {
  const normalized = String(name || '').trim()
  return normalized.includes('.') ? normalized.split('.').pop().toLowerCase() : ''
}

export function validateOpportunityReferenceFile(file) {
  if (!file?.name) return 'Choose a file with a valid name.'
  if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0) return `${file.name} is empty and cannot be uploaded.`
  if (BLOCKED_UPLOAD_EXTENSIONS.has(extensionOf(file.name))) {
    return `${file.name} is an executable or script file and cannot be uploaded.`
  }
  return ''
}

function escapeMarkdownLabel(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

export function noteWithReferenceLinks(noteText, uploadedFiles) {
  const text = String(noteText || '').trim()
  const links = (uploadedFiles || [])
    .filter((file) => file?.webUrl)
    .map((file) => `- [${escapeMarkdownLabel(file.name || 'Reference material')}](${file.webUrl})`)
  if (!links.length) return text
  const attachmentBlock = ['Attachments', ...links].join('\n')
  return [text, attachmentBlock].filter(Boolean).join('\n\n')
}
