import { useMemo, useRef, useState } from 'react'
import { getPipeline } from '@/services/graphService'
import { forceRefreshCache } from '@/services/dataCache'
import {
  applyLegacyFolderLinkBatch,
  scanLegacyFolderBatch,
} from '@/services/legacyFolderMigrationService'
import {
  buildLegacyFolderMatches,
  migrationConfidenceLabel,
} from '@/utils/legacyFolderMigration'
import styles from './LegacyFolderMigration.module.css'

const APPLY_BATCH_SIZE = 8

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function downloadReport(rows) {
  const headers = ['Contract or notice ID', 'Opportunity', 'Agency', 'Previous link', 'Selected SharePoint folder', 'Confidence', 'Result', 'Issue']
  const lines = [headers.map(csvCell).join(',')]
  rows.forEach((row) => lines.push([
    row.contractNumber,
    row.title,
    row.agency,
    row.originalLink ?? row.currentLink,
    row.appliedWebUrl || row.selectedFolder?.webUrl || '',
    migrationConfidenceLabel(row.confidence),
    row.applyResult?.status || 'Not applied',
    row.applyResult?.reason || '',
  ].map(csvCell).join(',')))
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `tag-crm-folder-migration-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function summary(matches) {
  return {
    ready: matches.filter((row) => row.approved && row.selectedFolderId).length,
    review: matches.filter((row) => ['possible', 'ambiguous'].includes(row.confidence)).length,
    unmatched: matches.filter((row) => row.confidence === 'unmatched').length,
    linked: matches.filter((row) => row.confidence === 'linked').length,
  }
}

export default function LegacyFolderMigration({ toast }) {
  const [folders, setFolders] = useState([])
  const [matches, setMatches] = useState([])
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [expandedFolderLists, setExpandedFolderLists] = useState(new Set())
  const scanIdRef = useRef(0)

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const rows = useMemo(() => matches.map((row) => ({ ...row, selectedFolder: folderById.get(row.selectedFolderId) || null })), [folderById, matches])
  const totals = useMemo(() => summary(rows), [rows])
  const visible = useMemo(() => rows.filter((row) => {
    if (filter === 'ready' && !(row.approved && row.selectedFolderId)) return false
    if (filter === 'review' && !['possible', 'ambiguous'].includes(row.confidence)) return false
    if (filter === 'unmatched' && row.confidence !== 'unmatched') return false
    if (filter === 'linked' && row.confidence !== 'linked') return false
    if (search.trim()) {
      const haystack = `${row.title} ${row.contractNumber} ${row.agency} ${row.selectedFolder?.path || ''}`.toLowerCase()
      if (!haystack.includes(search.trim().toLowerCase())) return false
    }
    return true
  }), [filter, rows, search])

  const updateRow = (contractNumber, updater) => {
    setMatches((current) => current.map((row) => row.contractNumber === contractNumber ? updater(row) : row))
  }

  const startScan = async () => {
    if (scanning || applying) return
    const scanId = ++scanIdRef.current
    setScanning(true)
    setError('')
    setProgress({ inspected: 0, found: 0, remaining: null })
    setExpandedFolderLists(new Set())
    try {
      await forceRefreshCache(['PipelineTable'])
      const opportunities = await getPipeline()
      const found = new Map()
      let cursor = ''
      let result
      do {
        result = await scanLegacyFolderBatch(cursor)
        if (scanId !== scanIdRef.current) return
        ;(result.folders || []).forEach((folder) => found.set(folder.id, folder))
        setProgress({ inspected: result.inspected || 0, found: found.size, remaining: result.remainingLocations || 0 })
        cursor = result.cursor || ''
      } while (!result.complete)
      const nextFolders = [...found.values()].sort((left, right) => left.path.localeCompare(right.path))
      setFolders(nextFolders)
      setMatches(buildLegacyFolderMatches(opportunities, nextFolders))
      setFilter('all')
      toast?.success(`Folder scan completed · ${nextFolders.length} opportunity folders found`)
    } catch (nextError) {
      setError(nextError.message || 'The SharePoint folder scan could not finish')
      toast?.error(`Folder scan failed: ${nextError.message}`)
    } finally {
      if (scanId === scanIdRef.current) setScanning(false)
    }
  }

  const chooseFolder = (row, folderId) => {
    updateRow(row.contractNumber, (current) => ({
      ...current,
      selectedFolderId: folderId,
      approved: Boolean(folderId),
      confidence: folderId && folderId !== current.selectedFolderId ? 'manual' : current.confidence,
      applyResult: null,
    }))
  }

  const toggleApproved = (row) => {
    if (!row.selectedFolderId || row.confidence === 'linked') return
    updateRow(row.contractNumber, (current) => ({ ...current, approved: !current.approved, applyResult: null }))
  }

  const applyApproved = async () => {
    if (applying || scanning) return
    const approved = rows.filter((row) => row.approved && row.selectedFolderId && row.contractNumber && row.confidence !== 'linked')
    if (!approved.length) {
      toast?.info('Select at least one confirmed folder match first')
      return
    }
    const confirmed = window.confirm(`Update the SharePoint folder link for ${approved.length} opportunit${approved.length === 1 ? 'y' : 'ies'}? Existing files and folders will not be changed.`)
    if (!confirmed) return
    setApplying(true)
    setError('')
    let updated = 0
    let skipped = 0
    try {
      for (let index = 0; index < approved.length; index += APPLY_BATCH_SIZE) {
        const batch = approved.slice(index, index + APPLY_BATCH_SIZE)
        setProgress({ applying: true, completed: index, total: approved.length })
        const response = await applyLegacyFolderLinkBatch(batch.map((row) => ({
          contractNumber: row.contractNumber,
          expectedCurrentLink: row.currentLink,
          folderId: row.selectedFolderId,
        })))
        updated += Number(response.updated || 0)
        skipped += Number(response.skipped || 0)
        const resultById = new Map((response.results || []).map((result) => [result.contractNumber, result]))
        setMatches((current) => current.map((row) => {
          const result = resultById.get(row.contractNumber)
          if (!result) return row
          if (['updated', 'already_linked'].includes(result.status)) {
            return {
              ...row,
              originalLink: row.originalLink ?? row.currentLink,
              currentLink: result.webUrl || row.currentLink,
              appliedWebUrl: result.webUrl || '',
              approved: false,
              confidence: 'linked',
              applyResult: result,
            }
          }
          return { ...row, approved: false, applyResult: result }
        }))
        setProgress({ applying: true, completed: Math.min(index + batch.length, approved.length), total: approved.length })
      }
      await forceRefreshCache(['PipelineTable'])
      if (updated) toast?.success(`${updated} opportunity folder link${updated === 1 ? '' : 's'} updated`)
      if (skipped) toast?.error(`${skipped} link${skipped === 1 ? ' was' : 's were'} skipped. Review the issue column before retrying.`)
    } catch (nextError) {
      setError(nextError.message || 'The approved links could not all be applied')
      toast?.error(`Folder migration stopped: ${nextError.message}`)
    } finally {
      setApplying(false)
      setProgress(null)
    }
  }

  return <div className={styles.body}>
    <div className={styles.intro}>
      <div>
        <strong>Connect copied OneDrive folders to pipeline opportunities</strong>
        <p>Copy the fiscal-year folders into SharePoint first. This tool only reviews and updates CRM folder links; it never moves, renames, or deletes files.</p>
      </div>
      <div className={styles.topActions}>
        {matches.length > 0 && <button type="button" className="btn" onClick={() => downloadReport(rows)}>Download report</button>}
        <button type="button" className="btn btn-primary" onClick={startScan} disabled={scanning || applying}>
          {scanning ? 'Scanning…' : matches.length ? 'Scan again' : 'Scan SharePoint folders'}
        </button>
      </div>
    </div>

    {progress && <div className={styles.progressBlock}>
      <div className={styles.progressText}>
        {progress.applying
          ? <>Updating approved links <strong>{progress.completed} of {progress.total}</strong></>
          : <>Scanning SharePoint <strong>{progress.found} folders found</strong><span>{progress.inspected} locations checked{progress.remaining !== null ? ` · ${progress.remaining} queued` : ''}</span></>}
      </div>
      <div className={styles.progressTrack}><span className={progress.applying ? styles.progressFill : styles.progressScan} style={{ width: progress.applying && progress.total ? `${Math.round(progress.completed / progress.total * 100)}%` : '35%' }} /></div>
    </div>}

    {error && <div className={styles.errorCallout}>{error}</div>}

    {matches.length > 0 && <>
      <div className={styles.summaryGrid}>
        <button type="button" className={filter === 'ready' ? styles.summaryActive : ''} onClick={() => setFilter(filter === 'ready' ? 'all' : 'ready')}><strong>{totals.ready}</strong><span>Ready to apply</span></button>
        <button type="button" className={filter === 'review' ? styles.summaryActive : ''} onClick={() => setFilter(filter === 'review' ? 'all' : 'review')}><strong>{totals.review}</strong><span>Need review</span></button>
        <button type="button" className={filter === 'unmatched' ? styles.summaryActive : ''} onClick={() => setFilter(filter === 'unmatched' ? 'all' : 'unmatched')}><strong>{totals.unmatched}</strong><span>Unmatched</span></button>
        <button type="button" className={filter === 'linked' ? styles.summaryActive : ''} onClick={() => setFilter(filter === 'linked' ? 'all' : 'linked')}><strong>{totals.linked}</strong><span>Already linked</span></button>
      </div>

      <div className={styles.reviewToolbar}>
        <input className="form-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search opportunity, agency, ID, or folder…" />
        <span>{visible.length} shown</span>
        <button type="button" className="btn btn-primary" onClick={applyApproved} disabled={applying || scanning || totals.ready === 0}>
          {applying ? 'Applying…' : `Apply ${totals.ready} approved`}
        </button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead><tr><th>Use</th><th>Opportunity</th><th>Current location</th><th>SharePoint folder</th><th>Match</th><th>Issue</th></tr></thead>
          <tbody>{visible.map((row) => {
            const showAll = expandedFolderLists.has(row.contractNumber)
            const optionFolders = showAll ? folders : row.candidates.map((candidate) => candidate.folder)
            return <tr key={row.contractNumber || row.title}>
              <td><input type="checkbox" checked={row.approved} disabled={!row.selectedFolderId || row.confidence === 'linked'} onChange={() => toggleApproved(row)} aria-label={`Use folder match for ${row.title}`} /></td>
              <td><strong>{row.title}</strong><span>{[row.contractNumber, row.agency].filter(Boolean).join(' · ')}</span></td>
              <td>{row.currentLink ? <a href={row.currentLink} target="_blank" rel="noreferrer">{row.confidence === 'linked' ? 'SharePoint' : 'Existing link'} ↗</a> : <span className={styles.muted}>No folder link</span>}</td>
              <td>
                {row.confidence === 'linked'
                  ? <span className={styles.linkedText}>Already connected</span>
                  : <div className={styles.folderPicker}>
                      <select className="form-select" value={row.selectedFolderId} onChange={(event) => chooseFolder(row, event.target.value)}>
                        <option value="">Select a SharePoint folder…</option>
                        {optionFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                      </select>
                      {!showAll && folders.length > optionFolders.length && <button type="button" onClick={() => setExpandedFolderLists((current) => new Set(current).add(row.contractNumber))}>Browse all</button>}
                      {row.selectedFolder && <a href={row.selectedFolder.webUrl} target="_blank" rel="noreferrer">Open ↗</a>}
                    </div>}
              </td>
              <td><span className={`${styles.confidence} ${styles[`confidence_${row.confidence}`] || ''}`} title={row.reason}>{migrationConfidenceLabel(row.confidence)}</span><small>{row.reason}</small></td>
              <td className={row.applyResult?.status === 'skipped' ? styles.issue : ''}>{row.applyResult?.reason || (row.applyResult?.status === 'updated' ? 'Updated' : '—')}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
    </>}
  </div>
}
