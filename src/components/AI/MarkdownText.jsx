/**
 * MarkdownText — lightweight markdown renderer for AI responses.
 * Handles: bold, italic, inline code, numbered lists, bullet lists,
 * headers (h1-h3), horizontal rules, and line breaks.
 * No external dependencies.
 */

function parseInline(text) {
  // Process inline formatting: bold, italic, inline code
  const parts = []
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g
  let last = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) parts.push(<strong key={match.index}>{match[2]}</strong>)
    else if (match[3]) parts.push(<em key={match.index}>{match[4]}</em>)
    else if (match[5]) parts.push(<code key={match.index} style={{
      background: 'var(--gray-100)', padding: '1px 5px',
      borderRadius: 3, fontSize: '0.9em', fontFamily: 'monospace',
    }}>{match[6]}</code>)
    last = match.index + match[0].length
  }

  if (last < text.length) parts.push(text.slice(last))
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts
}

export default function MarkdownText({ content, className }) {
  if (!content) return null

  const lines = content.split('\n')
  const elements = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Skip empty lines (handled as spacing)
    if (!trimmed) { i++; continue }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      elements.push(<hr key={i} style={{ border: 'none', borderTop: '0.5px solid var(--gray-200)', margin: '8px 0' }} />)
      i++; continue
    }

    // Headers
    const h3 = trimmed.match(/^### (.+)/)
    const h2 = trimmed.match(/^## (.+)/)
    const h1 = trimmed.match(/^# (.+)/)
    if (h1) { elements.push(<p key={i} style={{ fontWeight: 700, fontSize: 14, margin: '8px 0 4px' }}>{parseInline(h1[1])}</p>); i++; continue }
    if (h2) { elements.push(<p key={i} style={{ fontWeight: 600, fontSize: 13, margin: '8px 0 4px' }}>{parseInline(h2[1])}</p>); i++; continue }
    if (h3) { elements.push(<p key={i} style={{ fontWeight: 600, fontSize: 12, margin: '6px 0 2px', color: 'var(--gray-600)' }}>{parseInline(h3[1])}</p>); i++; continue }

    // Numbered list — collect consecutive numbered items
    if (/^\d+\.\s/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(<li key={i} style={{ marginBottom: 3 }}>{parseInline(lines[i].trim().replace(/^\d+\.\s/, ''))}</li>)
        i++
      }
      elements.push(<ol key={`ol-${i}`} style={{ paddingLeft: 20, margin: '6px 0' }}>{items}</ol>)
      continue
    }

    // Bullet list — collect consecutive bullet items
    if (/^[-*•]\s/.test(trimmed)) {
      const items = []
      while (i < lines.length && /^[-*•]\s/.test(lines[i].trim())) {
        items.push(<li key={i} style={{ marginBottom: 3 }}>{parseInline(lines[i].trim().replace(/^[-*•]\s/, ''))}</li>)
        i++
      }
      elements.push(<ul key={`ul-${i}`} style={{ paddingLeft: 18, margin: '6px 0' }}>{items}</ul>)
      continue
    }

    // Regular paragraph
    elements.push(
      <p key={i} style={{ margin: '4px 0', lineHeight: 1.65 }}>
        {parseInline(trimmed)}
      </p>
    )
    i++
  }

  return <div className={className} style={{ fontSize: 13, color: 'inherit' }}>{elements}</div>
}