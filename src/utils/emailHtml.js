const HTML_TAG_PATTERN = /<\/?(?:p|div|br|strong|b|em|i|u|ul|ol|li|a|table|thead|tbody|tr|th|td)\b/i
const SIGNATURE_PATTERN = /^(?:best|kind|warm) regards\b|^regards\b|^sincerely\b|^respectfully\b/i
const GREETING_PATTERN = /^(?:dear|hello|hi)\b/i
const ALLOWED_TAGS = new Set(['P', 'DIV', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'UL', 'OL', 'LI', 'A', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD'])
const REMOVE_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'MATH'])
const MERGE_FIELD_PATTERN = /^\{\{\s*[a-z_]+\s*\}\}$/i
const MERGE_FIELD_PARTS_PATTERN = /(\{\{\s*[a-z_]+\s*\}\})/gi

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function plainTextToEmailHtml(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim()
  if (!text) return '<p><br></p>'
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function emailHtmlToText(value) {
  return String(value || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function safeHref(value) {
  const href = String(value || '').trim()
  if (/^(?:https?:|mailto:)/i.test(href)) return href
  return ''
}

function applyEmailSafeTableStyles(element) {
  if (element.tagName === 'TABLE') {
    element.setAttribute('style', 'border-collapse:collapse;border-spacing:0;width:auto;max-width:none;')
  }
  if (element.tagName === 'TH') {
    element.setAttribute('style', 'border:1px solid #cbd5e1;padding:6px 8px;background:#eef4f8;font-weight:600;text-align:left;vertical-align:top;white-space:nowrap;')
  }
  if (element.tagName === 'TD') {
    element.setAttribute('style', 'border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top;white-space:nowrap;')
  }
}

function markDetectedSignature(container) {
  if (container.querySelector('[data-email-signature="true"]')) return
  const children = [...container.children]
  const signatureIndex = children.findIndex((child) => SIGNATURE_PATTERN.test(String(child.textContent || '').trim()))
  if (signatureIndex < 0) return
  const signature = container.ownerDocument.createElement('div')
  signature.setAttribute('data-email-signature', 'true')
  children.slice(signatureIndex).forEach((child) => signature.appendChild(child))
  container.appendChild(signature)
}

export function sanitizeEmailHtml(value) {
  const source = HTML_TAG_PATTERN.test(String(value || '')) ? String(value || '') : plainTextToEmailHtml(value)
  if (typeof DOMParser === 'undefined') return source
  const documentNode = new DOMParser().parseFromString(`<div id="email-root">${source}</div>`, 'text/html')
  const root = documentNode.getElementById('email-root')
  if (!root) return plainTextToEmailHtml(emailHtmlToText(source))

  const cleanNode = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) {
        child.remove()
        continue
      }
      if (child.nodeType !== 1) continue
      if (REMOVE_WITH_CONTENT.has(child.tagName)) {
        child.remove()
        continue
      }
      if (!ALLOWED_TAGS.has(child.tagName)) {
        cleanNode(child)
        child.replaceWith(...child.childNodes)
        continue
      }
      const href = child.tagName === 'A' ? safeHref(child.getAttribute('href')) : ''
      const isSignature = child.tagName === 'DIV' && child.getAttribute('data-email-signature') === 'true'
      const isMergeField = child.tagName === 'SPAN' &&
        child.getAttribute('data-email-merge-field') === 'true' &&
        MERGE_FIELD_PATTERN.test(String(child.textContent || '').trim())
      for (const attribute of [...child.attributes]) child.removeAttribute(attribute.name)
      if (href) {
        child.setAttribute('href', href)
        child.setAttribute('target', '_blank')
        child.setAttribute('rel', 'noreferrer')
      }
      if (isSignature) child.setAttribute('data-email-signature', 'true')
      if (isMergeField) child.setAttribute('data-email-merge-field', 'true')
      applyEmailSafeTableStyles(child)
      cleanNode(child)
    }
  }
  cleanNode(root)
  markDetectedSignature(root)
  return root.innerHTML || '<p><br></p>'
}

