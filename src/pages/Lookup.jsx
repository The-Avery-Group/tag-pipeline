import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useContacts } from '@/hooks/useContacts'
import { useAwardsLookup } from '@/hooks/useAwardsLookup'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import { CONTACT_TYPES, OPPORTUNITY_OUTLOOK } from '@/services/graphService'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import AwardRecordCard from '@/components/Awards/AwardRecordCard'
import EntityAwardHistory from '@/components/Lookup/EntityAwardHistory'
import PeopleSearch from '@/components/PeopleSearch/PeopleSearch'
import awardStyles from '@/components/Awards/AwardRecordCard.module.css'
import styles from './Lookup.module.css'

const C_CONTRACT_NUM = 'Contract Number / Notice ID'
const C_VEHICLE_NUM = 'Contract Vehicle Number'
const C_INCUMBENT_UEI = 'Incumbent (Company UEI)'

function dateOnly(value) {
  const raw = String(value || '').trim()
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/)
  if (iso) return iso[0]
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return [parsed.getFullYear(), String(parsed.getMonth() + 1).padStart(2, '0'), String(parsed.getDate()).padStart(2, '0')].join('-')
}

// PIID is the sole contract-award lookup identifier. A PIID can identify
// several award families, so users can optionally narrow those families by
// the exact awardee UEI before the Worker applies its result cap.

