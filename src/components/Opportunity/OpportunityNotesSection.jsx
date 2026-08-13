import { useMemo, useRef, useState } from 'react'
import OpportunitySection from '@/components/Opportunity/OpportunitySection'
import ActionIcon from '@/components/Common/ActionIcon'
import RichText from '@/components/Common/RichText'
import styles from '@/pages/OpportunityDetail.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'
import { validateOpportunityReferenceFile } from '@/services/opportunityReferenceUploadService'

function formatFileSize(bytes) {
  const size = Number(bytes || 0)
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 ** 2).toFixed(size >= 10 * 1024 ** 2 ? 0 : 1)} MB`
}

export default function OpportunityNotesSection({
  loading,
  notes,
  editingNoteId,
  savingNoteId,
  deletingNoteId,
  noteDraft,
  setNoteDraft,
  startEditNote,
  saveNote,
  deleteNote,
  cancelEdit,
  newNote,
  setNewNote,
  addNote,
  addingNote,
  uploadProgress,
  id,
}) {
  const noteEditorRef = useRef(null)
  const newNoteRef = useRef(null)
  const fileInputRef = useRef(null)
  const [attachments, setAttachments] = useState([])
  const [fileError, setFileError] = useState('')
  const editingNote = notes.find((note) => note._rowIndex === editingNoteId)
  const canAdd = (Boolean(newNote.trim()) || attachments.length > 0) && !addingNote
  const progressPercent = useMemo(() => {
    if (!uploadProgress?.totalBytes) return 0
    return Math.min(100, Math.round((uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100))
  }, [uploadProgress])

  const selectFiles = (event) => {
    const selected = Array.from(event.target.files || [])
    const rejected = selected.map((file) => validateOpportunityReferenceFile(file)).filter(Boolean)
    const accepted = selected.filter((file) => !validateOpportunityReferenceFile(file))
    setAttachments((current) => [...current, ...accepted])
    setFileError(rejected[0] || '')
    event.target.value = ''
  }

  const submitNote = async () => {
    if (!canAdd) return
    const saved = await addNote(attachments)
    if (saved) {
      setAttachments([])
      setFileError('')
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }
  useSaveShortcut({
    enabled: Boolean(editingNote) && savingNoteId === null && Boolean(noteDraft.trim()),
    label: 'this note',
    onSave: () => editingNote && saveNote(editingNote),
    scopeRef: noteEditorRef,
  })
  useSaveShortcut({
    enabled: canAdd,
    label: 'this new note',
    onSave: submitNote,
    scopeRef: newNoteRef,
  })
  return (
    <OpportunitySection title="Notes" id={id}>
      {loading
        ? <div className="skeleton" style={{ height: 60 }} />
        : notes.length === 0
          ? <p className="text-muted text-sm" style={{ marginBottom: 10 }}>No notes yet.</p>
          : notes.map((note) => (
              <div key={note.NoteID} className={styles.noteItem}>
                <div className={styles.noteMeta} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{note.Date} · {note.Author}</span>
                  {!note._temp && editingNoteId !== note._rowIndex && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 18, height: 18, padding: 0, fontSize: 11, color: 'var(--blue-600)', marginLeft: 'auto' }}
                      onClick={() => startEditNote(note)}
                      disabled={savingNoteId !== null || deletingNoteId === note._rowIndex}
                      aria-label="Edit note"
                      title="Edit note"
                    ><ActionIcon name="edit" /></button>
                  )}
                  {!note._temp && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      style={{ width: 18, height: 18, padding: 0, fontSize: 11, color: 'var(--red-600)' }}
                      onClick={() => deleteNote(note)}
                      disabled={deletingNoteId === note._rowIndex || savingNoteId !== null}
                      aria-label="Delete note"
                      title="Delete note"
                    >
                      {deletingNoteId === note._rowIndex ? '…' : <ActionIcon name="delete" />}
                    </button>
                  )}
                </div>
                {editingNoteId === note._rowIndex
                  ? <div ref={noteEditorRef} className={styles.noteEditor}>
                      <textarea className="form-input" rows={3} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} disabled={savingNoteId === note._rowIndex} />
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button type="button" className="btn btn-primary text-sm" onClick={() => saveNote(note)} disabled={savingNoteId === note._rowIndex || !noteDraft.trim()}>{savingNoteId === note._rowIndex ? 'Saving…' : 'Save note'}</button>
                        <button type="button" className="btn text-sm" onClick={cancelEdit} disabled={savingNoteId === note._rowIndex}>Cancel</button>
                      </div>
                    </div>
                  : <div className={styles.noteText}><RichText value={note.NoteText} /></div>}
              </div>
            ))
      }
      <div ref={newNoteRef} className={styles.noteAdd}>
        <textarea
          className="form-input"
          placeholder="Add a note…"
          value={newNote}
          onChange={(event) => setNewNote(event.target.value)}
          rows={2}
        />
        <input ref={fileInputRef} className={styles.noteFileInput} type="file" multiple onChange={selectFiles} disabled={addingNote} />
        {attachments.length > 0 && <div className={styles.noteAttachments}>
          {attachments.map((file, index) => <div className={styles.noteAttachment} key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
            <ActionIcon name="attachment" size={13} />
            <span title={file.name}>{file.name}</span>
            <small>{formatFileSize(file.size)}</small>
            <button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} disabled={addingNote} aria-label={`Remove ${file.name}`} title={`Remove ${file.name}`}>×</button>
          </div>)}
        </div>}
        {fileError && <div className={styles.noteFileError} role="alert">{fileError}</div>}
        {uploadProgress && <div className={styles.noteUploadProgress}>
          <div><span>{uploadProgress.fileName} · {uploadProgress.fileIndex + 1} of {uploadProgress.fileCount}</span><strong>{progressPercent}%</strong></div>
          <div className={styles.noteUploadTrack}><span style={{ width: `${progressPercent}%` }} /></div>
        </div>}
        <div className={styles.noteAddActions}>
          <button type="button" className="btn text-sm" onClick={() => fileInputRef.current?.click()} disabled={addingNote}>
            <ActionIcon name="attachment" size={14} /> Attach files
          </button>
          <span className={styles.noteUploadHint}>Smaller files upload faster; large files use resumable uploads.</span>
          <button type="button" className="btn btn-primary text-sm" onClick={submitNote} disabled={!canAdd}>
            {addingNote ? (uploadProgress ? 'Uploading…' : 'Adding…') : 'Add note'}
          </button>
        </div>
      </div>
    </OpportunitySection>
  )
}
