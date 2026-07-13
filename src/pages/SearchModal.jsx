import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useContacts } from '@/hooks/useContacts'
import { useTasks } from '@/hooks/useTasks'
import { useNotes } from '@/hooks/useNotes'
import { formatDate } from '@/utils/kpiHelpers'
import styles from './SearchModal.module.css'

const MAX_PER_CATEGORY = 5

function scoreMatch(values, query) {
  return values.reduce((best, value) => {
    const text = String(value || '').toLowerCase()
    if (!text.includes(query)) return best
    if (text === query) return Math.max(best, 100)
    if (text.startsWith(query)) return Math.max(best, 60)
    return Math.max(best, 20)
  }, 0)
}

function rankMatches(rows, valuesFor, query) {
  return rows
    .map((row) => ({ row, score: scoreMatch(valuesFor(row), query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row)
}

export default function SearchModal({ onClose }) {
  const [query, setQuery]   = useState('')
  const inputRef            = useRef(null)
  const modalRef            = useRef(null)
  const navigate            = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  const [expandedCategories, setExpandedCategories] = useState({})

  const { pipeline }  = usePipeline()
  const { contacts }  = useContacts()
  const { tasks }     = useTasks()
  const { notes }     = useNotes()

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape and keep keyboard focus inside the dialog.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = modalRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || []
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const q = query.trim().toLowerCase()

  const opportunitiesByContract = useMemo(
    () => new Map(pipeline.map((opportunity) => [opportunity['Contract Number / Notice ID'], opportunity])),
    [pipeline]
  )

  const results = useMemo(() => {
    if (!q) return { opportunities: [], contacts: [], tasks: [], notes: [], counts: {} }

    const allOpportunities = rankMatches(pipeline, (o) => [
      o['Project Title / Description*'], o['Contract Number / Notice ID'], o['Department*'], o['Agency*'],
    ], q)

    const allContacts = rankMatches(contacts, (c) => [c.Name, c.Email, c.Agency, c.Notes], q)

    const allTasks = rankMatches(tasks, (t) => [
      t.Title, t.ContractTitle, t.ContractNumber, t.Description, t.OpportunityNotes,
    ], q)

    const allNotes = rankMatches(notes, (n) => [n.NoteText, n.Author, n.ContractNumber], q)
      .map((n) => ({
        ...n,
        opportunity: opportunitiesByContract.get(n.ContractNumber),
      }))

    const show = (category, rows) => expandedCategories[category] ? rows : rows.slice(0, MAX_PER_CATEGORY)

    return {
      opportunities: show('opportunities', allOpportunities),
      contacts: show('contacts', allContacts),
      tasks: show('tasks', allTasks),
      notes: show('notes', allNotes),
      counts: {
        opportunities: allOpportunities.length,
        contacts: allContacts.length,
        tasks: allTasks.length,
        notes: allNotes.length,
      },
    }
  }, [q, pipeline, contacts, tasks, notes, opportunitiesByContract, expandedCategories])

  const total = results.opportunities.length + results.contacts.length + results.tasks.length + results.notes.length
  const hasResults = total > 0

  const go = (path) => {
    navigate(path)
    onClose()
  }

  const selectableResults = useMemo(() => [
    ...results.opportunities.map((o) => ({ path: `/opportunities/${encodeURIComponent(o['Contract Number / Notice ID'])}` })),
    ...results.contacts.map((c) => ({ path: `/contacts?contactId=${encodeURIComponent(c.ContactID || c._rowIndex)}` })),
    ...results.tasks.map((t) => ({ path: `/tasks?taskId=${encodeURIComponent(t.TaskID)}` })),
    ...results.notes.map((n) => ({
      path: n.opportunity ? `/opportunities/${encodeURIComponent(n.opportunity['Contract Number / Notice ID'])}?row=${n.opportunity._rowIndex}` : null,
    })),
  ], [results])

  useEffect(() => {
    setActiveIndex(0)
    setExpandedCategories({})
  }, [q])

  const toggleCategory = (category) => {
    setExpandedCategories((previous) => ({ ...previous, [category]: !previous[category] }))
  }

  const handleInputKeyDown = (event) => {
    if (!selectableResults.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % selectableResults.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + selectableResults.length) % selectableResults.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const selected = selectableResults[activeIndex]
      if (selected?.path) go(selected.path)
    }
  }

  const statusClass = (s) =>
    s === 'Done' ? 'badge-done' : s === 'In Progress' ? 'badge-progress' : 'badge-todo'

  return (
    <div className={styles.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-label="Search">
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
            onKeyDown={handleInputKeyDown}
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
              {results.opportunities.map((o, index) => (
                <button key={o['Contract Number / Notice ID']}
                  className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(`/opportunities/${encodeURIComponent(o['Contract Number / Notice ID'])}`)}>
                  <div className={styles.resultTitle}>{o['Project Title / Description*']}</div>
                  <div className={styles.resultMeta}>{o['Contract Number / Notice ID']}</div>
                  <div className={styles.resultMeta}>{o['Department*'] || o['Agency*'] || '—'}</div>
                </button>
              ))}
              {results.counts.opportunities > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('opportunities')}>
                  {expandedCategories.opportunities ? 'Show fewer' : `View all ${results.counts.opportunities}`}
                </button>
              )}
            </div>
          )}

          {results.contacts.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Contacts</div>
              {results.contacts.map((c, i) => {
                const index = results.opportunities.length + i
                return (
                <button key={c.ContactID || c.Name}
                  className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(`/contacts?contactId=${encodeURIComponent(c.ContactID || c._rowIndex)}`)}>
                  <div className={styles.resultTitle}>{c.Name}</div>
                  <div className={styles.resultMeta}>{c.Email || '—'}</div>
                  <div className={styles.resultMeta}>{c.Agency || '—'}</div>
                </button>
                )
              })}
              {results.counts.contacts > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('contacts')}>
                  {expandedCategories.contacts ? 'Show fewer' : `View all ${results.counts.contacts}`}
                </button>
              )}
            </div>
          )}

          {results.tasks.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Tasks</div>
              {results.tasks.map((t, i) => {
                const index = results.opportunities.length + results.contacts.length + i
                return (
                <button key={t.TaskID || t.Title}
                  className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(`/tasks?taskId=${encodeURIComponent(t.TaskID)}`)}>
                  <div className={styles.resultTitle}>{t.Title}</div>
                  <div className={styles.resultMeta}>{t.DueDate ? formatDate(t.DueDate) : 'No deadline'}</div>
                  <div className={styles.resultMeta}>
                    <span className={`badge ${statusClass(t.Status)}`} style={{ fontSize: 10 }}>{t.Status}</span>
                  </div>
                </button>
                )
              })}
              {results.counts.tasks > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('tasks')}>
                  {expandedCategories.tasks ? 'Show fewer' : `View all ${results.counts.tasks}`}
                </button>
              )}
            </div>
          )}

          {results.notes.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Opportunity notes</div>
              {results.notes.map((n, i) => {
                const target = n.opportunity
                const index = results.opportunities.length + results.contacts.length + results.tasks.length + i
                const title = target?.['Project Title / Description*'] || n.ContractNumber || 'Unlinked opportunity'
                const preview = String(n.NoteText || '').replace(/\s+/g, ' ').slice(0, 120)
                return (
                  <button key={n.NoteID || n._rowIndex}
                    className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    disabled={!target}
                    onClick={() => target && go(`/opportunities/${encodeURIComponent(target['Contract Number / Notice ID'])}?row=${target._rowIndex}`)}>
                    <div className={styles.resultTitle}>{title}</div>
                    <div className={styles.resultMeta}>{preview}{preview.length >= 120 ? '…' : ''}</div>
                    <div className={styles.resultMeta}>{n.ContractNumber || 'No linked opportunity'}</div>
                  </button>
                )
              })}
              {results.counts.notes > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('notes')}>
                  {expandedCategories.notes ? 'Show fewer' : `View all ${results.counts.notes}`}
                </button>
              )}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <span>↑↓ to select · ↵ to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  )
}
