// A SharePoint path can legitimately contain parentheses. The markdown
// delimiter is therefore the closing parenthesis followed by whitespace or
// the end of the note, not simply the first closing parenthesis in the URL.
export const RICH_TEXT_LINK_PATTERN = /(\[(?:\\.|[^\\\]\n])+\]\(https?:\/\/.*?\)(?=\s|$)|https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi
const MARKDOWN_LINK_PATTERN = /^\[((?:\\.|[^\\\]])+)\]\((https?:\/\/.*)\)$/i

export function parseMarkdownLink(value) {
  const match = String(value || '').match(MARKDOWN_LINK_PATTERN)
  if (!match) return null
  return {
    label: match[1].replace(/\\([\\\[\]])/g, '$1'),
    href: match[2],
  }
}
