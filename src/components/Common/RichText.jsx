const URL_PATTERN = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi

export default function RichText({ value, className = '' }) {
  if (value === null || value === undefined || value === '') return null
  const parts = String(value).split(URL_PATTERN)
  return (
    <span className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {parts.map((part, index) => {
        if (index % 2 === 0) return part
        const href = part.toLowerCase().startsWith('www.') ? `https://${part}` : part
        return <a key={`${href}-${index}`} href={href} target="_blank" rel="noreferrer">{part}</a>
      })}
    </span>
  )
}