function ModificationTabs({ modifications, activeIndex, onSelect }) {
  if (!modifications?.length) return null

  return (
    <div className={awardStyles.modificationTabs} role="tablist" aria-label="Recent modifications">
      {modifications.map((modification, index) => {
        const number = modification.modificationNumber?.value || (index === modifications.length - 1 ? 'Base award' : 'Modification')
        const label = index === 0 ? `Latest · ${number}` : number
        return (
          <button
            key={`${number}-${modification.dateSigned?.value || index}`}
            type="button"
            role="tab"
            aria-selected={activeIndex === index}
            className={`${awardStyles.modificationTab} ${activeIndex === index ? awardStyles.modificationTabActive : ''}`}
            onClick={() => onSelect(index)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function fieldsForModification(fields, modification) {
  if (!modification) return fields
  if (modification.snapshotFields) return modification.snapshotFields
  const withoutLatestModification = Object.fromEntries(
    Object.entries(fields || {}).filter(([, field]) => field.section !== 'Latest modification')
  )
  return { ...withoutLatestModification, ...modification }
}

function PeopleSearchLookup({ toast, initialValues, contactTypes }) {
  const { add } = useContacts()
  return (
    <PeopleSearch
      variant="contacts"
      scopeLabel={initialValues?.scopeLabel || 'general contact research'}
      context={initialValues?.context || {}}
      initialValues={initialValues || {}}
      contactTypes={contactTypes}
      onAddContact={add}
      toast={toast}
    />
  )
}

export default function Lookup({ toast }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { pipeline, add } = usePipeline()
  const { lists } = useValidationLists()
  const outlookOptions = pickList(lists, 'Opportunity Outlook', OPPORTUNITY_OUTLOOK)
  const contactTypeOptions = pickList(lists, 'Types', CONTACT_TYPES)
  const { results, loading, error, searched, cache, resultMeta, lookup } = useAwardsLookup()
  const [input, setInput] = useState('')
  const [awardeeUEI, setAwardeeUEI] = useState('')
  const [selectedModification, setSelectedModification] = useState({})
  const requestedView = searchParams.get('view')
  const lookupView = ['entity', 'people'].includes(requestedView) ? requestedView : 'awards'

  const changeLookupView = (view) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      if (view === 'awards') next.delete('view')
      else next.set('view', view)
      return next
    }, { replace: true })
  }

  const matchedPipelineRecord = useMemo(() => {
    const identifier = input.trim().toUpperCase()
    if (!identifier) return null
    return pipeline.find((opportunity) =>
      String(opportunity[C_CONTRACT_NUM] || '').trim().toUpperCase() === identifier ||
      String(opportunity[C_VEHICLE_NUM] || '').trim().toUpperCase() === identifier
    ) || null
  }, [pipeline, input])

  // Adding to the pipeline is a two-step confirm, not an immediate write —
  // specifically because Outlook defaults to "Expiring" (this data source
  // is inherently post-award, so that's usually right) but is a real
  // classification decision the user should see and can override, not
  // something silently set on their behalf. Always adds the full current
  // picture (not whatever historical mod happens to be toggled into view).
  const [pendingResult, setPendingResult] = useState(null)
  const [pendingOutlook, setPendingOutlook] = useState('Expiring')
  const [adding, setAdding] = useState(false)

  const handleSearch = () => {
    const val = input.trim()
    if (!val) return
    lookup({ piid: val, awardeeUEI: awardeeUEI.trim() })
  }

  const handleKeyDown = (e) => { if (e.key === 'Enter') handleSearch() }

  const isInPipeline = (piid) => pipeline.some((o) => o[C_CONTRACT_NUM] === piid)

  const openAddConfirm = (result) => {
    setPendingResult(result)
    setPendingOutlook('Expiring')
  }

  const handleConfirmAdd = async () => {
    if (!pendingResult) return
    const piid = pendingResult.raw?.contractId?.piid
    if (!piid) return
    setAdding(true)
    try {
      const f = pendingResult.fields
      await add({
        [C_CONTRACT_NUM]:                  piid,
        'Project Title / Description*':    f.description?.value || piid,
        // Phase reflects TAG's own BD workflow stage, not the contract's
        // real-world award status — "Identified" is the correct starting
        // point for anything newly added, earned through the pipeline from
        // here rather than auto-granted just because award data exists.
        'TAG Opportunity Phase':           'Identified',
        'Opportunity Outlook':             pendingOutlook,
        'Solicitation Number':             f.solicitationNumber?.value || '',
        'Contract Classification*':        f.awardType?.value || '',
        'Total Contract Value ($)*':       f.totalContractValue?.value || '',
        'Contract End Date*':              dateOnly(f.contractEndDate?.value),
        'NAICS Code*':                     f.naicsCode?.value || '',
        'Department*':                     f.department?.value || '',
        'Agency*':                         f.agency?.value || '',
        'Office*':                         f.office?.value || '',
        'Set- Aside*':                     f.setAside?.value || '',
        'Incumbent (Company Name)':        f.incumbentName?.value || '',
        'Incumbent (Company UEI)':         f.incumbentUEI?.value || '',
        'Contract Vehicle Number':         f.contractVehicleNumber?.value || '',
        'Fiscal Year':                     f.fiscalYear?.value || '',
        'Other Links*':                    f.awardNoticeLink?.value || '',
      })
      toast?.success('Added to pipeline')
      setPendingResult(null)
    } catch (err) {
      toast?.error(`Failed to add: ${err.message}`)
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <Topbar
        title="Lookup"
        subtitle1="Search award records, entity history, and public profiles"
        showFilter={false}
        showNew={false}
      />
      <div className="page-body">
        <div className={styles.lookupTabs} role="tablist" aria-label="Lookup type">
          <button type="button" role="tab" aria-selected={lookupView === 'awards'} className={lookupView === 'awards' ? styles.lookupTabActive : styles.lookupTab} onClick={() => changeLookupView('awards')}>Award records</button>
          <button type="button" role="tab" aria-selected={lookupView === 'entity'} className={lookupView === 'entity' ? styles.lookupTabActive : styles.lookupTab} onClick={() => changeLookupView('entity')}>Entity award history</button>
          <button type="button" role="tab" aria-selected={lookupView === 'people'} className={lookupView === 'people' ? styles.lookupTabActive : styles.lookupTab} onClick={() => changeLookupView('people')}>People Search</button>
        </div>

        {lookupView === 'entity'
          ? <EntityAwardHistory />
          : lookupView === 'people'
            ? (
              <PeopleSearchLookup
                toast={toast}
                initialValues={location.state?.peopleSearch}
                contactTypes={contactTypeOptions}
              />
            )
            : <>
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input" style={{ flex: 1 }}
              placeholder="Enter PIID…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button className="btn btn-primary" onClick={handleSearch} disabled={loading || !input.trim()}>
              {loading ? 'Searching…' : 'Search'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              placeholder="Awardee UEI to narrow PIID results (optional)"
              value={awardeeUEI}
              onChange={(e) => setAwardeeUEI(e.target.value.toUpperCase())}
            />
            {matchedPipelineRecord?.[C_INCUMBENT_UEI] && !awardeeUEI.trim() && (
              <button
                type="button"
                className="btn text-sm"
                onClick={() => setAwardeeUEI(String(matchedPipelineRecord[C_INCUMBENT_UEI]).toUpperCase())}
              >
                Use pipeline UEI
              </button>
            )}
          </div>
        </div>

        {error && (
          <p className="text-sm" style={{ color: 'var(--red-600)', marginBottom: 12 }}>
            Search failed: {error}
          </p>
        )}
        {searched && !loading && !error && results.length === 0 && (
          <p className="text-sm text-muted">
            No results found for "{input}"{awardeeUEI.trim() ? ` with awardee UEI ${awardeeUEI.trim()}` : ''}.
          </p>
        )}
        {resultMeta?.filteredByAwardeeUEI && !loading && !error && (
          <p className="text-sm text-muted" style={{ marginBottom: 12 }}>
            Showing {resultMeta.totalFamilies} {resultMeta.totalFamilies === 1 ? 'PIID family' : 'PIID families'} matching awardee UEI {resultMeta.filteredByAwardeeUEI} out of {resultMeta.unfilteredFamilies} total PIID families.
          </p>
        )}
        {resultMeta?.truncated && !loading && !error && (
          <p className="text-sm text-muted" style={{ marginBottom: 12 }}>
            Showing the 5 most recently signed award families out of {resultMeta.totalFamilies}. Refine the identifier or incumbent to narrow the results.
          </p>
        )}

        {results.map((r) => {
          const piid = r.piid || r.raw?.contractId?.piid
          const isIDV = r.isIDV
          const already = isInPipeline(piid)
          const modifications = r.modifications || []
          const activeModificationIndex = Math.min(selectedModification[piid] ?? 0, Math.max(modifications.length - 1, 0))
          const activeFields = fieldsForModification(r.fields, modifications[activeModificationIndex])
          const viewingLatestModification = activeModificationIndex === 0

          return (
            <div key={piid || Math.random()}>
              <ModificationTabs
                modifications={modifications}
                activeIndex={activeModificationIndex}
                onSelect={(index) => setSelectedModification((previous) => ({ ...previous, [piid]: index }))}
              />
              {modifications.length > 0 && (
                <p className="text-xs text-muted" style={{ margin: '0 0 8px' }}>
                  Each tab shows data reported by SAM for that modification. Values from later modifications are not carried back.
                </p>
              )}
              <AwardRecordCard
                piid={piid}
                isIDV={isIDV}
                modificationCount={r.modificationCount}
                originalSignedDate={r.originalSignedDate}
                samLink={r.samLink}
                cache={cache}
                onRefresh={() => {
                  const val = input.trim()
                  return lookup({ piid: val, awardeeUEI: awardeeUEI.trim(), forceRefresh: true })
                }}
                refreshing={loading}
                fields={activeFields}
                contractLifecycleAlert={viewingLatestModification ? r.contractLifecycleAlert : null}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -6, marginBottom: 14 }}>
                {already
                  ? (
                    <button className="btn text-sm"
                      onClick={() => navigate(`/opportunities/${encodeURIComponent(piid)}`)}>
                      Already in pipeline — view →
                    </button>
                  )
                  : (
                    <button className="btn btn-primary text-sm"
                      onClick={() => openAddConfirm(r)}>
                      + Add to pipeline
                    </button>
                  )
                }
              </div>
            </div>
          )
        })}
            </>}
      </div>

      {pendingResult && (
        <Modal
          title="Add to pipeline"
          onClose={() => !adding && setPendingResult(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPendingResult(null)} disabled={adding}>Cancel</button>
              <button className="btn btn-primary" onClick={handleConfirmAdd} disabled={adding}>
                {adding ? 'Adding…' : 'Confirm & add'}
              </button>
            </>
          }
        >
          <p className="text-sm" style={{ marginBottom: 14 }}>
            Adding <strong>{pendingResult.raw?.contractId?.piid}</strong> to the pipeline.
          </p>
          <div className="form-field" style={{ marginBottom: 12 }}>
            <label className="form-label">Phase</label>
            <input className="form-input" value="Identified" disabled />
            <span className="text-xs text-muted" style={{ marginTop: 4 }}>
              Always starts here — advances through the pipeline from this point, same as any other opportunity.
            </span>
          </div>
          <div className="form-field">
            <label className="form-label">Outlook</label>
            <select className="form-input" value={pendingOutlook} onChange={(e) => setPendingOutlook(e.target.value)}>
              {outlookOptions.map((o) => <option key={o}>{o}</option>)}
            </select>
            <span className="text-xs text-muted" style={{ marginTop: 4 }}>
              Defaults to "Expiring" since this data is already-awarded — change it if that's not right here.
            </span>
          </div>
        </Modal>
      )}
    </>
  )
}
