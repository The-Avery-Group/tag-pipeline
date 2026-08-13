import { parseMarkdownLink, RICH_TEXT_LINK_PATTERN } from '@/utils/richTextLinks'

export default function RichText({ value, className = '' }) {
  if (value === null || value === undefined || value === '') return null
  const parts = String(value).split(RICH_TEXT_LINK_PATTERN)
  return (
    <span className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part
        const markdown = parseMarkdownLink(part)
        if (markdown) return <a key={`${markdown.href}-${index}`} href={markdown.href} target="_blank" rel="noreferrer">{markdown.label}</a>
        const href = part.toLowerCase().startsWith('www.') ? `https://${part}` : part
        return <a key={`${href}-${index}`} href={href} target="_blank" rel="noreferrer">{part}</a>
      })}
    </span>
  )
}
