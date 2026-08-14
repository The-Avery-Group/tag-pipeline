import { useCallback, useEffect, useRef, useState } from 'react'
import { listPartnerWorkspaceFiles } from '@/services/partnerWorkspaceService'
import { PARTNER_FILES_CHANGED_EVENT } from '@/services/partnerReferenceUploadService'
import styles from '@/components/Opportunity/OpportunityFilesPanel.module.css'

function formatSize(bytes) {
  const value = Number(bytes || 0)
  if (!value) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`
}

function FolderRow({ item, uei, refreshToken }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const handledRefreshToken = useRef(refreshToken)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const result = await listPartnerWorkspaceFiles(uei, item.id)
      setChildren(result.items || [])
    } catch (nextError) { setError(nextError.message) } finally { setLoading(false) }
  }, [item.id, uei])
  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && !children) await load()
  }
  useEffect(() => {
    if (handledRefreshToken.current === refreshToken) return
    handledRefreshToken.current = refreshToken
    if (open) load()
  }, [load, open, refreshToken])
  return <li className={styles.treeItem}>
    <div className={styles.itemRow}>
      <button type="button" className={styles.folderButton} onClick={toggle} aria-expanded={open}>
        <span className={styles.chevron}>{open ? '⌄' : '›'}</span><span className={styles.folderIcon}>▰</span><span>{item.name}</span>{item.childCount > 0 && <small>{item.childCount}</small>}
      </button>
      <a className={styles.openLink} href={item.webUrl} target="_blank" rel="noreferrer">Open</a>
    </div>
    {open && <div className={styles.children}>
      {loading && <span className={styles.muted}>Loading…</span>}
      {error && <span className={styles.error}>{error}</span>}
      {children?.length === 0 && <span className={styles.muted}>Empty folder</span>}
      {children?.length > 0 && <FileTree items={children} uei={uei} refreshToken={refreshToken} />}
    </div>}
  </li>
}

function FileTree({ items, uei, refreshToken }) {
  return <ul className={styles.tree}>{items.map((item) => item.type === 'folder'
    ? <FolderRow key={item.id} item={item} uei={uei} refreshToken={refreshToken} />
    : <li className={styles.treeItem} key={item.id}><a className={styles.fileRow} href={item.webUrl} target="_blank" rel="noreferrer"><span className={styles.fileIcon}>□</span><span className={styles.fileName}>{item.name}</span><small>{formatSize(item.size)}</small><span className={styles.openGlyph}>↗</span></a></li>)}</ul>
}

export default function PartnerFilesPanel({ partner }) {
  const uei = String(partner?.['UEI Number'] || '').trim()
  const folderLink = String(partner?.['Link to Partner Folder'] || '').trim()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(null)
  const [parent, setParent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)
  const load = useCallback(async () => {
    if (!uei || !folderLink) return
    setLoading(true); setError('')
    try {
      const result = await listPartnerWorkspaceFiles(uei)
      setItems(result.items || []); setParent(result.parent || null)
    } catch (nextError) { setError(nextError.message) } finally { setLoading(false) }
  }, [folderLink, uei])
  useEffect(() => { if (open) load() }, [load, open])
  useEffect(() => {
    const changed = (event) => {
      if (String(event.detail?.uei || '').toUpperCase() !== uei.toUpperCase()) return
      setRefreshToken((value) => value + 1)
      if (open) load()
    }
    window.addEventListener(PARTNER_FILES_CHANGED_EVENT, changed)
    return () => window.removeEventListener(PARTNER_FILES_CHANGED_EVENT, changed)
  }, [load, open, uei])

  return <div className={styles.section}>
    <button type="button" className={styles.sectionToggle} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span><strong>Partner files</strong><small>{folderLink ? 'Browse materials saved in this partner’s SharePoint folder' : 'Link this partner to its SharePoint folder to browse files'}</small></span>
      <span className={styles.toggleMeta}><span className={styles.sectionChevron}>{open ? '⌃' : '⌄'}</span></span>
    </button>
    {open && <div className={styles.panel}>
      {!folderLink && <div className={styles.state}><strong>No partner folder linked</strong><span>Use Settings → SharePoint folder linking → Partners.</span></div>}
      {loading && <div className={styles.state}>Loading partner files…</div>}
      {error && <div className={styles.stateError}><span>{error}</span><button type="button" className="btn" onClick={load}>Try again</button></div>}
      {parent && <div className={styles.workspaceBar}><div><strong>{parent.name}</strong><span>{items?.length || 0} items</span></div><a className="btn" href={parent.webUrl || folderLink} target="_blank" rel="noreferrer">Open in SharePoint</a></div>}
      {items?.length > 0 && <FileTree items={items} uei={uei} refreshToken={refreshToken} />}
      {items?.length === 0 && !loading && !error && folderLink && <div className={styles.state}>This partner folder is empty.</div>}
    </div>}
  </div>
}