export function decorateEmailMergeFields(value) {
  const source = sanitizeEmailHtml(value)
  if (typeof DOMParser === 'undefined') return source
  const documentNode = new DOMParser().parseFromString(`<div id="email-root">${source}</div>`, 'text/html')
  const root = documentNode.getElementById('email-root')
  if (!root) return source

  const decorateNode = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        if (child.parentElement?.closest?.('[data-email-merge-field="true"]')) continue
        const parts = String(child.nodeValue || '').split(MERGE_FIELD_PARTS_PATTERN)
        if (parts.length < 2) continue
        const fragment = documentNode.createDocumentFragment()
        parts.forEach((part) => {
          if (!part) return
          if (MERGE_FIELD_PATTERN.test(part)) {
            const token = documentNode.createElement('span')
            token.setAttribute('data-email-merge-field', 'true')
            token.textContent = part
            fragment.appendChild(token)
          } else {
            fragment.appendChild(documentNode.createTextNode(part))
          }
        })
        child.replaceWith(fragment)
        continue
      }
      if (child.nodeType === 1) decorateNode(child)
    }
  }
  decorateNode(root)
  return sanitizeEmailHtml(root.innerHTML)
}

export function isEmptyEmailHtml(value) {
  return !emailHtmlToText(value)
}

function tableSummary(tableHtml, index) {
  const headers = [...String(tableHtml).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((match) => emailHtmlToText(match[1]))
    .filter(Boolean)
  const rows = (String(tableHtml).match(/<tr\b/gi) || []).length
  return `Table ${index}${headers.length ? `, columns: ${headers.join(', ')}` : ''}, ${rows} row${rows === 1 ? '' : 's'}`
}

export function protectEmailHtmlForAI(value) {
  let html = sanitizeEmailHtml(value)
  const fragments = []
  const protect = (type, content, summary) => {
    const marker = `[[TAG_PROTECTED_${type}_${fragments.length + 1}]]`
    fragments.push({ marker, content, summary })
    return `<p>${marker}</p>`
  }

  html = html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) =>
    protect('TABLE', table, tableSummary(table, fragments.length + 1))
  )
  html = html.replace(/<div\b[^>]*data-email-signature=["']true["'][^>]*>[\s\S]*?<\/div>/gi, (signature) =>
    protect('SIGNATURE', signature, 'Signature block')
  )
  html = html.replace(/^\s*(<(?:p|div)\b[^>]*>[\s\S]*?<\/(?:p|div)>)/i, (match, firstBlock) => {
    if (!GREETING_PATTERN.test(emailHtmlToText(firstBlock))) return match
    return protect('GREETING', firstBlock, 'Greeting')
  })

  const summaries = fragments.map(({ summary }, index) => `${index + 1}. ${summary}`).join('\n')
  return {
    html: summaries ? `${html}\n\nPROTECTED CONTENT DESCRIPTIONS:\n${summaries}` : html,
    fragments,
  }
}

function markerPattern(marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:<p\\b[^>]*>\\s*)?${escaped}(?:\\s*<\\/p>)?`, 'g')
}

export function restoreProtectedEmailHtml(value, fragments = []) {
  let html = String(value || '').replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim()
  for (const fragment of fragments) {
    const occurrences = html.split(fragment.marker).length - 1
    if (occurrences !== 1) throw new Error('AI did not preserve protected email content')
    html = html.replace(markerPattern(fragment.marker), fragment.content)
  }
  html = html.replace(/\s*PROTECTED CONTENT DESCRIPTIONS:[\s\S]*$/i, '')
  return sanitizeEmailHtml(html)
}

export function containsGenericEmailPlaceholder(value) {
  const text = emailHtmlToText(value)
  return /\[(?:your\s+)?(?:name|title|phone|email|signature|company)\]|<\s*insert\b[^>]*>|\bTBD\b/i.test(text)
}
