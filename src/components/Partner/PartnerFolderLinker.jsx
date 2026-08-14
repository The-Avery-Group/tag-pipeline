import { useEffect, useMemo, useState } from 'react'
import Modal from '@/components/Common/Modal'
import { applyPartnerWorkspaceLinks, scanPartnerWorkspaceFolders } from '@/services/partnerWorkspaceService'
import styles from './PartnerWorkspace.module.css'

export default function PartnerFolderLinker({ open = true, inline = false, onClose = () => {}, onComplete, toast }) {
  const [scan, setScan] = useState(null)
  const [selections, setSelections] = useState({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const acceptScan = (result) => {
    setScan(result)
    setSelections(Object.fromEntries((result.partners || []).map((partner) => [partner.uei, partner.suggestedFolderId || ''])))
  }
  useEffect(() => {
    if (!open) return
    setLoading(true); setError('')
    scanPartnerWorkspaceFolders()
      .then(acceptScan)
      .catch((nextError) => setError(nextError.message))
      .finally(() => setLoading(false))
  }, [open])
  const mappings = useMemo(() => (scan?.partners || []).flatMap((partner) => {
    const folderId = selections[partner.uei]
    return folderId && folderId !== partner.linkedFolderId
      ? [{ uei: partner.uei, folderId, expectedCurrentLink: partner.currentLink || '' }]
      : []
  }), [scan, selections])
  const apply = async () => {
    if (!mappings.length) return
    setSaving(true); setError('')
    try {
      const result = await applyPartnerWorkspaceLinks(mappings)
      if (result.updated) toast?.success(`${result.updated} partner folder${result.updated === 1 ? '' : 's'} linked`)
      if (result.skipped) toast?.error(`${result.skipped} partner link${result.skipped === 1 ? ' was' : 's were'} skipped because the workbook changed. Review and try again.`)
      await onComplete?.()
      if (inline) acceptScan(await scanPartnerWorkspaceFolders())
      else onClose()
    } catch (nextError) { setError(nextError.message) } finally { setSaving(false) }
  }
  if (!open) return null
  const body = <div className={inline ? styles.inline : ''}>
    <div className={styles.linkerIntro}>Folders are matched from <strong>Partners</strong> beside the workbook. Exact, unique name matches are preselected; ambiguous matches require review.</div>
    {loading && <div className={styles.linkerState}>Checking SharePoint folders and workbook columns…</div>}
    {error && <div className={styles.linkerError}>{error}</div>}
    {scan && <div className={styles.linkerRows}>{scan.partners.map((partner) => <div className={styles.linkerRow} key={partner.uei}>
      <div><strong>{partner.partnerName}</strong><small>{partner.uei}{partner.currentLink ? ' · Already linked' : partner.status === 'matched' ? ' · Exact match found' : partner.status === 'ambiguous' ? ' · Choose the correct folder' : ' · No exact match'}</small></div>
      {partner.status === 'linked'
        ? <a href={partner.currentLink} target="_blank" rel="noreferrer">Open linked folder</a>
        : <select className="form-input" value={selections[partner.uei] || ''} onChange={(event) => setSelections((current) => ({ ...current, [partner.uei]: event.target.value }))}>
            <option value="">Do not link yet</option>
            {(scan.folders || []).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
          </select>}
    </div>)}</div>}
    {inline && <div className={styles.inlineActions}><button className="btn btn-primary" disabled={saving || !mappings.length} onClick={apply}>{saving ? 'Linking…' : `Apply ${mappings.length} selected`}</button></div>}
  </div>
  if (inline) return body
  return <Modal title="Link SharePoint partner folders" onClose={() => !saving && onClose()} footer={<><button className="btn" disabled={saving} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving || !mappings.length} onClick={apply}>{saving ? 'Linking…' : `Link ${mappings.length || ''} selected`}</button></>}>{body}</Modal>
}
