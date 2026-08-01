import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addEmailFollowUpDraft,
  getEmailFollowUpDrafts,
  getEmailFollowUpTemplates,
  updateEmailFollowUpDraft,
} from '@/services/graphService'
import { buildFollowUpDraft, isoDate } from '@/utils/followUpEmails'
import { sendAIMessage } from '@/services/groqService'
import styles from './FollowUpEmailComposer.module.css'

const clean = (value) => String(value ?? '').trim()

function contactRecipients(contacts) {
  const seen = new Set()
  return contacts.flatMap((contact) => {
    const email = clean(contact.Email)
    const key = email.toLowerCase()
    if (!email || seen.has(key)) return []
    seen.add(key)
    return [{ name: clean(contact.Name), firstName: clean(contact.Name).split(/\s+/)[0] || '', email }]
  })
}

function parseRecipientEmails(value) {
  return String(value || '').split(/[;,]/).map(clean).filter(Boolean)
}

function recipientsInDraft(draft, availableRecipients) {
  const emails = new Set(parseRecipientEmails(draft?.To).map((value) => value.toLowerCase()))
  return availableRecipients.filter((contact) => emails.has(contact.email.toLowerCase()))
}

function renderRecipientTemplate(draft, template, opportunity, recipients) {
  if (!template || !recipients.length) return null
  return buildFollowUpDraft({
    opportunity: { ...opportunity, samUrl: samLink(opportunity) },
    template,
    recipients,
    cc: draft?.CC || '',
    source: draft?.['Enrollment Source'] || 'Manual',
  })
}

function reconcileLegacyRecipients(draft, templates, opportunity, availableRecipients) {
  if (!draft || availableRecipients.length < 2) return { draft, patch: null }
  const updatedBy = clean(draft['Updated By']).toLowerCase()
  const untouchedAutomatic = clean(draft['Enrollment Source']).toLowerCase() === 'automatic' &&
    (!updatedBy || updatedBy === 'scheduled worker' || updatedBy === 'automatic recipient sync')
  if (!untouchedAutomatic) return { draft, patch: null }
  const template = templates.find((item) => clean(item['Template ID']) === clean(draft['Template ID']))
  if (!template) return { draft, patch: null }

  const draftEmails = parseRecipientEmails(draft.To)
  const currentRecipients = recipientsInDraft(draft, availableRecipients)
  const allRecipientsKnown = draftEmails.length > 0 && draftEmails.length === currentRecipients.length
  if (!allRecipientsKnown) return { draft, patch: null }

  const target = renderRecipientTemplate(draft, template, opportunity, availableRecipients)
  const possibleOriginals = [
    renderRecipientTemplate(draft, template, opportunity, currentRecipients),
    ...availableRecipients.map((recipient) => renderRecipientTemplate(draft, template, opportunity, [recipient])),
  ].filter(Boolean)
  const bodyMatchesTemplate = possibleOriginals.some((item) => clean(item.Body) === clean(draft.Body))
  const subjectMatchesTemplate = possibleOriginals.some((item) => clean(item.Subject) === clean(draft.Subject))
  const needsAllRecipients = currentRecipients.length !== availableRecipients.length
  if (!bodyMatchesTemplate && !subjectMatchesTemplate) return { draft, patch: null }

  const patch = {
    ...(needsAllRecipients ? { To: target.To } : {}),
    ...(bodyMatchesTemplate && clean(target.Body) !== clean(draft.Body) ? { Body: target.Body } : {}),
    ...(subjectMatchesTemplate && clean(target.Subject) !== clean(draft.Subject) ? { Subject: target.Subject } : {}),
  }
  return Object.keys(patch).length
    ? { draft: { ...draft, ...patch }, patch }
    : { draft, patch: null }
}

function samLink(opportunity) {
  return clean(opportunity['Other Links*'])
    .split(/\s+/)
    .find((value) => /sam\.gov/i.test(value)) || ''
}

