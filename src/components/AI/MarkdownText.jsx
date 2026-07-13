/**
 * MarkdownText — lightweight markdown renderer for AI responses.
 * Handles: bold, italic, inline code, numbered lists, bullet lists,
 * headers (h1-h3), horizontal rules, Markdown tables, and line breaks.
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

function splitTableRow(line) {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  const cells = []
  let cell = ''
  let escaped = false
  for (const char of value) {
    if (char === '|' && !escaped) {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += char
    escaped = char === '\\' && !escaped
    if (char !== '\\') escaped = false
  }
  cells.push(cell.trim())
  return cells.map((value) => value.replace(/\\\|/g, '|'))
}

function isTableDivider(line) {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function tableAlignment(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

export default function MarkdownText({ content, className }) {
  if (!content) return null

  // Also normalizes legacy/history responses produced before the Worker-side
  // response rule was introduced.
  const lines = String(content).replace(/\u2014/g, ' - ').split('\n')
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

    // Markdown table — a header row followed by a |---| separator row.
    if (trimmed.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1].trim())) {
      const headers = splitTableRow(trimmed)
      const alignments = splitTableRow(lines[i + 1].trim()).map(tableAlignment)
      const rows = []
      i += 2

      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
        const cells = splitTableRow(lines[i].trim())
        rows.push(cells.slice(0, headers.length))
        i++
      }

      elements.push(
        <div key={`table-${i}`} style={{ overflowX: 'auto', margin: '8px 0', border: '0.5px solid var(--gray-200)', borderRadius: 6 }}>
          <table style={{ width: '100%', minWidth: 'max-content', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--gray-50)' }}>
                {headers.map((header, index) => (
                  <th key={index} style={{ padding: '7px 9px', borderBottom: '0.5px solid var(--gray-200)', textAlign: alignments[index] || 'left', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {parseInline(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex} style={{ padding: '7px 9px', borderBottom: rowIndex < rows.length - 1 ? '0.5px solid var(--gray-100)' : 'none', textAlign: alignments[cellIndex] || 'left', verticalAlign: 'top', lineHeight: 1.45 }}>
                      {parseInline(row[cellIndex] || '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

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
