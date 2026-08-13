const LINK_PATTERN = /(\[(?:\\.|[^\\\]\n])+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi
const MARKDOWN_LINK_PATTERN = /^\[((?:\\.|[^\\\]])+)\]\((https?:\/\/[^\s)]+)\)$/i

export default function RichText({ value, className = '' }) {
  if (value === null || value === undefined || value === '') return null
  const parts = String(value).split(LINK_PATTERN)
  return (
    <span className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part
        const markdown = part.match(MARKDOWN_LINK_PATTERN)
        if (markdown) return <a key={`${markdown[2]}-${index}`} href={markdown[2]} target="_blank" rel="noreferrer">{markdown[1].replace(/\\([\\\[\]])/g, '$1')}</a>
        const href = part.toLowerCase().startsWith('www.') ? `https://${part}` : part
        return <a key={`${href}-${index}`} href={href} target="_blank" rel="noreferrer">{part}</a>
      })}
    </span>
  )
}
