import { useState, useEffect, useRef, useMemo, useDeferredValue } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useContacts } from '@/hooks/useContacts'
import { usePartners } from '@/hooks/usePartners'
import { useTasks } from '@/hooks/useTasks'
import { useNotes } from '@/hooks/useNotes'
import { useContactEngagement } from '@/hooks/useContactEngagement'
import { getSAMOpportunities } from '@/services/graphService'
import { formatDate } from '@/utils/kpiHelpers'
import { buildSearchIndex, rankSearchIndex } from '@/utils/searchHelpers'
import styles from './SearchModal.module.css'

const MAX_PER_CATEGORY = 5

function newOpportunityNoticeId(opportunity) {
  return opportunity?.['Solicitation Number'] || opportunity?.notice_id || opportunity?.['Notice ID'] || ''
}

export default function SearchModal({ onClose }) {
  const [query, setQuery]   = useState('')
  const deferredQuery       = useDeferredValue(query)
  const inputRef            = useRef(null)
  const modalRef            = useRef(null)
  const navigate            = useNavigate()
  const [activeIndex, setActiveIndex] = useState(0)
  const [expandedCategories, setExpandedCategories] = useState({})
  const [samOpportunities, setSamOpportunities] = useState([])

  const { pipeline, archivedPipeline }  = usePipeline()
  const { contacts }  = useContacts()
  const { partners }  = usePartners()
  const { tasks }     = useTasks()
  const { notes }     = useNotes()
  const contactEngagement = useContactEngagement(true)

  useEffect(() => {
    let active = true
    getSAMOpportunities()
      .then((rows) => { if (active) setSamOpportunities(rows) })
      .catch((error) => console.warn('[Search CRM] Could not load SAM opportunities:', error.message))
    return () => { active = false }
  }, [])

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

  const q = deferredQuery.trim().toLowerCase()

  const indexes = useMemo(() => ({
    opportunities: buildSearchIndex(pipeline),
    archivedOpportunities: buildSearchIndex(archivedPipeline),
    samOpportunities: buildSearchIndex(samOpportunities),
    partners: buildSearchIndex(partners),
    contacts: buildSearchIndex(contacts),
    tasks: buildSearchIndex(tasks),
    interactions: buildSearchIndex(contactEngagement.interactions),
    notes: buildSearchIndex(notes),
  }), [pipeline, archivedPipeline, samOpportunities, partners, contacts, tasks, contactEngagement.interactions, notes])

  const opportunitiesByContract = useMemo(
    () => new Map(pipeline.map((opportunity) => [opportunity['Contract Number / Notice ID'], opportunity])),
    [pipeline]
  )

  const contactsById = useMemo(
    () => new Map(contacts.map((contact) => [String(contact.ContactID || ''), contact])),
    [contacts]
  )

  const results = useMemo(() => {
    if (!q) return { opportunities: [], archivedOpportunities: [], samOpportunities: [], partners: [], contacts: [], tasks: [], interactions: [], notes: [], counts: {} }

    const allOpportunities = rankSearchIndex(indexes.opportunities, q)
    const allArchivedOpportunities = rankSearchIndex(indexes.archivedOpportunities, q)
    const allSAMOpportunities = rankSearchIndex(indexes.samOpportunities, q)
    const allContacts = rankSearchIndex(indexes.contacts, q)
    const allPartners = rankSearchIndex(indexes.partners, q)
    const allTasks = rankSearchIndex(indexes.tasks, q)
    const allInteractions = rankSearchIndex(indexes.interactions, q)
      .map((interaction) => ({
        ...interaction,
        contact: contactsById.get(String(interaction.ContactID || '')),
      }))
      .filter((interaction) => interaction.contact)

    const allNotes = rankSearchIndex(indexes.notes, q)
      .map((n) => ({
        ...n,
        opportunity: opportunitiesByContract.get(n.ContractNumber),
      }))

    const show = (category, rows) => expandedCategories[category] ? rows : rows.slice(0, MAX_PER_CATEGORY)

    return {
      opportunities: show('opportunities', allOpportunities),
      archivedOpportunities: show('archivedOpportunities', allArchivedOpportunities),
      samOpportunities: show('samOpportunities', allSAMOpportunities),
      partners: show('partners', allPartners),
      contacts: show('contacts', allContacts),
      tasks: show('tasks', allTasks),
      interactions: show('interactions', allInteractions),
      notes: show('notes', allNotes),
      counts: {
        opportunities: allOpportunities.length,
        archivedOpportunities: allArchivedOpportunities.length,
        samOpportunities: allSAMOpportunities.length,
        partners: allPartners.length,
        contacts: allContacts.length,
        tasks: allTasks.length,
        interactions: allInteractions.length,
        notes: allNotes.length,
      },
    }
  }, [q, indexes, opportunitiesByContract, contactsById, expandedCategories])

  const total = results.opportunities.length + results.archivedOpportunities.length + results.samOpportunities.length + results.partners.length + results.contacts.length + results.tasks.length + results.interactions.length + results.notes.length
  const hasResults = total > 0

  const go = (path) => {
    navigate(path)
    onClose()
  }

  const selectableResults = useMemo(() => [
    ...results.opportunities.map((o) => ({ path: `/opportunities/${encodeURIComponent(o['Contract Number / Notice ID'])}` })),
    ...results.archivedOpportunities.map((o) => ({ path: `/opportunities/${encodeURIComponent(o['Contract Number / Notice ID'])}?row=${o._rowIndex}` })),
    ...results.samOpportunities.map((opportunity) => ({
      path: `/opportunities?tab=New&search=${encodeURIComponent(newOpportunityNoticeId(opportunity) || opportunity.Title || '')}`,
    })),
    ...results.partners.map((partner) => ({ path: `/partners?search=${encodeURIComponent(partner['Partner Name'] || '')}` })),
    ...results.contacts.map((c) => ({ path: `/contacts?contactId=${encodeURIComponent(c.ContactID || c._rowIndex)}` })),
    ...results.tasks.map((t) => ({ path: `/tasks?taskId=${encodeURIComponent(t.TaskID)}` })),
    ...results.interactions.map((interaction) => ({
      path: `/contacts?contactId=${encodeURIComponent(interaction.contact.ContactID || interaction.contact._rowIndex)}&interactionId=${encodeURIComponent(interaction.InteractionID || interaction._rowIndex)}`,
    })),
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
      <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-label="Search CRM">
        {/* Search input */}
        <div className={styles.inputRow}>
          <svg className={styles.searchIcon} width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Search CRM…"
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
              Search opportunities, SAM.gov notices, partners, contacts, tasks, notes, and interactions.
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

          {results.archivedOpportunities.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Archived opportunities</div>
              {results.archivedOpportunities.map((o, i) => {
                const index = results.opportunities.length + i
                return <button key={o['Opportunity ID'] || o._rowIndex}
                  className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => go(`/opportunities/${encodeURIComponent(o['Contract Number / Notice ID'])}?row=${o._rowIndex}`)}>
                  <div className={styles.resultTitle}>{o['Project Title / Description*']}</div>
                  <div className={styles.resultMeta}>{o['Contract Number / Notice ID']} · Archived</div>
                  <div className={styles.resultMeta}>{o['Department*'] || o['Agency*'] || '—'}</div>
                </button>
              })}
              {results.counts.archivedOpportunities > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('archivedOpportunities')}>
                  {expandedCategories.archivedOpportunities ? 'Show fewer' : `View all ${results.counts.archivedOpportunities}`}
                </button>
              )}
            </div>
          )}

          {results.samOpportunities.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>SAM opportunities</div>
              {results.samOpportunities.map((opportunity, i) => {
                const index = results.opportunities.length + results.archivedOpportunities.length + i
                const identifier = newOpportunityNoticeId(opportunity)
                return (
                  <button key={(opportunity._rowIndex ?? identifier) || opportunity.Title || i}
                    className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => go(`/opportunities?tab=New&search=${encodeURIComponent(identifier || opportunity.Title || '')}`)}>
                    <div className={styles.resultTitle}>{opportunity.Title || 'Untitled opportunity'}</div>
                    <div className={styles.resultMeta}>{identifier || 'No Notice ID'}</div>
                    <div className={styles.resultMeta}>{opportunity.Department || opportunity.Agency || '—'}</div>
                  </button>
                )
              })}
              {results.counts.samOpportunities > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('samOpportunities')}>
                  {expandedCategories.samOpportunities ? 'Show fewer' : `View all ${results.counts.samOpportunities}`}
                </button>
              )}
            </div>
          )}

          {results.partners.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Partners</div>
              {results.partners.map((partner, i) => {
                const index = results.opportunities.length + results.archivedOpportunities.length + results.samOpportunities.length + i
                return (
                  <button key={partner._rowIndex || partner['Partner Name']}
                    className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => go(`/partners?search=${encodeURIComponent(partner['Partner Name'] || '')}`)}>
                    <div className={styles.resultTitle}>{partner['Partner Name']}</div>
                    <div className={styles.resultMeta}>{partner['UEI Number'] ? `UEI: ${partner['UEI Number']}` : 'No UEI recorded'}</div>
                    <div className={styles.resultMeta}>{partner.Capabilities || partner['Company Strengths'] || 'Partner record'}</div>
                  </button>
                )
              })}
              {results.counts.partners > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('partners')}>
                  {expandedCategories.partners ? 'Show fewer' : `View all ${results.counts.partners}`}
                </button>
              )}
            </div>
          )}

          {results.contacts.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Contacts</div>
              {results.contacts.map((c, i) => {
                const index = results.opportunities.length + results.archivedOpportunities.length + results.samOpportunities.length + results.partners.length + i
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
                const index = results.opportunities.length + results.archivedOpportunities.length + results.samOpportunities.length + results.partners.length + results.contacts.length + i
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

          {results.interactions.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Contact interactions</div>
              {results.interactions.map((interaction, i) => {
                const index = results.opportunities.length + results.archivedOpportunities.length + results.samOpportunities.length + results.partners.length + results.contacts.length + results.tasks.length + i
                const preview = String(interaction.Notes || '').replace(/\s+/g, ' ').slice(0, 120)
                return (
                  <button key={interaction.InteractionID || interaction._rowIndex}
                    className={`${styles.result} ${activeIndex === index ? styles.resultActive : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => go(`/contacts?contactId=${encodeURIComponent(interaction.contact.ContactID || interaction.contact._rowIndex)}&interactionId=${encodeURIComponent(interaction.InteractionID || interaction._rowIndex)}`)}>
                    <div className={styles.resultTitle}>{interaction.contact.Name}</div>
                    <div className={styles.resultMeta}>{interaction['Interaction Type'] || 'Interaction'}{interaction['Interaction Date'] ? ` · ${formatDate(interaction['Interaction Date'])}` : ''}</div>
                    <div className={styles.resultMeta}>{preview || 'No notes'}</div>
                  </button>
                )
              })}
              {results.counts.interactions > MAX_PER_CATEGORY && (
                <button className={styles.viewAll} onClick={() => toggleCategory('interactions')}>
                  {expandedCategories.interactions ? 'Show fewer' : `View all ${results.counts.interactions}`}
                </button>
              )}
            </div>
          )}

          {results.notes.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>Opportunity notes</div>
              {results.notes.map((n, i) => {
                const target = n.opportunity
                const index = results.opportunities.length + results.archivedOpportunities.length + results.samOpportunities.length + results.partners.length + results.contacts.length + results.tasks.length + results.interactions.length + i
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
