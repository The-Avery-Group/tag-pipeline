import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import Modal from '@/components/Common/Modal'
import {
  buildDefaultPeopleQueries,
  contactDraftFromSearchResult,
  ensureLinkedInSiteFilter,
  googleSearchUrl,
  suggestPeopleSearchQueries,
} from '@/services/peopleSearchService'
import styles from './PeopleSearch.module.css'

const GOOGLE_SEARCH_ENGINE_ID = import.meta.env.VITE_GOOGLE_SEARCH_ENGINE_ID || ''
const DECISIONS_KEY = 'tag-people-search-decisions-v1'
const EMPTY_CONTACT = {
  Name: '', Title: '', Agency: '', Organization: '', Offices: '',
  Email: '', Phone: '', Notes: '', Type: 'Private',
}

const googleListeners = new Map()
let googleLoaderPromise = null

function linkedInProfileUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''

  try {
    let url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    if (
      (url.hostname === 'google.com' || url.hostname.endsWith('.google.com'))
      && url.pathname === '/url'
    ) {
      const target = url.searchParams.get('q') || url.searchParams.get('url')
      if (target) url = new URL(target)
    }

    const hostname = url.hostname.toLowerCase()
    const isLinkedIn = hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')
    if (!isLinkedIn || !url.pathname.toLowerCase().startsWith('/in/')) return ''
    url.protocol = 'https:'
    return url.toString()
  } catch {
    return ''
  }
}

function normalizeGoogleResult(result) {
  const profileUrl = linkedInProfileUrl(result?.url)
    || linkedInProfileUrl(result?.visibleUrl)
  return {
    title: String(result?.titleNoFormatting || result?.title || '').trim(),
    snippet: String(result?.contentNoFormatting || result?.content || '').trim(),
    url: profileUrl,
    visibleUrl: String(result?.visibleUrl || '').trim(),
  }
}

function isPublicLinkedInProfile(result) {
  return Boolean(result.url)
}

function embeddedGoogleQuery(query) {
  const withoutSiteFilter = String(query || '')
    .replace(/site:\s*(?:www\.)?linkedin\.com\/in\/?/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return withoutSiteFilter || query
}

function configureGoogleCallbacks(resolve) {
  const previous = window.__gcse || {}
  const previousReady = previous.searchCallbacks?.web?.ready
  window.__gcse = {
    ...previous,
    parsetags: 'explicit',
    initializationCallback: () => {
      previous.initializationCallback?.()
      resolve()
    },
    searchCallbacks: {
      ...(previous.searchCallbacks || {}),
      web: {
        ...(previous.searchCallbacks?.web || {}),
        ready: (name, query, promotions, results, resultsDiv) => {
          const listener = googleListeners.get(name)
          if (listener) {
            const rawResults = [...(promotions || []), ...(results || [])]
            listener({
              query,
              rawResultCount: rawResults.length,
              results: rawResults
                .map(normalizeGoogleResult)
                .filter(isPublicLinkedInProfile),
            })
            resultsDiv.hidden = true
            resultsDiv.setAttribute('aria-hidden', 'true')
            resultsDiv.replaceChildren()
            return true
          }
          return typeof previousReady === 'function'
            ? previousReady(name, query, promotions, results, resultsDiv)
            : false
        },
      },
    },
  }
}

function loadGoogleSearchElement() {
  if (!GOOGLE_SEARCH_ENGINE_ID) return Promise.reject(new Error('Google People Search is not configured'))
  if (window.google?.search?.cse?.element) return Promise.resolve()
  if (googleLoaderPromise) return googleLoaderPromise

  googleLoaderPromise = new Promise((resolve, reject) => {
    configureGoogleCallbacks(resolve)
    const existing = document.getElementById('tag-google-people-search-script')
    if (existing) {
      existing.addEventListener('load', resolve, { once: true })
      existing.addEventListener('error', () => reject(new Error('Google search could not load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.id = 'tag-google-people-search-script'
    script.async = true
    script.src = `https://cse.google.com/cse.js?cx=${encodeURIComponent(GOOGLE_SEARCH_ENGINE_ID)}`
    script.addEventListener('error', () => {
      googleLoaderPromise = null
      reject(new Error('Google search could not load'))
    }, { once: true })
    document.head.appendChild(script)
  })
  return googleLoaderPromise
}

function waitForGoogleElement(name, timeoutMs = 8000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const api = window.google?.search?.cse?.element
      const allElements = api?.getAllElements?.() || {}
      const element = api?.getElement?.(name) || allElements[name]
      if (element?.execute) {
        resolve(element)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Google search could not finish loading. Please try again.'))
        return
      }
      window.setTimeout(check, 100)
    }
    check()
  })
}

function readDecisions(scopeKey) {
  try {
    const store = JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}')
    return store[scopeKey] || {}
  } catch {
    return {}
  }
}

function writeDecision(scopeKey, url, decision) {
  try {
    const store = JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}')
    store[scopeKey] = { ...(store[scopeKey] || {}), [url]: decision }
    localStorage.setItem(DECISIONS_KEY, JSON.stringify(store))
  } catch {
    // Review state is a convenience. A storage restriction must not block search.
  }
}

