import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { detectStatementMapping, inspectTransactionStatement, normalizeTransactionInspection } from '@/utils/transactionStatement'
import {
  createTransactionExport,
  createTransactionRule,
  downloadCsv,
  getTransactionBatches,
  getTransactionCodingStatus,
  getTransactionExport,
  getTransactionExports,
  getTransactionRules,
  getTransactions,
  importTransactionStatement,
  updateTransaction,
} from '@/services/transactionCodingService'
import styles from './TransactionCoding.module.css'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', hour12: true })
const emptyRule = { matchType: 'contains', matchPattern: '', vendor: '', vendorId: '', project: '', account: '', organization: '', priority: 100, active: true }

function amount(cents) { return money.format(Number(cents || 0) / 100) }
function when(value) { return value ? dateTime.format(new Date(value)) : '—' }
function statusLabel(row) { return row.exportedAt ? 'Exported' : row.status === 'uncategorized' ? 'Uncategorized' : row.status === 'review' ? 'Needs review' : 'Ready' }
function notify(toast, message, type = 'info') {
  const method = type === 'warning' ? 'info' : type
  toast?.[method]?.(message)
}

export default function TransactionCoding({ toast }) {
  const inputRef = useRef(null)
  const [tab, setTab] = useState('review')
  const [status, setStatus] = useState(null)
  const [batches, setBatches] = useState([])
  const [selectedBatch, setSelectedBatch] = useState('')
  const [transactions, setTransactions] = useState([])
  const [exports, setExports] = useState([])
  const [rules, setRules] = useState([])
  const [preview, setPreview] = useState(null)
  const [inspection, setInspection] = useState(null)
  const [headerIndex, setHeaderIndex] = useState(0)
  const [mapping, setMapping] = useState({})
  const [mappingError, setMappingError] = useState('')
  const [editing, setEditing] = useState(null)
  const [ruleDraft, setRuleDraft] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [archive, setArchive] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [csvPreview, setCsvPreview] = useState(null)

  const loadBase = useCallback(async () => {
    try {
      const [nextStatus, nextBatches, nextExports, nextRules] = await Promise.all([
        getTransactionCodingStatus(), getTransactionBatches(), getTransactionExports(), getTransactionRules(),
      ])
      setStatus(nextStatus); setBatches(nextBatches); setExports(nextExports); setRules(nextRules)
      setSelectedBatch((current) => current || nextBatches[0]?.id || '')
      setError(nextStatus.ready ? '' : nextStatus.error || 'Transaction Coding is unavailable.')
    } catch (loadError) { setError(loadError.message) }
  }, [])

  const loadRows = useCallback(async () => {
    if (!selectedBatch) { setTransactions([]); return }
    try { setTransactions(await getTransactions(selectedBatch, filter, search)) }
    catch (loadError) { setError(loadError.message) }
  }, [selectedBatch, filter, search])

  useEffect(() => { loadBase() }, [loadBase])
  useEffect(() => { const timer = setTimeout(loadRows, search ? 250 : 0); return () => clearTimeout(timer) }, [loadRows, search])
  useEffect(() => {
    if (!inspection) return undefined
    let active = true
    const timer = setTimeout(async () => {
      try {
        const normalized = await normalizeTransactionInspection(inspection, { headerIndex, mapping })
        if (active) { setPreview(normalized); setMappingError('') }
      } catch (mappingIssue) {
        if (active) { setPreview(null); setMappingError(mappingIssue.message) }
      }
    }, 120)
    return () => { active = false; clearTimeout(timer) }
  }, [inspection, headerIndex, mapping])

  const batch = batches.find((item) => item.id === selectedBatch)
  const totals = useMemo(() => transactions.reduce((result, row) => ({ ...result, amount: result.amount + row.amountCents }), { amount: 0 }), [transactions])

  const chooseFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('parse'); setError('')
    try {
      const nextInspection = await inspectTransactionStatement(file)
      setInspection(nextInspection)
      setHeaderIndex(nextInspection.headerIndex)
      setMapping(nextInspection.mapping)
      setPreview(null)
      setMappingError('')
    } catch (parseError) { setError(parseError.message) }
    finally { setBusy('') }
  }

  const runImport = async () => {
    if (!preview || busy) return
    setBusy('import')
    try {
      const result = await importTransactionStatement(preview)
      await loadBase()
      setSelectedBatch(result.batch.id); setPreview(null); setInspection(null); setTab('review')
      const message = result.duplicate
        ? 'This statement was already imported. Its existing review is open.'
        : `${result.batch.rowCount} transactions imported.`
      notify(toast, result.warning ? `${message} ${result.warning}` : message, result.warning ? 'warning' : result.duplicate ? 'info' : 'success')
    } catch (importError) { setError(importError.message) }
    finally { setBusy('') }
  }

  const changeHeaderRow = (value) => {
    const nextIndex = Number(value)
    setHeaderIndex(nextIndex)
    setMapping(detectStatementMapping(inspection?.sourceRows?.[nextIndex] || []))
  }

  const setMappedColumn = (field, value) => {
    setMapping((current) => {
      const next = { ...current }
      if (value === '') delete next[field]
      else {
        next[field] = Number(value)
      }
      return next
    })
  }

  const saveEdit = async () => {
    if (!editing || busy) return
    setBusy('save')
    try {
      const result = await updateTransaction(editing.id, editing)
      setTransactions((rows) => rows.map((row) => row.id === result.transaction.id ? result.transaction : row))
      setEditing(null); await loadBase()
      notify(toast, result.warning || 'Transaction saved.', result.warning ? 'warning' : 'success')
    } catch (saveError) { setError(saveError.message) }
    finally { setBusy('') }
  }

  const runExport = async () => {
    if (!selectedBatch || busy) return
    setBusy('export')
    try {
      const result = await createTransactionExport({ batchId: selectedBatch, archive })
      downloadCsv(result.csv, result.export.fileName)
      await Promise.all([loadBase(), loadRows()])
      notify(toast, result.warning || `${result.export.rowCount} ready transactions exported.`, result.warning ? 'warning' : 'success')
    } catch (exportError) { setError(exportError.message) }
    finally { setBusy('') }
  }

  const openExport = async (item, download = false) => {
    try {
      const full = await getTransactionExport(item.id)
      if (download) downloadCsv(full.csv, full.fileName)
      else setCsvPreview(full)
    } catch (previewError) { setError(previewError.message) }
  }

  const saveRule = async () => {
    if (!ruleDraft?.matchPattern || busy) return
    setBusy('rule')
    try { await createTransactionRule(ruleDraft); setRuleDraft(null); setRules(await getTransactionRules(true)); notify(toast, 'Rule saved to the workbook.', 'success') }
    catch (ruleError) { setError(ruleError.message) }
    finally { setBusy('') }
  }

  return (
    <div className={styles.page}>
      <Topbar title="Transaction Coding" subtitle1="Normalize, categorize, review, and export statement transactions" showFilter={false} showNew={false}
        rightContent={status?.workspace?.folderUrl && <a className="btn btn-secondary btn-sm" href={status.workspace.folderUrl} target="_blank" rel="noreferrer">Open SharePoint</a>} />

      <main className={styles.content}>
        {error && <div className={styles.error}><span>{error}</span><button onClick={() => { setError(''); loadBase() }}>Try again</button></div>}
        <div className={styles.tabRow} role="tablist">
          <button className={tab === 'review' ? styles.activeTab : ''} onClick={() => setTab('review')}>Import and review</button>
          <button className={tab === 'history' ? styles.activeTab : ''} onClick={() => setTab('history')}>Export history <span>{exports.length}</span></button>
          <button className={tab === 'rules' ? styles.activeTab : ''} onClick={() => setTab('rules')}>Saved rules <span>{rules.length}</span></button>
        </div>

        {tab === 'review' && <>
          <section className={styles.importCard}>
            <div><h2>Import statement</h2><p>Upload a CSV or XLSX file. Column names and transaction fields are recognized automatically.</p></div>
            <input ref={inputRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={chooseFile} />
            <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => inputRef.current?.click()}>{busy === 'parse' ? 'Reading…' : 'Choose statement'}</button>
          </section>

          {inspection && <section className={styles.previewCard}>
            <div className={styles.previewTitle}><div><strong>{inspection.fileName}</strong><span>Review the detected columns before importing.</span></div>{preview && <span>{preview.rows.length} transactions recognized · {preview.skippedCount} rows skipped</span>}</div>
            <label className={styles.headerSelector}><span>Header row</span><select value={headerIndex} onChange={(event) => changeHeaderRow(event.target.value)}>{inspection.sourceRows.slice(0, 15).map((row, index) => <option key={index} value={index}>Row {index + 1}: {row.filter(Boolean).slice(0, 4).join(' · ').slice(0, 90)}</option>)}</select></label>
            <div className={styles.mappingGrid}>
              {[
                ['transactionDate', 'Transaction date', false], ['rawDescription', 'Description', true],
                ['amount', 'Amount', false],
                ['location', 'Location', false], ['city', 'City', false],
              ].map(([field, label, required]) => <label key={field}><span>{label}{required ? ' *' : ''}</span><select value={mapping[field] ?? ''} onChange={(event) => setMappedColumn(field, event.target.value)}><option value="">Not mapped</option>{(inspection.sourceRows[headerIndex] || []).map((header, index) => <option key={`${field}-${index}`} value={index}>{header || `Column ${index + 1}`}</option>)}</select></label>)}
            </div>
            <p className={styles.mappingHint}>Description and Amount are required.</p>
            {mappingError && <div className={styles.mappingError}>{mappingError}</div>}
            {preview && <div className={styles.normalizedPreview}><h3>Normalized preview</h3><div><table><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody>{preview.rows.slice(0, 6).map((row) => <tr key={row.sourceHash}><td>{row.transactionDate || '—'}</td><td>{row.rawDescription}</td><td>{amount(row.amountCents)}</td></tr>)}</tbody></table></div></div>}
            <div className={styles.previewActions}><button className="btn btn-secondary" onClick={() => { setInspection(null); setPreview(null) }}>Cancel</button><button className="btn btn-primary" onClick={runImport} disabled={!preview || Boolean(busy)}>{busy === 'import' ? 'Importing…' : 'Import transactions'}</button></div>
          </section>}

          <section className={styles.workspace}>
            <div className={styles.controls}>
              <select value={selectedBatch} onChange={(event) => setSelectedBatch(event.target.value)} aria-label="Statement import">
                <option value="">Select a statement</option>{batches.map((item) => <option key={item.id} value={item.id}>{item.fileName} · {when(item.createdAt)}</option>)}
              </select>
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transactions…" aria-label="Search transactions" />
              <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Coding status"><option value="">All statuses</option><option value="uncategorized">Uncategorized</option><option value="review">Needs review</option><option value="ready">Ready</option></select>
            </div>
            {batch && <div className={styles.summary}>
              <div><strong>{batch.rowCount}</strong><span>Transactions</span></div><div><strong>{batch.uncategorizedCount}</strong><span>Uncategorized</span></div><div><strong>{batch.reviewCount}</strong><span>Needs review</span></div><div><strong>{batch.readyCount}</strong><span>Ready</span></div><div><strong>{amount(batch.totalCents)}</strong><span>Statement total</span></div>
            </div>}
            <div className={styles.tableWrap}>
              <table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Vendor</th><th>Project</th><th>Account</th><th>Organization</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                <tbody>{transactions.map((row) => <tr key={row.id}><td>{row.transactionDate || '—'}</td><td><strong>{row.rawDescription}</strong></td><td className={row.amountCents < 0 ? styles.credit : ''}>{amount(row.amountCents)}</td><td>{row.vendor || '—'}</td><td>{row.project || '—'}</td><td>{row.account || '—'}</td><td>{row.organization || '—'}</td><td><span className={`${styles.status} ${styles[row.exportedAt ? 'exported' : row.status]}`}>{statusLabel(row)}</span></td><td><button className={styles.reviewBtn} onClick={() => setEditing({ ...row, rememberRule: false, rulePattern: row.rawDescription, ruleMatchType: 'contains' })}>Review</button></td></tr>)}</tbody>
              </table>
              {!transactions.length && <div className={styles.empty}>{selectedBatch ? 'No transactions match these filters.' : 'Choose a statement to begin reviewing transactions.'}</div>}
            </div>
            {batch && <div className={styles.exportBar}><label><input type="checkbox" checked={archive} onChange={(event) => setArchive(event.target.checked)} /> Save a copy to SharePoint</label><span>{transactions.length} shown · {amount(totals.amount)}</span><button className="btn btn-primary" onClick={runExport} disabled={!batch.readyCount || Boolean(busy)}>{busy === 'export' ? 'Exporting…' : 'Export ready CSV'}</button></div>}
          </section>
        </>}

        {tab === 'history' && <section className={styles.panel}><div className={styles.panelHeader}><div><h2>Export history</h2><p>Exports and transaction data are retained for 60 days.</p></div></div><div className={styles.tableWrap}><table><thead><tr><th>File</th><th>Created</th><th>Rows</th><th>Total</th><th>Archive</th><th>Actions</th></tr></thead><tbody>{exports.map((item) => <tr key={item.id}><td><strong>{item.fileName}</strong></td><td>{when(item.createdAt)}</td><td>{item.rowCount}</td><td>{amount(item.totalCents)}</td><td>{item.archived ? 'Saved to SharePoint' : 'Not saved'}</td><td className={styles.rowActions}><button onClick={() => openExport(item)}>Preview</button><button onClick={() => openExport(item, true)}>Download</button>{item.sharePointUrl && <a href={item.sharePointUrl} target="_blank" rel="noreferrer">Open</a>}</td></tr>)}</tbody></table>{!exports.length && <div className={styles.empty}>No exports yet.</div>}</div></section>}

        {tab === 'rules' && <section className={styles.panel}><div className={styles.panelHeader}><div><h2>Categorization rules</h2><p>The SharePoint workbook is the editable source; refresh after direct workbook changes.</p></div><div><button className="btn btn-secondary" onClick={async () => setRules(await getTransactionRules(true))}>Refresh workbook</button> <button className="btn btn-primary" onClick={() => setRuleDraft({ ...emptyRule, id: crypto.randomUUID() })}>Add rule</button></div></div><div className={styles.tableWrap}><table><thead><tr><th>Pattern</th><th>Match</th><th>Vendor</th><th>Vendor ID</th><th>Project</th><th>Account</th><th>Organization</th><th>Priority</th></tr></thead><tbody>{rules.map((rule) => <tr key={rule.id}><td><strong>{rule.matchPattern}</strong></td><td>{rule.matchType}</td><td>{rule.vendor || '—'}</td><td>{rule.vendorId || '—'}</td><td>{rule.project || '—'}</td><td>{rule.account || '—'}</td><td>{rule.organization || '—'}</td><td>{rule.priority}</td></tr>)}</tbody></table>{!rules.length && <div className={styles.empty}>No saved rules. Review a transaction and select Remember this mapping, or add a rule here.</div>}</div></section>}
      </main>

      {editing && <div className={styles.drawerBackdrop} onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}><aside className={styles.drawer}><div className={styles.drawerHeader}><div><span>Review transaction</span><strong>{amount(editing.amountCents)}</strong></div><button onClick={() => setEditing(null)} aria-label="Close">×</button></div><p className={styles.raw}>{editing.rawDescription}</p><div className={styles.formGrid}>{['vendor','vendorId','project','account','organization'].map((field) => <label key={field}><span>{field.replace(/([A-Z])/g, ' $1')}</span><input value={editing[field] || ''} onChange={(event) => setEditing({ ...editing, [field]: event.target.value })} /></label>)}</div><label className={styles.remember}><input type="checkbox" checked={editing.rememberRule} onChange={(event) => setEditing({ ...editing, rememberRule: event.target.checked })} /> Remember this coding for future transactions</label>{editing.rememberRule && <div className={styles.ruleInline}><label><span>Match pattern</span><input value={editing.rulePattern} onChange={(event) => setEditing({ ...editing, rulePattern: event.target.value })} /></label><select value={editing.ruleMatchType} onChange={(event) => setEditing({ ...editing, ruleMatchType: event.target.value })}><option value="contains">Contains</option><option value="starts_with">Starts with</option><option value="exact">Exact</option><option value="regex">Regular expression</option></select></div>}<div className={styles.drawerFooter}><button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={saveEdit} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save transaction'}</button></div></aside></div>}

      {ruleDraft && <Modal title="Add categorization rule" onClose={() => setRuleDraft(null)} footer={<><button className="btn btn-secondary" onClick={() => setRuleDraft(null)}>Cancel</button><button className="btn btn-primary" onClick={saveRule} disabled={!ruleDraft.matchPattern || Boolean(busy)}>Save rule</button></>}><div className={styles.formGrid}>{['matchPattern','vendor','vendorId','project','account','organization'].map((field) => <label key={field}><span>{field.replace(/([A-Z])/g, ' $1')}</span><input value={ruleDraft[field] || ''} onChange={(event) => setRuleDraft({ ...ruleDraft, [field]: event.target.value })} /></label>)}</div></Modal>}
      {csvPreview && <Modal title={csvPreview.fileName} onClose={() => setCsvPreview(null)} footer={<button className="btn btn-primary" onClick={() => downloadCsv(csvPreview.csv, csvPreview.fileName)}>Download CSV</button>}><pre className={styles.csvPreview}>{csvPreview.csv.split('\n').slice(0, 12).join('\n')}</pre><p className={styles.previewNote}>Showing the first 11 transaction rows.</p></Modal>}
    </div>
  )
}
