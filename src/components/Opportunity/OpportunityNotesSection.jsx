import OpportunitySection from '@/components/Opportunity/OpportunitySection'
import styles from '@/pages/OpportunityDetail.module.css'

const URL_PATTERN = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi

function linkifyText(text) {
  if (!text) return null
  return String(text).split(URL_PATTERN).map((part, index) => {
    if (index % 2 === 1) {
      const href = part.toLowerCase().startsWith('www.') ? `https://${part}` : part
      return (
        <a key={index} href={href} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
          {part}
        </a>
      )
    }
    return part
  })
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
}) {
  return (
    <OpportunitySection title="Notes">
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
                    >✎</button>
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
                      {deletingNoteId === note._rowIndex ? '…' : '✕'}
                    </button>
                  )}
                </div>
                {editingNoteId === note._rowIndex
                  ? <div className={styles.noteEditor}>
                      <textarea className="form-input" rows={3} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} disabled={savingNoteId === note._rowIndex} />
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button type="button" className="btn btn-primary text-sm" onClick={() => saveNote(note)} disabled={savingNoteId === note._rowIndex || !noteDraft.trim()}>{savingNoteId === note._rowIndex ? 'Saving…' : 'Save note'}</button>
                        <button type="button" className="btn text-sm" onClick={cancelEdit} disabled={savingNoteId === note._rowIndex}>Cancel</button>
                      </div>
                    </div>
                  : <div className={styles.noteText}>{linkifyText(note.NoteText)}</div>}
              </div>
            ))
      }
      <div className={styles.noteAdd}>
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