function queryScope(scopeId, query) {
  return scopeId || `query:${String(query || '').trim().toLowerCase()}`
}

export default function PeopleSearch({
  variant = 'contacts',
  sourceMode = 'manual',
  scopeId = '',
  scopeLabel = '',
  context = {},
  initialValues = {},
  contactTypes = ['Government', 'Private'],
  onAddContact,
  onContinue,
  toast,
}) {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const googleElementId = `people-search-google-${generatedId}`
  const googleElementName = `people-search-${generatedId}`
  const notesOnly = sourceMode === 'opportunity-notes'
    || initialValues.sourceMode === 'opportunity-notes'
  const [expanded, setExpanded] = useState(variant !== 'opportunity')
  const [organization, setOrganization] = useState(initialValues.organization || '')
  const [program, setProgram] = useState(initialValues.program || '')
  const [keywords, setKeywords] = useState(initialValues.keywords || '')
  const fallbackQueries = useMemo(
    () => notesOnly ? [] : buildDefaultPeopleQueries({ organization, program, keywords, context }),
    [organization, program, keywords, context, notesOnly],
  )
  const [queries, setQueries] = useState(() => {
    if (initialValues.query) {
      return [{
        label: 'Research notes',
        purpose: initialValues.summary || '',
        query: ensureLinkedInSiteFilter(initialValues.query),
      }]
    }
    return fallbackQueries
  })
  const [activeQueryIndex, setActiveQueryIndex] = useState(0)
  const [queryDraft, setQueryDraft] = useState(
    initialValues.query
      ? ensureLinkedInSiteFilter(initialValues.query)
      : fallbackQueries[0]?.query || (notesOnly ? '' : 'site:linkedin.com/in/')
  )
  const [suggesting, setSuggesting] = useState(false)
  const [suggestedOnce, setSuggestedOnce] = useState(Boolean(notesOnly && initialValues.query))
  const [suggestionDetails, setSuggestionDetails] = useState({
    summary: initialValues.summary || '',
    concepts: initialValues.concepts || { organization: [], officeOrProgram: [], roles: [], keywords: [] },
    aliasesUsed: initialValues.aliasesUsed || [],
    broadenedQuery: initialValues.broadenedQuery || '',
  })
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [results, setResults] = useState([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [decisions, setDecisions] = useState({})
  const [showExcluded, setShowExcluded] = useState(false)
  const [searchNotice, setSearchNotice] = useState('')
  const [contactDraft, setContactDraft] = useState(null)
  const [savingContact, setSavingContact] = useState(false)
  const searchContainerRendered = useRef(false)
  const suggestionAbortRef = useRef(null)

  const currentScope = queryScope(scopeId, queryDraft)
  const selected = results.find((result) => result.url === selectedUrl) || null
  const excludedCount = results.filter((result) => decisions[result.url] === 'irrelevant').length
  const visibleResults = results.filter((result) =>
    showExcluded || decisions[result.url] !== 'irrelevant'
  )

  const prepareGoogleElement = useCallback(async () => {
    await loadGoogleSearchElement()
    const api = window.google?.search?.cse?.element
    if (!api) throw new Error('Google search could not load')

    if (!searchContainerRendered.current) {
      api.render({
        div: googleElementId,
        tag: 'searchresults-only',
        gname: googleElementName,
        attributes: {
          linkTarget: '_blank',
          enableHistory: false,
          autoSearchOnLoad: false,
        },
      })
      searchContainerRendered.current = true
    }

    return waitForGoogleElement(googleElementName)
  }, [googleElementId, googleElementName])

  const useQueries = useCallback((nextQueries, details = {}) => {
    const usable = nextQueries?.length ? nextQueries : fallbackQueries
    setQueries(usable)
    setActiveQueryIndex(0)
    setQueryDraft(usable[0]?.query || (notesOnly ? '' : 'site:linkedin.com/in/'))
    setSuggestionDetails({
      summary: details.summary || '',
      concepts: details.concepts || { organization: [], officeOrProgram: [], roles: [], keywords: [] },
      aliasesUsed: details.aliasesUsed || [],
      broadenedQuery: details.broadenedQuery || '',
    })
  }, [fallbackQueries, notesOnly])

  const resetFromFields = useCallback((next) => {
    const built = buildDefaultPeopleQueries({ ...next, context })
    setQueries(built)
    setActiveQueryIndex(0)
    setQueryDraft(built[0]?.query || 'site:linkedin.com/in/')
    setSuggestionDetails({
      summary: '',
      concepts: { organization: [], officeOrProgram: [], roles: [], keywords: [] },
      aliasesUsed: [],
      broadenedQuery: '',
    })
    setResults([])
    setSelectedUrl('')
    setSearched(false)
    setSearchNotice('')
  }, [context])

  const updateField = (field, value) => {
    const next = {
      organization: field === 'organization' ? value : organization,
      program: field === 'program' ? value : program,
      keywords: field === 'keywords' ? value : keywords,
    }
    if (field === 'organization') setOrganization(value)
    if (field === 'program') setProgram(value)
    if (field === 'keywords') setKeywords(value)
    resetFromFields(next)
  }

  const suggestQueries = useCallback(async () => {
    if (suggesting) return
    suggestionAbortRef.current?.abort()
    const controller = new AbortController()
    suggestionAbortRef.current = controller
    setSuggesting(true)
    setSearchNotice('')
    try {
      const response = await suggestPeopleSearchQueries({
        sourceMode: notesOnly ? 'opportunity-notes' : 'manual',
        organization: notesOnly ? '' : organization,
        program: notesOnly ? '' : program,
        keywords: notesOnly ? '' : keywords,
        context,
      }, { signal: controller.signal })
      useQueries(response.queries, response)
      setSuggestedOnce(true)
      if (!response.queries.length) {
        setSearchNotice(response.insufficientReason || 'The linked notes do not contain enough research context to build a useful query.')
      }
    } catch (error) {
      if (error.name === 'AbortError') return
      useQueries(notesOnly ? [] : fallbackQueries)
      setSuggestedOnce(true)
      setSearchNotice(notesOnly
        ? 'The notes-based query could not be generated. Your linked notes remain unchanged; please try again.'
        : 'AI suggestions are temporarily unavailable. The standard search query is ready to use.')
      console.warn('[People Search] Query suggestions failed:', error)
    } finally {
      setSuggesting(false)
    }
  }, [context, fallbackQueries, keywords, notesOnly, organization, program, suggesting, useQueries])

  useEffect(() => () => suggestionAbortRef.current?.abort(), [])

  useEffect(() => {
    if (variant !== 'opportunity' || !expanded || suggestedOnce) return
    void suggestQueries()
  }, [expanded, suggestedOnce, suggestQueries, variant])

  useEffect(() => {
    setDecisions(readDecisions(currentScope))
  }, [currentScope])

  useEffect(() => {
    if (!expanded || !GOOGLE_SEARCH_ENGINE_ID) return undefined
    let cancelled = false
    googleListeners.set(googleElementName, ({ results: nextResults, rawResultCount }) => {
      if (cancelled) return
      setResults(nextResults)
      setSelectedUrl((current) =>
        nextResults.some((item) => item.url === current) ? current : (nextResults[0]?.url || '')
      )
      setSearched(true)
      setSearching(false)
      setSearchNotice(nextResults.length
        ? ''
        : rawResultCount > 0
          ? 'Google returned results, but none were recognized as public LinkedIn profiles. Open the same query in Google to review the complete results.'
          : 'Embedded Google search returned no public LinkedIn profiles. Open the same query in Google to search its more complete index.')
    })

    prepareGoogleElement()
      .catch((error) => {
        if (!cancelled) setSearchNotice(error.message)
      })

    return () => {
      cancelled = true
      googleListeners.delete(googleElementName)
    }
  }, [expanded, googleElementName, prepareGoogleElement])

  const selectQuery = (index) => {
    setActiveQueryIndex(index)
    setQueryDraft(queries[index]?.query || '')
    setResults([])
    setSelectedUrl('')
    setSearched(false)
    setSearchNotice('')
  }

  const broadenSearch = () => {
    if (!suggestionDetails.broadenedQuery) return
    setQueryDraft(suggestionDetails.broadenedQuery)
    setResults([])
    setSelectedUrl('')
    setSearched(false)
    setSearchNotice('The least essential search group was removed. Review the broader query, then search again.')
  }

  const runSearch = async () => {
    const query = ensureLinkedInSiteFilter(queryDraft)
    setQueryDraft(query)
    setSearching(true)
    setSearchNotice('')
    setResults([])
    setSelectedUrl('')
    setSearched(false)

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      window.open(googleSearchUrl(query), '_blank', 'noopener,noreferrer')
      setSearching(false)
      setSearchNotice('Embedded results are not configured yet. This search was opened in Google.')
      return
    }

    try {
      const element = await prepareGoogleElement()
      element.execute(embeddedGoogleQuery(query))
    } catch (error) {
      setSearching(false)
      setSearchNotice(error.message || 'Google search could not run.')
    }
  }

  const markResult = (result, decision) => {
    const next = { ...decisions, [result.url]: decision }
    setDecisions(next)
    writeDecision(currentScope, result.url, decision)
    if (decision === 'irrelevant') {
      const nextVisible = results.find((item) =>
        item.url !== result.url && next[item.url] !== 'irrelevant'
      )
      setSelectedUrl(nextVisible?.url || '')
      toast?.success?.('Result excluded. Use Show excluded to restore it.')
    }
  }

  const restoreResult = (result) => {
    const next = { ...decisions }
    delete next[result.url]
    setDecisions(next)
    writeDecision(currentScope, result.url, 'review')
    setSelectedUrl(result.url)
  }

  const beginAddContact = (result) => {
    setContactDraft({
      ...EMPTY_CONTACT,
      ...contactDraftFromSearchResult(result, organization, scopeLabel),
    })
  }

  const saveContact = async () => {
    if (!contactDraft?.Name.trim() || savingContact) return
    setSavingContact(true)
    try {
      await onAddContact?.({ ...contactDraft, Name: contactDraft.Name.trim() }, selected)
      markResult(selected, 'added')
      setContactDraft(null)
      toast?.success?.(`${contactDraft.Name.trim()} added to Contacts`)
    } catch (error) {
      toast?.error?.(`Could not add contact: ${error.message}`)
    } finally {
      setSavingContact(false)
    }
  }

  const extractedConceptGroups = [
    ['Organization', suggestionDetails.concepts.organization],
    ['Office or program', suggestionDetails.concepts.officeOrProgram],
    ['Likely roles', suggestionDetails.concepts.roles],
    ['Mission keywords', suggestionDetails.concepts.keywords],
  ].filter(([, values]) => values?.length)

  const content = (
    <div className={styles.content}>
      {variant === 'contacts' && !notesOnly && (
        <div className={styles.fieldGrid}>
          <div className="form-field">
            <label className="form-label">Organization</label>
            <input
              className="form-input"
              value={organization}
              onChange={(event) => updateField('organization', event.target.value)}
              placeholder="Company, agency, or organization"
            />
          </div>
          <div className="form-field">
            <label className="form-label">Office or program</label>
            <input
              className="form-input"
              value={program}
              onChange={(event) => updateField('program', event.target.value)}
              placeholder="Supported office, program, or initiative"
            />
          </div>
          <div className={`form-field ${styles.spanFull}`}>
            <label className="form-label">Keywords or likely functions</label>
            <input
              className="form-input"
              value={keywords}
              onChange={(event) => updateField('keywords', event.target.value)}
              placeholder="Comma-separated capabilities, roles, or topics"
            />
          </div>
        </div>
      )}

      {queries.length > 1 && (
        <div className={styles.queryChoices} aria-label="Suggested searches">
          {queries.map((item, index) => (
            <button
              type="button"
              key={`${item.label}-${index}`}
              className={`btn ${activeQueryIndex === index ? 'btn-primary' : ''}`}
              onClick={() => selectQuery(index)}
              title={item.purpose}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {notesOnly && (suggestionDetails.summary || extractedConceptGroups.length > 0) && (
        <div className={styles.conceptPanel}>
          <div className={styles.conceptPanelHeader}>
            <div>
              <strong>Built from linked notes</strong>
              {suggestionDetails.summary && <p>{suggestionDetails.summary}</p>}
            </div>
            <span className="badge badge-tracking">Notes only</span>
          </div>
          {extractedConceptGroups.length > 0 && (
            <div className={styles.conceptGrid}>
              {extractedConceptGroups.map(([label, values]) => (
                <div className={styles.conceptGroup} key={label}>
                  <span>{label}</span>
                  <div>
                    {values.map((value) => <small key={value}>{value}</small>)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {suggestionDetails.aliasesUsed.length > 0 && (
            <div className={styles.aliasLine}>
              <span>Approved name variations</span>
              <strong>{suggestionDetails.aliasesUsed.join(', ')}</strong>
            </div>
          )}
        </div>
      )}

      <div className="form-field">
        <div className={styles.queryLabelRow}>
          <label className="form-label" htmlFor={`people-query-${generatedId}`}>Editable Google query</label>
          <span className={styles.queryGuide}>
            {notesOnly
              ? 'Generated only from linked research notes. Quotes keep phrases together; OR searches supported alternatives.'
              : 'LinkedIn profile filter → organization → office or program → roles and keywords. Quotes keep phrases together; OR searches alternatives.'}
          </span>
        </div>
        <textarea
          id={`people-query-${generatedId}`}
          className={`form-input ${styles.queryEditor}`}
          value={queryDraft}
          onChange={(event) => setQueryDraft(event.target.value)}
          rows={3}
        />
      </div>

      <div className={styles.queryActions}>
        <button type="button" className="btn" onClick={suggestQueries} disabled={suggesting}>
          {suggesting
            ? 'Generating…'
            : suggestedOnce
              ? notesOnly ? 'Regenerate from notes' : 'Regenerate query'
              : notesOnly ? 'Generate from notes' : 'Suggest query'}
        </button>
        {suggestionDetails.broadenedQuery && suggestionDetails.broadenedQuery !== queryDraft && (
          <button type="button" className="btn" onClick={broadenSearch}>
            Broaden search
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={runSearch} disabled={searching || !queryDraft.trim()}>
          {searching ? 'Searching…' : 'Search public profiles'}
        </button>
        {queryDraft.trim() && (
          <a
            className="btn"
            href={googleSearchUrl(queryDraft)}
            target="_blank"
            rel="noreferrer"
          >
            Open in Google
          </a>
        )}
        {variant === 'opportunity' && onContinue && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onContinue({
              organization,
              program,
              keywords,
              query: queryDraft,
              queries,
              sourceMode: notesOnly ? 'opportunity-notes' : 'manual',
              ...suggestionDetails,
            })}
          >
            Continue in People Search
          </button>
        )}
      </div>

      {searchNotice && <p className={styles.notice} role="status">{searchNotice}</p>}

      <div className={styles.divider} />

      <div className={styles.resultsHeader}>
        <div>
          <h3>Public profile results</h3>
          <p>Review each public result before saving anything to Contacts.</p>
        </div>
        <div className={styles.resultHeaderActions}>
          {excludedCount > 0 && (
            <button type="button" className="btn" onClick={() => setShowExcluded((value) => !value)}>
              {showExcluded ? 'Hide excluded' : `Show excluded (${excludedCount})`}
            </button>
          )}
          {searched && <span className="badge badge-tracking">{results.length} results</span>}
        </div>
      </div>

      {!searched && !searching
        ? <div className={styles.emptyState}>Run a search to review public LinkedIn profile results here.</div>
        : searching
          ? <div className={styles.loadingState}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
          : visibleResults.length === 0
            ? <div className={styles.emptyState}>{excludedCount ? 'All visible results have been excluded.' : 'No embedded results are available. Try the same query with Open in Google.'}</div>
            : (
              <div className={styles.resultsLayout}>
                <div className={styles.resultList}>
                  {visibleResults.map((result) => {
                    const decision = decisions[result.url] || 'review'
                    return (
                      <div
                        key={result.url}
                        className={`${styles.resultRow} ${selectedUrl === result.url ? styles.resultRowActive : ''} ${decision === 'irrelevant' ? styles.resultRowExcluded : ''}`}
                      >
                        <button type="button" className={styles.resultOpen} onClick={() => setSelectedUrl(result.url)}>
                          <strong>{result.title || 'Public LinkedIn profile'}</strong>
                          <span>{result.snippet || result.visibleUrl}</span>
                        </button>
                        <span className={`btn ${styles.reviewStatus}`}>
                          {decision === 'added' ? 'Added' : decision === 'relevant' ? 'Relevant' : decision === 'irrelevant' ? 'Excluded' : 'Review'}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {selected && (
                  <div className={styles.resultDetail}>
                    <div className={styles.detailEyebrow}>Public LinkedIn result</div>
                    <h3>{selected.title || 'Public profile'}</h3>
                    <p>{selected.snippet || 'Google did not return a public profile description.'}</p>
                    <dl>
                      <dt>Public URL</dt>
                      <dd>{selected.visibleUrl || selected.url}</dd>
                      <dt>Found using</dt>
                      <dd>{queries[activeQueryIndex]?.label || 'Edited Google query'}</dd>
                    </dl>
                    <div className={styles.detailActions}>
                      <a className="btn" href={selected.url} target="_blank" rel="noreferrer">Open profile</a>
                      {decisions[selected.url] === 'irrelevant'
                        ? <button type="button" className="btn" onClick={() => restoreResult(selected)}>Restore</button>
                        : <>
                            <button type="button" className="btn" onClick={() => markResult(selected, 'relevant')}>Relevant</button>
                            <button type="button" className="btn btn-ghost" onClick={() => markResult(selected, 'irrelevant')}>Not relevant</button>
                          </>
                      }
                      {decisions[selected.url] === 'relevant' && (
                        <button type="button" className="btn btn-primary" onClick={() => beginAddContact(selected)}>Add to Contacts</button>
                      )}
                      {decisions[selected.url] === 'added' && <span className="badge badge-done">Added to Contacts</span>}
                    </div>
                  </div>
                )}
              </div>
            )
      }

      <div id={googleElementId} className={styles.googleProvider} aria-hidden="true" />
      <div className={styles.googleAttribution}>Enhanced by Google · Public indexed results only</div>
    </div>
  )

  return (
    <>
      {variant === 'opportunity'
        ? (
          <div className={`card ${styles.opportunitySection}`}>
            <button
              type="button"
              className={styles.opportunityToggle}
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              <span>
                <strong>Find Contacts</strong>
                <small>Generate one editable public-profile search from linked research notes.</small>
              </span>
              <span
                className={`${styles.opportunityChevron} ${expanded ? styles.opportunityChevronOpen : ''}`}
                aria-hidden="true"
              >
                ›
              </span>
            </button>
            <div className={styles.opportunityBody} hidden={!expanded}>{content}</div>
          </div>
        )
        : <div className={`card ${styles.contactsCard}`}>{content}</div>
      }

      {contactDraft && (
        <Modal
          title="Add public profile to Contacts"
          onClose={() => !savingContact && setContactDraft(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setContactDraft(null)} disabled={savingContact}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={saveContact} disabled={savingContact || !contactDraft.Name.trim()}>
                {savingContact ? 'Adding…' : variant === 'opportunity' ? 'Add and link contact' : 'Add contact'}
              </button>
            </>
          )}
        >
          <p className={styles.contactReviewNote}>
            Google profile information can be incomplete. Review these fields before saving.
          </p>
          <div className={styles.contactForm}>
            {[
              ['Name', 'Name', true],
              ['Title', 'Title', false],
              ['Agency', 'Agency / Company', false],
              ['Organization', 'Department / Organization', false],
              ['Offices', 'Offices', false],
              ['Email', 'Email', false],
              ['Phone', 'Phone', false],
            ].map(([field, label, required]) => (
              <div className="form-field" key={field}>
                <label className="form-label">{label}{required ? ' *' : ''}</label>
                <input
                  className="form-input"
                  type={field === 'Email' ? 'email' : 'text'}
                  value={contactDraft[field] || ''}
                  onChange={(event) => setContactDraft((current) => ({ ...current, [field]: event.target.value }))}
                />
              </div>
            ))}
            <div className="form-field">
              <label className="form-label">Type</label>
              <select
                className="form-input"
                value={contactDraft.Type}
                onChange={(event) => setContactDraft((current) => ({ ...current, Type: event.target.value }))}
              >
                {[...new Set(contactTypes)].map((type) => <option key={type}>{type}</option>)}
              </select>
            </div>
            <div className={`form-field ${styles.spanFull}`}>
              <label className="form-label">Notes</label>
              <textarea
                className="form-input"
                rows={3}
                value={contactDraft.Notes || ''}
                onChange={(event) => setContactDraft((current) => ({ ...current, Notes: event.target.value }))}
              />
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
