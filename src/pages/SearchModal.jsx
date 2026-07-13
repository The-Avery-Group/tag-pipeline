import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useContacts } from '@/hooks/useContacts'
import { useTasks } from '@/hooks/useTasks'
import { useNotes } from '@/hooks/useNotes'
import { formatDate } from '@/utils/kpiHelpers'
import styles from './SearchModal.module.css'

const MAX_PER_CATEGORY = 5

export default function SearchModal({ onClose }) {
  const [query, setQuery]   = useState('')
  const inputRef            = useRef(null)
  const navigate            = useNavigate()

  const { pipeline }  = usePipeline()
  const { contacts }  = useContacts()
  const { tasks }     = useTasks()
  const { notes }     = useNotes()

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const q = query.trim().toLowerCase()

  const results = useMemo(() => {
    if (!q) return { opportunities: [], contacts: [], tasks: [], notes: [] }

    const opportunities = pipeline
      .filter((o) =>
        [o['Project Title / Description*'], o['Contract Number / Notice ID'],
         o['Department*'], o['Agency*']]
          .some((v) => v && String(v).toLowerCase().includes(q))
      )
      .slice(0, MAX_PER_CATEGORY)

    const contactResults = contacts
      .filter((c) =>
        [c.Name, c.Email, c.Agency, c.Notes]
          .some((v) => v && String(v).toLowerCase().includes(q))
      )
      .slice(0, MAX_PER_CATEGORY)

    const taskResults = tasks
      .filter((t) =>
        [t.Title, t.ContractTitle, t.ContractNumber, t.Description, t.OpportunityNotes]
          .some((v) => v && String(v).toLowerCase().includes(q))
      )
      .slice(0, MAX_PER_CATEGORY)

    const noteResults = notes
      .filter((n) => String(n.NoteText || '').toLowerCase().includes(q))
      .map((n) => ({
        ...n,
        opportunity: pipeline.find((o) => o['Contract Number / Notice ID'] === n.ContractNumber),
      }))
      .slice(0, MAX_PER_CATEGORY)

    return { opportunities, contacts: contactResults, tasks: taskResults, notes: noteResults }
  }, [q, pipeline, contacts, tasks, notes])

  const total = results.opportunities.length + results.contacts.length + results.tasks.length + results.notes.length
  const hasResults = total > 0

  const go = (path) => {
    navigate(path)
    onClose()
  }

  const statusClass = (s) =>
    s === 'Done' ? 'badge-done' : s === 'In Progress' ? 'badge-progress' : 'badge-todo'

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal} role="dialog" aria-label="Search">
        {/* Search input */}
        <div className={styles.inputRow}>
          <svg className={styles.searchIcon} width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Search opportunities, contacts, tasks, notes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query && (
            <button className={styles.clearBtn} onClick={() => setQuery('')}>✕</button>
          )}
        </div>

        {/* Results */}
        <div className={styles.results}>
          {!q && (
            <div className={styles.hint}>
              Start typing to search across opportunities, contacts, tasks and notes.
            </div>
          )}

          {q && !hasResults && (
            <div className={styles.hint}>No results for "{query}".</div>
          )}

          {results.opportunities.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Opportunities</div>
              {results.opportunities.map((o) => (
                <button key={o['Contract Number / Notice ID']}
                  className={styles.result}
                  onClick={() => go(`/opportunities/${encodeURIComponent(o['Contract Number / Notice ID'])}`)}>
                  <div className={styles.resultTitle}>{o['Project Title / Description*']}</div>
                  <div className={styles.resultMeta}>{o['Contract Number / Notice ID']}</div>
                  <div className={styles.resultMeta}>{o['Department*'] || o['Agency*'] || '—'}</div>
                </button>
              ))}
            </div>
          )}

          {results.contacts.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Contacts</div>
              {results.contacts.map((c) => (
                <button key={c.ContactID || c.Name}
                  className={styles.result}
                  onClick={() => go(`/contacts?contactId=${encodeURIComponent(c.ContactID || c._rowIndex)}`)}>
                  <div className={styles.resultTitle}>{c.Name}</div>
                  <div className={styles.resultMeta}>{c.Email || '—'}</div>
                  <div className={styles.resultMeta}>{c.Agency || '—'}</div>
                </button>
              ))}
            </div>
          )}

          {results.tasks.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Tasks</div>
              {results.tasks.map((t) => (
                <button key={t.TaskID || t.Title}
                  className={styles.result}
                  onClick={() => go(`/tasks?taskId=${encodeURIComponent(t.TaskID)}`)}>
                  <div className={styles.resultTitle}>{t.Title}</div>
                  <div className={styles.resultMeta}>{t.DueDate ? formatDate(t.DueDate) : 'No deadline'}</div>
                  <div className={styles.resultMeta}>
                    <span className={`badge ${statusClass(t.Status)}`} style={{ fontSize: 10 }}>{t.Status}</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {results.notes.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Opportunity notes</div>
              {results.notes.map((n) => {
                const target = n.opportunity
                const title = target?.['Project Title / Description*'] || n.ContractNumber || 'Unlinked opportunity'
                const preview = String(n.NoteText || '').replace(/\s+/g, ' ').slice(0, 120)
                return (
                  <button key={n.NoteID || n._rowIndex}
                    className={styles.result}
                    disabled={!target}
                    onClick={() => target && go(`/opportunities/${encodeURIComponent(target['Contract Number / Notice ID'])}?row=${target._rowIndex}`)}>
                    <div className={styles.resultTitle}>{title}</div>
                    <div className={styles.resultMeta}>{preview}{preview.length >= 120 ? '…' : ''}</div>
                    <div className={styles.resultMeta}>{n.ContractNumber || 'No linked opportunity'}</div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <span>↵ to select</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}
