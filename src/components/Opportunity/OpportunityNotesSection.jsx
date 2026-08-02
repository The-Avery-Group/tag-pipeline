import { useRef } from 'react'
import OpportunitySection from '@/components/Opportunity/OpportunitySection'
import ActionIcon from '@/components/Common/ActionIcon'
import RichText from '@/components/Common/RichText'
import styles from '@/pages/OpportunityDetail.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'

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
  id,
}) {
  const noteEditorRef = useRef(null)
  const newNoteRef = useRef(null)
  const editingNote = notes.find((note) => note._rowIndex === editingNoteId)
  useSaveShortcut({
    enabled: Boolean(editingNote) && savingNoteId === null && Boolean(noteDraft.trim()),
    label: 'this note',
    onSave: () => editingNote && saveNote(editingNote),
    scopeRef: noteEditorRef,
  })
  useSaveShortcut({
    enabled: Boolean(newNote.trim()) && !addingNote,
    label: 'this new note',
    onSave: addNote,
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
        <button className="btn btn-primary text-sm" onClick={addNote}
          disabled={addingNote || !newNote.trim()}>
          {addingNote ? 'Adding…' : 'Add note'}
        </button>
      </div>
    </OpportunitySection>
  )
}