function statusTone(status) {
  if (status === 'Ready for review') return styles.ready
  if (status === 'Recipient needed') return styles.needsRecipient
  if (status === 'Skipped') return styles.skipped
  return styles.scheduled
}

export default function FollowUpEmailComposer({ opportunity, linkedContacts = [], user, toast }) {
  const [open, setOpen] = useState(false)
  const [templates, setTemplates] = useState([])
  const [drafts, setDrafts] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [form, setForm] = useState(null)
  const [loading, setLoading] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [improving, setImproving] = useState(false)
  const savingRef = useRef(false)
  const opportunityId = clean(opportunity?.['Contract Number / Notice ID'])
  const availableRecipients = useMemo(() => contactRecipients(linkedContacts), [linkedContacts])
  const submissionDate = isoDate(opportunity?.['Submission Date (Response Date)*'])
  const eligible = clean(opportunity?.['TAG Pipeline Activity Phase']) === 'Submitted RFI' && Boolean(submissionDate)

  const opportunityDrafts = useMemo(
    () => drafts
      .filter((draft) => clean(draft['Opportunity ID']).toLowerCase() === opportunityId.toLowerCase())
      .sort((a, b) => Number(a['Milestone Days']) - Number(b['Milestone Days'])),
    [drafts, opportunityId],
  )
  const selected = opportunityDrafts.find((draft) => draft['Draft ID'] === selectedId) || opportunityDrafts[0] || null

  const load = async () => {
    setLoading(true)
    try {
      const [templateRows, draftRows] = await Promise.all([
        getEmailFollowUpTemplates(),
        getEmailFollowUpDrafts(),
      ])
      const isConfigured = templateRows !== null && draftRows !== null
      setConfigured(isConfigured)
      const loadedTemplates = templateRows || []
      const reconciled = (draftRows || []).map((draft) => reconcileLegacyRecipients(
        draft,
        loadedTemplates,
        opportunity,
        availableRecipients,
      ))
      const loadedDrafts = reconciled.map((item) => item.draft)
      setTemplates(loadedTemplates)
      setDrafts(loadedDrafts)
      const repairs = reconciled.filter((item) => item.patch && Number.isInteger(item.draft._rowIndex))
      if (repairs.length) {
        void Promise.allSettled(repairs.map((item) =>
          updateEmailFollowUpDraft(item.draft._rowIndex, item.patch, 'Automatic recipient sync')
        ))
      }
      const matching = loadedDrafts
        .filter((draft) => clean(draft['Opportunity ID']).toLowerCase() === opportunityId.toLowerCase())
        .sort((a, b) => Number(a['Milestone Days']) - Number(b['Milestone Days']))
      const initial = matching.find((draft) => draft.Status !== 'Skipped') || matching[0]
      setSelectedId(initial?.['Draft ID'] || '')
      setForm(initial ? { ...initial } : null)
    } catch (error) {
      toast?.error(`Could not load follow-up drafts: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setOpen(false)
    setForm(null)
    setDrafts([])
    setSelectedId('')
  }, [opportunityId])

  useEffect(() => {
    if (open && !loading && !form && !drafts.length) load()
  }, [open])

  useEffect(() => {
    if (selected) setForm({ ...selected })
  }, [selectedId, selected?._rowIndex])

  const enroll = async () => {
    if (enrolling || !eligible) return
    const activeTemplates = templates.filter((template) => clean(template.Active).toLowerCase() !== 'no')
    if (!activeTemplates.length) {
      toast?.error('Create at least one active follow-up template in Settings first.')
      return
    }
    setEnrolling(true)
    try {
      const sourceOpportunity = {
        ...opportunity,
        samUrl: samLink(opportunity),
      }
      const created = []
      for (const template of activeTemplates) {
        const record = buildFollowUpDraft({
          opportunity: sourceOpportunity,
          template,
          recipients: availableRecipients,
          user: user?.displayName,
          source: 'Manual',
        })
        created.push(await addEmailFollowUpDraft(record))
      }
      setDrafts((previous) => [
        ...previous.filter((draft) => !created.some((item) => item['Draft ID'] === draft['Draft ID'])),
        ...created,
      ])
      const first = created[0]
      setSelectedId(first?.['Draft ID'] || '')
      setForm(first ? { ...first } : null)
      toast?.success(`${created.length} follow-up draft${created.length === 1 ? '' : 's'} prepared`)
    } catch (error) {
      toast?.error(`Could not prepare follow-up drafts: ${error.message}`)
    } finally {
      setEnrolling(false)
    }
  }

  const toggleRecipient = (email) => {
    setForm((current) => {
      if (!current) return current
      const selected = new Set(parseRecipientEmails(current.To).map((value) => value.toLowerCase()))
      if (selected.has(email.toLowerCase())) selected.delete(email.toLowerCase())
      else selected.add(email.toLowerCase())
      const ordered = availableRecipients
        .filter((contact) => selected.has(contact.email.toLowerCase()))
        .map((contact) => contact.email)
      const unmatched = parseRecipientEmails(current.To)
        .filter((value) => !availableRecipients.some((contact) => contact.email.toLowerCase() === value.toLowerCase()))
      const next = { ...current, To: [...ordered, ...unmatched].join('; ') }
      const template = templates.find((item) => clean(item['Template ID']) === clean(current['Template ID']))
      const previousRecipients = recipientsInDraft(current, availableRecipients)
      const nextRecipients = recipientsInDraft(next, availableRecipients)
      const previousRender = renderRecipientTemplate(current, template, opportunity, previousRecipients)
      const nextRender = renderRecipientTemplate(next, template, opportunity, nextRecipients)
      if (previousRender && nextRender && clean(current.Body) === clean(previousRender.Body)) next.Body = nextRender.Body
      if (previousRender && nextRender && clean(current.Subject) === clean(previousRender.Subject)) next.Subject = nextRender.Subject
      return next
    })
  }

  const save = async (status = form?.Status || 'Ready for review') => {
    if (!form || savingRef.current) return
    if (!clean(form.To)) {
      toast?.error('Add a recipient before saving this draft.')
      return
    }
    if (!clean(form.Subject) || !clean(form.Body)) {
      toast?.error('Subject and email body are required.')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const patch = { To: form.To, CC: form.CC, Subject: form.Subject, Body: form.Body, Status: status }
      await updateEmailFollowUpDraft(form._rowIndex, patch, user?.displayName)
      const updated = { ...form, ...patch }
      setDrafts((previous) => previous.map((draft) => draft['Draft ID'] === form['Draft ID'] ? updated : draft))
      setForm(updated)
      toast?.success(status === 'Skipped' ? 'Follow-up skipped' : 'Draft saved')
    } catch (error) {
      toast?.error(`Could not save draft: ${error.message}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const improve = async () => {
    if (!form || improving) return
    setImproving(true)
    try {
      const result = await sendAIMessage({
        promptType: 'email_draft',
        message: 'Improve the provided draft while preserving its facts, intent, and concise tone. Return only the email body.',
        context: {
          opportunity,
          currentDraft: { subject: form.Subject, body: form.Body },
        },
      })
      if (!clean(result?.content)) throw new Error('AI returned an empty draft')
      setForm((current) => ({ ...current, Body: result.content }))
    } catch (error) {
      toast?.error(`Could not improve the draft: ${error.message}`)
    } finally {
      setImproving(false)
    }
  }

  return (
    <section className={styles.panel}>
      <button type="button" className={styles.panelHeader} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={styles.headerCopy}>
          <span className={styles.title}>RFI follow-up email</span>
          <span className={styles.hint}>Prepare and review milestone drafts. Nothing is sent automatically.</span>
        </span>
        {opportunityDrafts.length > 0 && <span className={styles.count}>{opportunityDrafts.length}</span>}
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>›</span>
      </button>

      {open && (
        <div className={styles.body}>
          {loading && <div className="skeleton" style={{ height: 220 }} />}
          {!loading && !configured && (
            <div className={styles.notice}>Follow-up email tables are not configured. An administrator can add them using the workbook setup guide.</div>
          )}
          {!loading && configured && !eligible && (
            <div className={styles.notice}>Email follow-ups become available after this opportunity is marked Submitted RFI and has a submission date.</div>
          )}
          {!loading && configured && eligible && !opportunityDrafts.length && (
            <div className={styles.empty}>
              <div>
                <strong>No email follow-ups are enrolled for this RFI</strong>
                <p>Older RFIs are never enrolled automatically. Enable them here when you are ready.</p>
              </div>
              <button type="button" className="btn btn-primary" onClick={enroll} disabled={enrolling}>
                {enrolling ? 'Preparing…' : 'Enable email follow-ups'}
              </button>
            </div>
          )}

          {!loading && configured && form && (
            <>
              <div className={styles.milestones}>
                {opportunityDrafts.map((draft) => (
                  <button
                    type="button"
                    key={draft['Draft ID']}
                    className={`${styles.milestone} ${draft['Draft ID'] === form['Draft ID'] ? styles.activeMilestone : ''}`}
                    onClick={() => setSelectedId(draft['Draft ID'])}
                  >
                    <span>Day {draft['Milestone Days']}</span>
                    <small>{draft['Due Date'] || 'No due date'}</small>
                  </button>
                ))}
              </div>

              <div className={styles.composerHeader}>
                <div>
                  <strong>{form['Template Name'] || `Day ${form['Milestone Days']} follow-up`}</strong>
                  <span className={`${styles.status} ${statusTone(form.Status)}`}>{form.Status || 'Draft'}</span>
                </div>
                <small>Due {form['Due Date'] || 'date unavailable'}</small>
              </div>

              {availableRecipients.length > 0 && (
                <fieldset className={styles.recipientPicker}>
                  <legend>Linked contact recipients</legend>
                  <div className={styles.recipientOptions}>
                    {availableRecipients.map((contact) => (
                      <label key={contact.email}>
                        <input
                          type="checkbox"
                          checked={parseRecipientEmails(form.To).some((value) => value.toLowerCase() === contact.email.toLowerCase())}
                          onChange={() => toggleRecipient(contact.email)}
                        />
                        <span><strong>{contact.name || contact.email}</strong><small>{contact.email}</small></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className={styles.addressRows}>
                <label><span>From</span><input value="Procurement mailbox · available after mail permissions" readOnly /></label>
                <label><span>To</span><input value={form.To || ''} onChange={(event) => setForm((current) => ({ ...current, To: event.target.value }))} placeholder="Recipient email" /></label>
                <label><span>CC</span><input value={form.CC || ''} onChange={(event) => setForm((current) => ({ ...current, CC: event.target.value }))} placeholder="Optional" /></label>
                <label><span>Subject</span><input value={form.Subject || ''} onChange={(event) => setForm((current) => ({ ...current, Subject: event.target.value }))} /></label>
              </div>

              <textarea className={styles.editor} value={form.Body || ''} onChange={(event) => setForm((current) => ({ ...current, Body: event.target.value }))} aria-label="Email body" />

              <div className={styles.safety}>
                <span>Nothing is sent automatically. Release 1 stores editable drafts only.</span>
                <button type="button" className="btn btn-ghost" onClick={improve} disabled={improving}>{improving ? 'Improving…' : 'Improve with AI'}</button>
              </div>

              <div className={styles.actions}>
                <div className={styles.disabledActions}>
                  <button type="button" className="btn btn-primary" disabled title="Available after Exchange mail permissions">Send from CRM</button>
                  <button type="button" className="btn" disabled title="Available after Outlook integration">Open in Outlook</button>
                </div>
                <div>
                  <button type="button" className="btn btn-ghost" onClick={() => save('Skipped')} disabled={saving}>Skip follow-up</button>
                  <button type="button" className="btn btn-primary" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save draft'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
