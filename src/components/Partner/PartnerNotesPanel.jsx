import { useMemo, useRef, useState } from 'react'
import ActionIcon from '@/components/Common/ActionIcon'
import RichText from '@/components/Common/RichText'
import { useAuth } from '@/auth/AuthContext'
import { useNotes } from '@/hooks/useNotes'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'
import {
  announcePartnerFilesChanged,
  rollbackPartnerReferenceFiles,
  uploadPartnerReferenceFiles,
} from '@/services/partnerReferenceUploadService'
import { noteWithReferenceLinks, validateOpportunityReferenceFile } from '@/utils/opportunityReferenceFiles'
import styles from '@/pages/Partners.module.css'

function formatSize(bytes) {
  const value = Number(bytes || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`
}

export default function PartnerNotesPanel({ partner, toast }) {
  const uei = String(partner?.['UEI Number'] || '').trim().toUpperCase()
  const { user } = useAuth()
  const { notes, loading, add, update, remove } = useNotes({ type: 'Partner', id: uei })
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [fileError, setFileError] = useState('')
  const [progress, setProgress] = useState(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const fileInput = useRef(null)
  const composer = useRef(null)
  const editor = useRef(null)
  const legacyNote = String(partner?.Notes || '').trim()
  const canAdd = !adding && (Boolean(text.trim()) || attachments.length > 0)
  const progressPercent = useMemo(() => progress?.totalBytes ? Math.min(100, Math.round((progress.uploadedBytes / progress.totalBytes) * 100)) : 0, [progress])

  const chooseFiles = (event) => {
    const selected = Array.from(event.target.files || [])
    const accepted = selected.filter((file) => !validateOpportunityReferenceFile(file))
    const rejected = selected.map((file) => validateOpportunityReferenceFile(file)).filter(Boolean)
    setAttachments((current) => [...current, ...accepted]); setFileError(rejected[0] || '')
    event.target.value = ''
  }
  const submit = async () => {
    if (!canAdd) return false
    setAdding(true)
    let uploaded = []
    try {
      uploaded = attachments.length ? await uploadPartnerReferenceFiles(uei, attachments, setProgress) : []
      await add(user?.firstName || user?.displayName || 'User', noteWithReferenceLinks(text, uploaded))
      setText(''); setAttachments([]); setFileError('')
      if (uploaded.length) announcePartnerFilesChanged(uei)
      toast?.success('Partner note added')
      return true
    } catch (error) {
      if (uploaded.length) await rollbackPartnerReferenceFiles(uei, uploaded).catch(() => {})
      toast?.error(`Could not add partner note: ${error.message}`)
      return false
    } finally { setAdding(false); setProgress(null) }
  }
  const saveEdit = async () => {
    if (!editing || !draft.trim()) return
    setSaving(true)
    try { await update(editing._rowIndex, { NoteText: draft }, editing); setEditing(null); setDraft(''); toast?.success('Note updated') }
    catch (error) { toast?.error(`Could not update note: ${error.message}`) }
    finally { setSaving(false) }
  }
  const deleteNote = async (note) => {
    setDeleting(note._rowIndex)
    try { await remove(note._rowIndex); toast?.success('Note deleted') }
    catch (error) { toast?.error(`Could not delete note: ${error.message}`) }
    finally { setDeleting(null) }
  }
  useSaveShortcut({ enabled: canAdd, label: 'this partner note', onSave: submit, scopeRef: composer })
  useSaveShortcut({ enabled: Boolean(editing) && Boolean(draft.trim()) && !saving, label: 'these note changes', onSave: saveEdit, scopeRef: editor })

  return <div className={`${styles.profileSection} ${styles.notesSection}`}>
    <h3>Notes</h3>
    {legacyNote && <div className={styles.legacyNote}><span>Legacy partner note</span><RichText value={legacyNote} /></div>}
    {loading ? <div className="skeleton" style={{ height: 55 }} /> : notes.length === 0 && !legacyNote ? <p className="text-sm text-muted">No partner notes yet.</p> : notes.map((note) => <div className={styles.noteItem} key={note.NoteID}>
      <div className={styles.noteMeta}><span>{note.Date} · {note.Author}</span><button type="button" onClick={() => { setEditing(note); setDraft(note.NoteText || '') }} title="Edit note" aria-label="Edit note"><ActionIcon name="edit" /></button><button type="button" onClick={() => deleteNote(note)} disabled={deleting === note._rowIndex} title="Delete note" aria-label="Delete note">{deleting === note._rowIndex ? '…' : <ActionIcon name="delete" />}</button></div>
      {editing?._rowIndex === note._rowIndex ? <div ref={editor} className={styles.noteEditor}><textarea className="form-input" rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button type="button" className="btn btn-primary text-sm" onClick={saveEdit} disabled={saving || !draft.trim()}>{saving ? 'Saving…' : 'Save note'}</button><button type="button" className="btn text-sm" onClick={() => setEditing(null)} disabled={saving}>Cancel</button></div></div> : <RichText value={note.NoteText} />}
    </div>)}
    <div ref={composer} className={styles.noteComposer}>
      <textarea className="form-input" rows={3} placeholder="Add a partner note…" value={text} onChange={(event) => setText(event.target.value)} />
      <input ref={fileInput} className={styles.hiddenFileInput} type="file" multiple onChange={chooseFiles} />
      {attachments.length > 0 && <div className={styles.attachments}>{attachments.map((file, index) => <div key={`${file.name}-${file.size}-${index}`}><ActionIcon name="attachment" /><span>{file.name}</span><small>{formatSize(file.size)}</small><button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</div>}
      {fileError && <div className={styles.fileError}>{fileError}</div>}
      {progress && <div className={styles.uploadProgress}><div><span>{progress.fileName} · {progress.fileIndex + 1} of {progress.fileCount}</span><strong>{progressPercent}%</strong></div><div><span style={{ width: `${progressPercent}%` }} /></div></div>}
      <div className={styles.composerActions}><button type="button" className="btn text-sm" onClick={() => fileInput.current?.click()} disabled={adding}><ActionIcon name="attachment" /> Attach files</button><span>Smaller files upload faster; large files use resumable uploads.</span><button type="button" className="btn btn-primary text-sm" onClick={submit} disabled={!canAdd}>{adding ? (progress ? 'Uploading…' : 'Adding…') : 'Add note'}</button></div>
    </div>
  </div>
}
