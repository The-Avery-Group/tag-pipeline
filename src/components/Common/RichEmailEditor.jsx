import { useEffect, useRef, useState } from 'react'
import { decorateEmailMergeFields, sanitizeEmailHtml } from '@/utils/emailHtml'
import styles from './RichEmailEditor.module.css'

function positiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function closestCell(selection) {
  const node = selection?.anchorNode
  const element = node?.nodeType === 1 ? node : node?.parentElement
  return element?.closest?.('td, th') || null
}

function setCaretInside(element) {
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export default function RichEmailEditor({
  value,
  onChange,
  ariaLabel = 'Email body',
  allowSignature = false,
  highlightMergeFields = false,
}) {
  const editorRef = useRef(null)
  const lastEmittedRef = useRef('')
  const [tableDialogOpen, setTableDialogOpen] = useState(false)
  const [tableRows, setTableRows] = useState(2)
  const [tableColumns, setTableColumns] = useState(2)
  const [headerRow, setHeaderRow] = useState(true)
  const [tableSelected, setTableSelected] = useState(false)

  useEffect(() => {
    const sanitized = sanitizeEmailHtml(value)
    const normalized = highlightMergeFields ? decorateEmailMergeFields(sanitized) : sanitized
    if (!editorRef.current || normalized === lastEmittedRef.current) return
    editorRef.current.innerHTML = normalized
    lastEmittedRef.current = normalized
  }, [highlightMergeFields, value])

  const emit = () => {
    if (!editorRef.current) return
    const html = sanitizeEmailHtml(editorRef.current.innerHTML)
    lastEmittedRef.current = html
    onChange(html)
  }

  const updateTableSelection = () => {
    const selection = window.getSelection()
    const cell = closestCell(selection)
    setTableSelected(Boolean(cell && editorRef.current?.contains(cell)))
  }

  const command = (name, commandValue = null) => {
    editorRef.current?.focus()
    document.execCommand(name, false, commandValue)
    emit()
  }

  const insertLink = () => {
    const href = window.prompt('Enter a web or email link')
    if (!href) return
    const normalized = /^\S+@\S+\.\S+$/.test(href) ? `mailto:${href}` : href
    if (!/^(?:https?:|mailto:)/i.test(normalized)) return
    command('createLink', normalized)
  }

  const insertTable = () => {
    const rows = positiveInteger(tableRows)
    const columns = positiveInteger(tableColumns)
    const header = headerRow
      ? `<thead><tr>${Array.from({ length: columns }, (_, index) => `<th>Heading ${index + 1}</th>`).join('')}</tr></thead>`
      : ''
    const bodyRows = Array.from({ length: rows }, () =>
      `<tr>${Array.from({ length: columns }, () => '<td><br></td>').join('')}</tr>`
    ).join('')
    const html = `<table>${header}<tbody>${bodyRows}</tbody></table><p><br></p>`
    command('insertHTML', sanitizeEmailHtml(html))
    setTableDialogOpen(false)
    updateTableSelection()
  }

  const mutateTable = (action) => {
    const selection = window.getSelection()
    const cell = closestCell(selection)
    const row = cell?.closest('tr')
    const table = cell?.closest('table')
    if (!cell || !row || !table) return
    const cellIndex = [...row.children].indexOf(cell)

    if (action === 'add-row') {
      const next = row.cloneNode(true)
      ;[...next.children].forEach((item) => { item.innerHTML = '<br>'; if (item.tagName === 'TH') { const replacement = document.createElement('td'); replacement.innerHTML = '<br>'; item.replaceWith(replacement) } })
      row.parentElement.appendChild(next)
      setCaretInside(next.children[Math.max(0, cellIndex)])
    }
    if (action === 'delete-row') {
      const rows = table.querySelectorAll('tr')
      if (rows.length > 1) row.remove()
      else table.remove()
    }
    if (action === 'add-column') {
      table.querySelectorAll('tr').forEach((currentRow) => {
        const source = currentRow.children[Math.min(cellIndex, currentRow.children.length - 1)]
        const next = document.createElement(source?.tagName === 'TH' ? 'th' : 'td')
        next.innerHTML = source?.tagName === 'TH' ? `Heading ${currentRow.children.length + 1}` : '<br>'
        currentRow.appendChild(next)
      })
    }
    if (action === 'delete-column') {
      table.querySelectorAll('tr').forEach((currentRow) => currentRow.children[cellIndex]?.remove())
      if (!table.querySelector('td, th')) table.remove()
    }
    if (action === 'delete-table') table.remove()
    emit()
  }

  const insertSignature = () => {
    command('insertHTML', '<div data-email-signature="true"><p><br></p></div>')
  }

  const handlePaste = (event) => {
    event.preventDefault()
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
  }

  return (
    <div className={styles.editorShell}>
      <div className={styles.toolbar} role="toolbar" aria-label="Email formatting">
        <button type="button" title="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => command('bold')}><strong>B</strong></button>
        <button type="button" title="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => command('italic')}><em>I</em></button>
        <button type="button" title="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => command('underline')}><u>U</u></button>
        <span className={styles.divider} />
        <button type="button" title="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => command('insertUnorderedList')}>• List</button>
        <button type="button" title="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => command('insertOrderedList')}>1. List</button>
        <span className={styles.divider} />
        <button type="button" title="Insert link" onMouseDown={(event) => event.preventDefault()} onClick={insertLink}>Link</button>
        <button type="button" title="Insert table" onMouseDown={(event) => event.preventDefault()} onClick={() => setTableDialogOpen((open) => !open)}>Table</button>
        {allowSignature && <button type="button" title="Insert protected signature block" onMouseDown={(event) => event.preventDefault()} onClick={insertSignature}>Signature</button>}
        <span className={styles.divider} />
        <button type="button" title="Undo" onMouseDown={(event) => event.preventDefault()} onClick={() => command('undo')}>Undo</button>
        <button type="button" title="Redo" onMouseDown={(event) => event.preventDefault()} onClick={() => command('redo')}>Redo</button>
        <button type="button" title="Clear formatting" onMouseDown={(event) => event.preventDefault()} onClick={() => command('removeFormat')}>Clear</button>
      </div>

      {tableDialogOpen && (
        <div className={styles.tableDialog}>
          <label>Rows<input type="number" min="1" value={tableRows} onChange={(event) => setTableRows(event.target.value)} /></label>
          <label>Columns<input type="number" min="1" value={tableColumns} onChange={(event) => setTableColumns(event.target.value)} /></label>
          <label className={styles.headerChoice}><input type="checkbox" checked={headerRow} onChange={(event) => setHeaderRow(event.target.checked)} /> Header row</label>
          <button type="button" className="btn btn-primary text-sm" onClick={insertTable}>Insert table</button>
        </div>
      )}

      {tableSelected && <div className={styles.tableActions}>
          <span>Table</span>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => mutateTable('add-row')}>+ Row</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => mutateTable('delete-row')}>− Row</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => mutateTable('add-column')}>+ Column</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => mutateTable('delete-column')}>− Column</button>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => mutateTable('delete-table')}>Delete table</button>
        </div>}

      <div
        ref={editorRef}
        className={styles.editor}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        onInput={() => { emit(); updateTableSelection() }}
        onClick={updateTableSelection}
        onKeyUp={updateTableSelection}
        onBlur={() => {
          if (!editorRef.current) return
          const html = sanitizeEmailHtml(editorRef.current.innerHTML)
          const displayHtml = highlightMergeFields ? decorateEmailMergeFields(html) : html
          editorRef.current.innerHTML = displayHtml
          lastEmittedRef.current = displayHtml
          onChange(displayHtml)
        }}
        onPaste={handlePaste}
      />
    </div>
  )
}
