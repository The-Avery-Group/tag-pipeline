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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function normalizeLink(value) {
  const link = String(value || '').trim()
  if (/^\S+@\S+\.\S+$/.test(link)) return `mailto:${link}`
  if (/^www\./i.test(link)) return `https://${link}`
  return /^(?:https?:|mailto:)/i.test(link) ? link : ''
}

export default function RichEmailEditor({
  value,
  onChange,
  ariaLabel = 'Email body',
  allowSignature = false,
  highlightMergeFields = false,
}) {
  const editorRef = useRef(null)
  const shellRef = useRef(null)
  const lastEmittedRef = useRef('')
  const savedRangeRef = useRef(null)
  const [tableDialogOpen, setTableDialogOpen] = useState(false)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkHref, setLinkHref] = useState('')
  const [editingLink, setEditingLink] = useState(false)
  const [tableRows, setTableRows] = useState(2)
  const [tableColumns, setTableColumns] = useState(2)
  const [headerRow, setHeaderRow] = useState(true)
  const [tableSelected, setTableSelected] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)

  useEffect(() => {
    if (String(value || '') === lastEmittedRef.current) return
    const sanitized = sanitizeEmailHtml(value)
    const normalized = highlightMergeFields ? decorateEmailMergeFields(sanitized) : sanitized
    if (!editorRef.current || normalized === lastEmittedRef.current) return
    editorRef.current.innerHTML = normalized
    lastEmittedRef.current = normalized
    setHasSignature(Boolean(editorRef.current.querySelector('[data-email-signature="true"]')))
  }, [highlightMergeFields, value])

  useEffect(() => {
    const rememberSelection = () => {
      const selection = window.getSelection()
      if (!selection?.rangeCount || !editorRef.current) return
      const range = selection.getRangeAt(0)
      if (!editorRef.current.contains(range.commonAncestorContainer)) return
      savedRangeRef.current = range.cloneRange()
    }
    document.addEventListener('selectionchange', rememberSelection)
    return () => document.removeEventListener('selectionchange', rememberSelection)
  }, [])

  const emit = () => {
    if (!editorRef.current) return
    const html = editorRef.current.innerHTML
    lastEmittedRef.current = html
    setHasSignature(Boolean(editorRef.current.querySelector('[data-email-signature="true"]')))
    onChange(html)
  }

  const restoreSelection = () => {
    const range = savedRangeRef.current
    const editor = editorRef.current
    editor?.focus()
    const selection = window.getSelection()
    if (!range || !editor?.contains(range.commonAncestorContainer)) {
      const fallback = document.createRange()
      fallback.selectNodeContents(editor)
      fallback.collapse(false)
      selection.removeAllRanges()
      selection.addRange(fallback)
      savedRangeRef.current = fallback.cloneRange()
      return true
    }
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }

  const updateTableSelection = () => {
    const selection = window.getSelection()
    const cell = closestCell(selection)
    setTableSelected(Boolean(cell && editorRef.current?.contains(cell)))
  }

  const command = (name, commandValue = null) => {
    restoreSelection()
    document.execCommand(name, false, commandValue)
    emit()
  }

  const openLinkDialog = () => {
    const selection = window.getSelection()
    if (selection?.rangeCount && editorRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      savedRangeRef.current = selection.getRangeAt(0).cloneRange()
    }
    const node = selection?.anchorNode
    const element = node?.nodeType === 1 ? node : node?.parentElement
    const anchor = element?.closest?.('a')
    setEditingLink(Boolean(anchor && editorRef.current?.contains(anchor)))
    setLinkText(anchor?.textContent || selection?.toString() || '')
    setLinkHref(anchor?.getAttribute('href') || '')
    setTableDialogOpen(false)
    setLinkDialogOpen(true)
  }

  const applyLink = () => {
    const href = normalizeLink(linkHref)
    if (!href || !restoreSelection()) return
    const selection = window.getSelection()
    const currentNode = selection?.anchorNode
    const currentElement = currentNode?.nodeType === 1 ? currentNode : currentNode?.parentElement
    const anchor = editingLink ? currentElement?.closest?.('a') : null
    if (anchor && editorRef.current?.contains(anchor)) {
      const range = document.createRange()
      range.selectNode(anchor)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    const selectedText = selection?.toString() || ''
    const label = String(linkText || selectedText || linkHref).trim()
    document.execCommand('insertHTML', false, `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`)
    setLinkDialogOpen(false)
    setEditingLink(false)
    emit()
  }

  const removeLink = () => {
    if (!restoreSelection()) return
    const selection = window.getSelection()
    const currentNode = selection?.anchorNode
    const currentElement = currentNode?.nodeType === 1 ? currentNode : currentNode?.parentElement
    const anchor = currentElement?.closest?.('a')
    if (anchor && editorRef.current?.contains(anchor)) {
      const range = document.createRange()
      range.selectNodeContents(anchor)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    document.execCommand('unlink')
    setLinkDialogOpen(false)
    setEditingLink(false)
    emit()
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
    const editor = editorRef.current
    if (!editor || editor.querySelector('[data-email-signature="true"]')) return
    editor.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
    savedRangeRef.current = range.cloneRange()
    document.execCommand('insertHTML', false, '<div data-email-signature="true"><p><br></p></div>')
    const signature = editor.querySelector('[data-email-signature="true"]')
    if (signature) setCaretInside(signature)
    emit()
  }

  const removeSignature = () => {
    const editor = editorRef.current
    const signature = editor?.querySelector('[data-email-signature="true"]')
    if (!editor || !signature) return
    editor.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNode(signature)
    selection.removeAllRanges()
    selection.addRange(range)
    document.execCommand('delete')
    emit()
  }

  const handleEditorKeyDown = (event) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const selection = window.getSelection()
    const node = selection?.anchorNode
    const element = node?.nodeType === 1 ? node : node?.parentElement
    const signature = element?.closest?.('[data-email-signature="true"]')
    if (!signature || String(signature.textContent || '').trim()) return
    event.preventDefault()
    removeSignature()
  }

  const handlePaste = (event) => {
    event.preventDefault()
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
  }

  return (
    <div ref={shellRef} className={styles.editorShell}>
      <div className={styles.toolbar} role="toolbar" aria-label="Email formatting">
        <button type="button" title="Bold" onMouseDown={(event) => event.preventDefault()} onClick={() => command('bold')}><strong>B</strong></button>
        <button type="button" title="Italic" onMouseDown={(event) => event.preventDefault()} onClick={() => command('italic')}><em>I</em></button>
        <button type="button" title="Underline" onMouseDown={(event) => event.preventDefault()} onClick={() => command('underline')}><u>U</u></button>
        <span className={styles.divider} />
        <button type="button" title="Bulleted list" onMouseDown={(event) => event.preventDefault()} onClick={() => command('insertUnorderedList')}>• List</button>
        <button type="button" title="Numbered list" onMouseDown={(event) => event.preventDefault()} onClick={() => command('insertOrderedList')}>1. List</button>
        <span className={styles.divider} />
        <button type="button" title="Insert or edit link" onMouseDown={(event) => event.preventDefault()} onClick={openLinkDialog}>Link</button>
        <button type="button" title="Insert table" onMouseDown={(event) => event.preventDefault()} onClick={() => { setLinkDialogOpen(false); setTableDialogOpen((open) => !open) }}>Table</button>
        {allowSignature && <button type="button" title={hasSignature ? 'Remove signature' : 'Add signature at the bottom'} onMouseDown={(event) => event.preventDefault()} onClick={hasSignature ? removeSignature : insertSignature}>{hasSignature ? 'Remove signature' : 'Signature'}</button>}
        <span className={styles.divider} />
        <button type="button" title="Undo" onMouseDown={(event) => event.preventDefault()} onClick={() => command('undo')}>Undo</button>
        <button type="button" title="Redo" onMouseDown={(event) => event.preventDefault()} onClick={() => command('redo')}>Redo</button>
        <button type="button" title="Clear formatting" onMouseDown={(event) => event.preventDefault()} onClick={() => command('removeFormat')}>Clear</button>
      </div>

      {linkDialogOpen && (
        <div className={styles.linkDialog}>
          <label>Text<input value={linkText} onChange={(event) => setLinkText(event.target.value)} placeholder="Link text" /></label>
          <label>Link<input value={linkHref} onChange={(event) => setLinkHref(event.target.value)} placeholder="https://example.com" /></label>
          <div className={styles.dialogActions}>
            {editingLink && <button type="button" className="btn btn-ghost text-sm" onClick={removeLink}>Remove link</button>}
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setLinkDialogOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary text-sm" onClick={applyLink} disabled={!normalizeLink(linkHref)}>Apply</button>
          </div>
        </div>
      )}

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
        onKeyDown={handleEditorKeyDown}
        onBlur={(event) => {
          if (shellRef.current?.contains(event.relatedTarget)) return
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
