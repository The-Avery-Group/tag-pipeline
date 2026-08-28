import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getOpportunityWorkspace,
  listOpportunityWorkspaceFiles,
  requestOpportunityWorkspace,
  retryOpportunityWorkspace,
} from '@/services/opportunityWorkspaceService'
import { OPPORTUNITY_FILES_CHANGED_EVENT } from '@/services/opportunityReferenceUploadService'
import styles from './OpportunityFilesPanel.module.css'

function formatSize(bytes) {
  const value = Number(bytes || 0)
  if (!value) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`
}

function FolderRow({ item, opportunityKey, refreshToken }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [children, setChildren] = useState(null)
  const [error, setError] = useState('')
  const handledRefreshToken = useRef(refreshToken)

  const loadChildren = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listOpportunityWorkspaceFiles(opportunityKey, item.id)
      setChildren(result.items || [])
    } catch (nextError) {
      setError(nextError.message)
    } finally {
      setLoading(false)
    }
  }, [item.id, opportunityKey])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (!next || children) return
    await loadChildren()
  }

  useEffect(() => {
    if (handledRefreshToken.current === refreshToken) return
    handledRefreshToken.current = refreshToken
    if (open) loadChildren()
  }, [open, refreshToken, loadChildren])

  return <li className={styles.treeItem}>
    <div className={styles.itemRow}>
      <button type="button" className={styles.folderButton} onClick={toggle} aria-expanded={open}>
        <span className={styles.chevron}>{open ? '⌄' : '›'}</span>
        <span className={styles.folderIcon} aria-hidden="true">▰</span>
        <span>{item.name}</span>
        {item.childCount > 0 && <small>{item.childCount}</small>}
      </button>
      <a className={styles.openLink} href={item.webUrl} target="_blank" rel="noreferrer" title={`Open ${item.name} in SharePoint`}>Open</a>
    </div>
    {open && <div className={styles.children}>
      {loading && <span className={styles.muted}>Loading…</span>}
      {error && <span className={styles.error}>{error}</span>}
      {children && children.length === 0 && <span className={styles.muted}>Empty folder</span>}
      {children && children.length > 0 && <FileTree items={children} opportunityKey={opportunityKey} refreshToken={refreshToken} />}
    </div>}
  </li>
}

function FileTree({ items, opportunityKey, refreshToken = 0 }) {
  return <ul className={styles.tree}>
    {items.map((item) => item.type === 'folder'
      ? <FolderRow key={item.id} item={item} opportunityKey={opportunityKey} refreshToken={refreshToken} />
      : <li className={styles.treeItem} key={item.id}><a className={styles.fileRow} href={item.webUrl} target="_blank" rel="noreferrer">
          <span className={styles.fileIcon} aria-hidden="true">□</span>
          <span className={styles.fileName}>{item.name}</span>
          <small>{formatSize(item.size)}</small>
          <span className={styles.openGlyph}>↗</span>
        </a></li>)}
  </ul>
}

function workspaceDescription(workspace, missing) {
  if (!workspace) return missing ? 'SharePoint workspace has not been set up.' : 'Browse the SharePoint workspace and archived SAM.gov files'
  if (workspace.status === 'ready') return workspace.attachmentTotal > 0
    ? `${workspace.archivedCount} of ${workspace.attachmentTotal} SAM.gov attachments saved`
    : workspace.progressPhase || 'SharePoint workspace is ready'
  if (workspace.status === 'partial') return workspace.progressPhase || 'Workspace is ready, with some items needing attention.'
  if (workspace.status === 'error') return workspace.errorMessage || 'Workspace setup needs attention.'
  return workspace.progressPhase || 'Preparing SharePoint workspace…'
}

export default function OpportunityFilesPanel({ opportunity, toast }) {
  const opportunityKey = String(opportunity?.['Contract Number / Notice ID'] || '').trim()
  const [open, setOpen] = useState(false)
  const [workspace, setWorkspace] = useState(null)
  const [items, setItems] = useState(null)
  const [loading, setLoading] = useState(false)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const actionRef = useRef(false)

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!opportunityKey) return
    if (!quiet) setLoading(true)
    setError('')
    try {
      const result = await getOpportunityWorkspace(opportunityKey)
      const nextWorkspace = result.workspace
      setWorkspace(nextWorkspace)
      setMissing(false)
      if (nextWorkspace?.rootFolderId && ['ready', 'partial'].includes(nextWorkspace.status)) {
        const listing = await listOpportunityWorkspaceFiles(opportunityKey, nextWorkspace.typeFolderId || '')
        setItems(listing.items || [])
        if (listing.parent?.webUrl && listing.parent.webUrl !== nextWorkspace.webUrl) {
          setWorkspace((current) => current ? { ...current, webUrl: listing.parent.webUrl } : current)
        }
      }
    } catch (nextError) {
      if (nextError.status === 404) {
        setMissing(true)
        setWorkspace(null)
        setItems(null)
      } else {
        setError(nextError.message)
      }
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [opportunityKey])

  useEffect(() => {
    if (!open) return undefined
    load()
    return undefined
  }, [open, load])

  useEffect(() => {
    if (!open || !['queued', 'running'].includes(workspace?.status)) return undefined
    const timer = window.setInterval(() => load({ quiet: true }), 3500)
    return () => window.clearInterval(timer)
  }, [open, workspace?.status, load])

  useEffect(() => {
    const handleFilesChanged = (event) => {
      if (String(event.detail?.opportunityKey || '') !== opportunityKey) return
      setRefreshToken((value) => value + 1)
      if (open) load({ quiet: true })
    }
    window.addEventListener(OPPORTUNITY_FILES_CHANGED_EVENT, handleFilesChanged)
    return () => window.removeEventListener(OPPORTUNITY_FILES_CHANGED_EVENT, handleFilesChanged)
  }, [load, open, opportunityKey])

  const setup = async ({ retry = false } = {}) => {
    if (actionRef.current) return
    actionRef.current = true
    setLoading(true)
    setError('')
    try {
      if (retry && workspace) await retryOpportunityWorkspace(opportunityKey, opportunity)
      else await requestOpportunityWorkspace(opportunity)
      toast?.success(retry ? 'Workspace recovery started' : 'SharePoint workspace setup started')
      await load({ quiet: true })
    } catch (nextError) {
      setError(nextError.message)
      toast?.error(`Workspace setup could not start: ${nextError.message}`)
    } finally {
      actionRef.current = false
      setLoading(false)
    }
  }

  const statusClass = workspace?.status === 'ready'
    ? styles.ready
    : workspace?.status === 'error'
      ? styles.failed
      : workspace?.status === 'partial'
        ? styles.partial
        : styles.working

  return <section id="overview-files" className={styles.section}>
    <button type="button" className={styles.sectionToggle} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span><strong>Opportunity files</strong><small>{workspaceDescription(workspace, missing)}</small></span>
      <span className={styles.toggleMeta}>
        {workspace && <span className={`${styles.status} ${statusClass}`}>{workspace.status}</span>}
        <span className={styles.sectionChevron}>{open ? '⌃' : '⌄'}</span>
      </span>
    </button>
    {open && <div className={styles.panel}>
      {loading && !workspace && <div className={styles.state}>Loading opportunity files…</div>}
      {missing && !loading && <div className={styles.state}><strong>No SharePoint workspace yet</strong><span>Set up the standard opportunity folder and save available SAM.gov attachments.</span><button type="button" className="btn btn-primary" onClick={() => setup()}>Set up workspace</button></div>}
      {error && <div className={styles.stateError}><span>{error}</span><button type="button" className="btn" onClick={() => workspace ? setup({ retry: true }) : load()}>{workspace ? 'Repair workspace' : 'Try again'}</button></div>}
      {workspace && <>
        <div className={styles.workspaceBar}>
          <div><strong>{workspace.progressPhase || 'SharePoint workspace'}</strong><span>{workspace.archivedCount} saved · {workspace.failedCount} need attention</span></div>
          <div className={styles.actions}>
            {(workspace.typeFolderWebUrl || workspace.webUrl) && <a className="btn" href={workspace.typeFolderWebUrl || workspace.webUrl} target="_blank" rel="noreferrer">Open in SharePoint</a>}
            {['error', 'partial'].includes(workspace.status) && <button type="button" className="btn" onClick={() => setup({ retry: true })} disabled={loading}>Retry setup</button>}
          </div>
        </div>
        {['queued', 'running'].includes(workspace.status) && <div className={styles.progress}><span /></div>}
        {items && items.length > 0 && <FileTree items={items} opportunityKey={opportunityKey} refreshToken={refreshToken} />}
        {items && items.length === 0 && ['ready', 'partial'].includes(workspace.status) && <div className={styles.state}>The opportunity workspace is empty.</div>}
      </>}
    </div>}
  </section>
}
