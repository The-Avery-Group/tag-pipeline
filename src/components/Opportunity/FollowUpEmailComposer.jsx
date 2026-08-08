import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addEmailFollowUpDraft,
  getEmailFollowUpDrafts,
  getEmailFollowUpTemplates,
  updateEmailFollowUpDraft,
} from '@/services/graphService'
import { buildFollowUpDraft } from '@/utils/followUpEmails'
import { sendAIMessage } from '@/services/groqService'
import { upsertOutlookDraft } from '@/services/outlookService'
import { outlookLaunchPlan } from '@/utils/outlookDrafts'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'
import RichEmailEditor from '@/components/Common/RichEmailEditor'
import {
  containsGenericEmailPlaceholder,
  isEmptyEmailHtml,
  protectEmailHtmlForAI,
  restoreProtectedEmailHtml,
  sanitizeEmailHtml,
} from '@/utils/emailHtml'
import styles from './FollowUpEmailComposer.module.css'
import { onCacheRefresh } from '@/services/dataCache'

const clean = (value) => String(value ?? '').trim()
const PROCUREMENT_EMAIL = clean(import.meta.env.VITE_PROCUREMENT_EMAIL)

function renderOutlookHandoff(targetWindow, webUrl) {
  if (!targetWindow || targetWindow.closed) return
  const document = targetWindow.document
  document.title = 'Open Outlook'
  document.body.style.cssText = 'margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#334155;font:14px system-ui,sans-serif'
  document.body.replaceChildren()

  const panel = document.createElement('div')
  panel.style.cssText = 'display:grid;gap:10px;max-width:420px;padding:28px;text-align:center'
  const title = document.createElement('strong')
  title.style.cssText = 'font-size:18px;color:#0f172a'
  title.textContent = 'Opening the Outlook app'
  const message = document.createElement('span')
  message.style.cssText = 'line-height:1.5;color:#475569'
  message.textContent = 'Your draft is saved in Outlook Drafts. If the app does not open, continue in Outlook on the web.'
  const webLink = document.createElement('a')
  webLink.href = webUrl
  webLink.style.cssText = 'justify-self:center;margin-top:4px;padding:9px 14px;border-radius:7px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600'
  webLink.textContent = 'Open Outlook on the web'
  panel.append(title, message, webLink)
  document.body.append(panel)
}

function launchOutlookAppFirst(targetWindow, webLink) {
  const plan = outlookLaunchPlan(webLink)
  if (!targetWindow || targetWindow.closed) {
    const opened = window.open(plan.webUrl, '_blank', 'noopener,noreferrer')
    if (!opened) throw new Error('The Outlook draft was created, but the browser blocked the new window. Allow pop-ups and try again.')
    return
  }

  renderOutlookHandoff(targetWindow, plan.webUrl)
  let appLikelyOpened = false
  targetWindow.addEventListener('blur', () => { appLikelyOpened = true }, { once: true })

  try {
    targetWindow.location.href = plan.appUrl
  } catch {
    targetWindow.location.replace(plan.webUrl)
    return
  }

  window.setTimeout(() => {
    if (appLikelyOpened || targetWindow.closed) return
    try { targetWindow.location.replace(plan.webUrl) } catch { /* The external app owns the window. */ }
  }, plan.fallbackDelayMs)
}

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

function reconcileTemplateVersion(draft, templates, opportunity, availableRecipients) {
  const template = templates.find((item) => clean(item['Template ID']) === clean(draft?.['Template ID']))
  if (!template) return { draft, patch: null }
  const templateUpdated = Date.parse(template['Last Updated'] || template['Created At'] || '') || 0
  const draftUpdated = Date.parse(draft['Updated At'] || draft['Created At'] || '') || 0
  if (!templateUpdated || templateUpdated <= draftUpdated) return { draft, patch: null }
  if (['Opened in Outlook', 'Skipped'].includes(clean(draft.Status)) || clean(draft['Outlook Draft ID'])) {
    return { draft, patch: null }
  }
  const untouched = clean(draft['Updated At']) === clean(draft['Created At']) ||
    ['scheduled worker', 'automatic recipient sync', 'automatic template sync'].includes(clean(draft['Updated By']).toLowerCase())
  if (!untouched) return { draft, patch: null }

  const currentRecipients = recipientsInDraft(draft, availableRecipients)
  const refreshed = buildFollowUpDraft({
    opportunity: { ...opportunity, samUrl: samLink(opportunity) },
    template,
    recipients: currentRecipients,
    recipient: currentRecipients.length ? '' : draft.To,
    from: draft.From,
    cc: draft.CC,
    source: draft['Enrollment Source'] || 'Manual',
  })
  const patch = {
    'Template Name': refreshed['Template Name'],
    'Milestone Days': refreshed['Milestone Days'],
    'Due Date': refreshed['Due Date'],
    Subject: refreshed.Subject,
    Body: refreshed.Body,
  }
  return { draft: { ...draft, ...patch }, patch }
}

function samLink(opportunity) {
  return clean(opportunity['Other Links*'])
    .split(/\s+/)
    .find((value) => /sam\.gov/i.test(value)) || ''
}

function statusTone(status) {
  if (status === 'Ready for review') return styles.ready
  if (status === 'Opened in Outlook') return styles.outlook
  if (status === 'Recipient needed') return styles.needsRecipient
  if (status === 'Skipped') return styles.skipped
  return styles.scheduled
}

export default function FollowUpEmailComposer({ opportunity, linkedContacts = [], user, toast }) {
  const panelRef = useRef(null)
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
  const [openingOutlook, setOpeningOutlook] = useState(false)
  const [undoDepth, setUndoDepth] = useState(0)
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateToPrepare, setTemplateToPrepare] = useState('')
  const savingRef = useRef(false)
  const saveRef = useRef(null)
  const formRef = useRef(null)
  const undoStackRef = useRef([])
  const lastUndoGroupRef = useRef({ key: '', at: 0 })
  const opportunityId = clean(opportunity?.['Contract Number / Notice ID'])
  const availableRecipients = useMemo(() => contactRecipients(linkedContacts), [linkedContacts])
  const defaultSender = PROCUREMENT_EMAIL || clean(user?.email)
  const senderOptions = useMemo(() => {
    const options = [
      ...(PROCUREMENT_EMAIL ? [{ value: PROCUREMENT_EMAIL, label: 'Procurement mailbox' }] : []),
      ...(clean(user?.email) ? [{ value: clean(user.email), label: 'My work email' }] : []),
    ]
    const current = clean(form?.From)
    if (current && !options.some((option) => option.value.toLowerCase() === current.toLowerCase())) {
      options.push({ value: current, label: current })
    }
    return options
  }, [form?.From, user?.email])
  const activeTemplates = useMemo(
    () => templates.filter((template) => clean(template.Active).toLowerCase() !== 'no'),
    [templates],
  )
  const filteredTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase()
    return activeTemplates.filter((template) => !query || `${template['Template Name']} ${template.Subject} ${template['Days After Submission']}`.toLowerCase().includes(query))
  }, [activeTemplates, templateQuery])

  useEffect(() => {
    if (filteredTemplates.some((template) => template['Template ID'] === templateToPrepare)) return
    setTemplateToPrepare(filteredTemplates[0]?.['Template ID'] || '')
  }, [filteredTemplates, templateToPrepare])

  const opportunityDrafts = useMemo(
    () => drafts
      .filter((draft) => clean(draft['Opportunity ID']).toLowerCase() === opportunityId.toLowerCase())
      .sort((a, b) => Number(a['Milestone Days']) - Number(b['Milestone Days'])),
    [drafts, opportunityId],
  )
  const selected = opportunityDrafts.find((draft) => draft['Draft ID'] === selectedId) || opportunityDrafts[0] || null

  const resetUndo = () => {
    undoStackRef.current = []
    lastUndoGroupRef.current = { key: '', at: 0 }
    setUndoDepth(0)
  }

  const rememberForUndo = (snapshot, groupKey = '') => {
    if (!snapshot) return
    const now = Date.now()
    const previousGroup = lastUndoGroupRef.current
    const isSameTypingGroup = groupKey && previousGroup.key === groupKey && now - previousGroup.at < 800
    if (!isSameTypingGroup) {
      undoStackRef.current = [...undoStackRef.current.slice(-24), { ...snapshot }]
      setUndoDepth(undoStackRef.current.length)
    }
    lastUndoGroupRef.current = { key: groupKey, at: now }
  }

  const updateField = (field, value) => {
    rememberForUndo(form, `field:${field}`)
    const next = { ...form, [field]: value }
    formRef.current = next
    setForm(next)
  }

  const undo = () => {
    const previous = undoStackRef.current.pop()
    if (!previous) return
    formRef.current = previous
    setForm(previous)
    lastUndoGroupRef.current = { key: '', at: 0 }
    setUndoDepth(undoStackRef.current.length)
  }

  const load = async ({ force = false, quiet = false, preserveForm = false } = {}) => {
    setLoading(true)
    try {
      const [templateRows, draftRows] = await Promise.all([
        getEmailFollowUpTemplates({ force }),
        getEmailFollowUpDrafts({ force }),
      ])
      const isConfigured = templateRows !== null && draftRows !== null
      setConfigured(isConfigured)
      const loadedTemplates = templateRows || []
      const reconciled = (draftRows || []).map((draft) => {
        const recipientResult = reconcileLegacyRecipients(draft, loadedTemplates, opportunity, availableRecipients)
        const templateResult = reconcileTemplateVersion(recipientResult.draft, loadedTemplates, opportunity, availableRecipients)
        return {
          draft: templateResult.draft,
          patch: { ...(recipientResult.patch || {}), ...(templateResult.patch || {}) },
        }
      })
      const loadedDrafts = reconciled.map((item) => ({
        ...item.draft,
        From: clean(item.draft.From) || defaultSender,
      }))
      setTemplates(loadedTemplates)
      setDrafts(loadedDrafts)
      if (!templateToPrepare && loadedTemplates.length) setTemplateToPrepare(loadedTemplates.find((item) => clean(item.Active).toLowerCase() !== 'no')?.['Template ID'] || '')
      const repairs = reconciled.filter((item) => Object.keys(item.patch || {}).length && Number.isInteger(item.draft._rowIndex))
      if (repairs.length) {
        void Promise.allSettled(repairs.map((item) =>
          updateEmailFollowUpDraft(item.draft._rowIndex, item.patch, 'Automatic template sync')
        ))
      }
      const matching = loadedDrafts
        .filter((draft) => clean(draft['Opportunity ID']).toLowerCase() === opportunityId.toLowerCase())
        .sort((a, b) => Number(a['Milestone Days']) - Number(b['Milestone Days']))
      const initial = (preserveForm && matching.find((draft) => draft['Draft ID'] === selectedId)) ||
        matching.find((draft) => draft.Status !== 'Skipped') || matching[0]
      setSelectedId(initial?.['Draft ID'] || '')
      if (!preserveForm || !formRef.current) {
        setForm(initial ? { ...initial } : null)
        formRef.current = initial ? { ...initial } : null
        resetUndo()
      }
    } catch (error) {
      if (!quiet) toast?.error(`Could not load follow-up drafts: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setOpen(false)
    setForm(null)
    formRef.current = null
    setDrafts([])
    setSelectedId('')
    setTemplateToPrepare('')
    resetUndo()
  }, [opportunityId])

  useEffect(() => { void load({ quiet: !open }) }, [opportunityId])

  useEffect(() => onCacheRefresh((tables) => {
    if (tables.some((table) => ['EmailFollowUpTemplatesTable', 'EmailFollowUpDraftsTable'].includes(table))) {
      void load({ quiet: true, preserveForm: true })
    }
  }), [opportunityId, availableRecipients.length])

  useEffect(() => {
    if (selected) {
      const next = { ...selected, From: clean(selected.From) || defaultSender }
      formRef.current = next
      setForm(next)
      resetUndo()
    }
  }, [selectedId, selected?._rowIndex])

  useEffect(() => {
    const handleEditorShortcut = (event) => {
      if (!open || !formRef.current) return
      if (!panelRef.current?.contains(document.activeElement)) return
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'z' && undoStackRef.current.length) {
        event.preventDefault()
        undo()
      }
    }
    document.addEventListener('keydown', handleEditorShortcut)
    return () => document.removeEventListener('keydown', handleEditorShortcut)
  }, [open])

  const enroll = async () => {
    if (enrolling) return
    const template = activeTemplates.find((item) => clean(item['Template ID']) === clean(templateToPrepare))
    if (!template) {
      toast?.error('Create at least one active follow-up template in Settings first.')
      return
    }
    setEnrolling(true)
    try {
      const sourceOpportunity = {
        ...opportunity,
        samUrl: samLink(opportunity),
      }
      const record = buildFollowUpDraft({
        opportunity: sourceOpportunity,
        template,
        recipients: availableRecipients,
        from: defaultSender,
        user: user?.displayName,
        source: 'Manual',
      })
      const created = [await addEmailFollowUpDraft(record)]
      setDrafts((previous) => [
        ...previous.filter((draft) => !created.some((item) => item['Draft ID'] === draft['Draft ID'])),
        ...created,
      ])
      const first = created[0]
      setSelectedId(first?.['Draft ID'] || '')
      setForm(first ? { ...first } : null)
      formRef.current = first ? { ...first } : null
      resetUndo()
      toast?.success('Follow-up draft prepared')
    } catch (error) {
      toast?.error(`Could not prepare follow-up drafts: ${error.message}`)
    } finally {
      setEnrolling(false)
    }
  }

  const toggleRecipient = (email) => {
    rememberForUndo(form)
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
      formRef.current = next
      return next
    })
  }

  const save = async (status = form?.Status || 'Ready for review') => {
    if (!form || savingRef.current) return
    if (!clean(form.To)) {
      toast?.error('Add a recipient before saving this draft.')
      return
    }
    if (!clean(form.Subject) || isEmptyEmailHtml(form.Body)) {
      toast?.error('Subject and email body are required.')
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const patch = { From: form.From, To: form.To, CC: form.CC, Subject: form.Subject, Body: sanitizeEmailHtml(form.Body), Status: status }
      await updateEmailFollowUpDraft(form._rowIndex, patch, user?.displayName)
      const updated = { ...form, ...patch }
      setDrafts((previous) => previous.map((draft) => draft['Draft ID'] === form['Draft ID'] ? updated : draft))
      setForm(updated)
      formRef.current = updated
      resetUndo()
      toast?.success(status === 'Skipped' ? 'Follow-up skipped' : 'Draft saved')
    } catch (error) {
      toast?.error(`Could not save draft: ${error.message}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  saveRef.current = save
  useSaveShortcut({
    enabled: open && Boolean(form) && !saving,
    label: 'this follow-up email draft',
    onSave: () => saveRef.current?.(),
    scopeRef: panelRef,
  })

  const improve = async () => {
    if (!form || improving) return
    const protectedDraft = protectEmailHtmlForAI(form.Body)
    const requestedDraft = { subject: form.Subject || '', body: protectedDraft.html }
    setImproving(true)
    try {
      const requestImprovement = (retry = false) => sendAIMessage({
          promptType: 'email_draft',
          message: retry
            ? 'Revise the current HTML email draft again. Return only safe HTML. Preserve every TAG_PROTECTED marker exactly once and do not add placeholders, a new greeting, or a new signature.'
            : 'Revise the current HTML email draft in the CRM reference data. Preserve its facts and intent, improve clarity and professional tone, and return only safe HTML. Preserve every TAG_PROTECTED marker exactly once and do not add placeholders, a new greeting, or a new signature.',
          context: { opportunity, currentDraft: requestedDraft },
        })

      const resolveImprovement = async (retry = false) => {
        const result = await requestImprovement(retry)
        if (!clean(result?.content)) throw new Error('AI returned an empty draft')
        const restored = restoreProtectedEmailHtml(result.content, protectedDraft.fragments)
        if (containsGenericEmailPlaceholder(restored)) throw new Error('AI added an unsupported placeholder')
        return restored
      }

      let improvedBody
      try {
        improvedBody = await resolveImprovement(false)
      } catch {
        improvedBody = await resolveImprovement(true)
      }
      const current = formRef.current
      if (!current) return
      rememberForUndo(current)
      const next = { ...current, Body: improvedBody }
      formRef.current = next
      setForm(next)
    } catch (error) {
      toast?.error(`Could not improve the draft: ${error.message}`)
    } finally {
      setImproving(false)
    }
  }

  const openInOutlook = async () => {
    if (!form || openingOutlook) return
    if (!clean(form.From)) {
      toast?.error('Select a From address before opening Outlook.')
      return
    }
    if (containsGenericEmailPlaceholder(`${form.Subject || ''} ${form.Body || ''}`)) {
      toast?.error('Resolve the remaining email placeholders before opening Outlook.')
      return
    }

    // Reserve a user-initiated window before token acquisition. This avoids a
    // browser popup blocker after an incremental Microsoft consent prompt.
    const outlookWindow = window.open('', 'tag-crm-outlook-draft')
    if (outlookWindow) {
      outlookWindow.document.title = 'Preparing Outlook draft'
      outlookWindow.document.body.style.cssText = 'margin:0;display:grid;place-items:center;min-height:100vh;background:#f8fafc;color:#334155;font:14px system-ui,sans-serif'
      outlookWindow.document.body.textContent = 'Preparing Outlook draft…'
    }

    setOpeningOutlook(true)
    try {
      const sanitizedBody = sanitizeEmailHtml(form.Body)
      const currentDraft = { ...form, Body: sanitizedBody }
      const outlookDraft = await upsertOutlookDraft({
        draft: currentDraft,
        from: currentDraft.From,
        userEmail: user?.email,
      })
      if (!outlookDraft?.id || !outlookDraft?.webLink) {
        throw new Error('Outlook created the draft but did not return a link to open it.')
      }

      launchOutlookAppFirst(outlookWindow, outlookDraft.webLink)

      const patch = {
        From: currentDraft.From,
        To: currentDraft.To,
        CC: currentDraft.CC,
        Subject: currentDraft.Subject,
        Body: sanitizedBody,
        Status: 'Opened in Outlook',
        'Outlook Draft ID': outlookDraft.id,
        'Outlook Web Link': outlookDraft.webLink,
        'Last Error': '',
      }
      const updated = { ...currentDraft, ...patch }
      formRef.current = updated
      setForm(updated)
      setDrafts((previous) => previous.map((draft) => draft['Draft ID'] === updated['Draft ID'] ? updated : draft))
      resetUndo()

      try {
        await updateEmailFollowUpDraft(updated._rowIndex, patch, user?.displayName)
        toast?.success(outlookDraft.created ? 'Outlook draft created' : 'Outlook draft updated')
      } catch (error) {
        toast?.info(`Outlook opened, but the CRM could not save its draft link: ${error.message}`)
      }
    } catch (error) {
      if (outlookWindow && !outlookWindow.closed) outlookWindow.close()
      toast?.error(`Could not open the Outlook draft: ${error.message}`)
    } finally {
      setOpeningOutlook(false)
    }
  }

  return (
    <section ref={panelRef} className={styles.panel}>
      <button type="button" className={styles.panelHeader} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={styles.headerCopy}>
          <span className={styles.title}>Follow-up emails</span>
          <span className={styles.hint}>Prepare and review follow-up drafts. Nothing is sent automatically.</span>
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
          {!loading && configured && (
            <div className={styles.templateChooser}>
              <label>
                <span>Template</span>
                <input
                  type="search"
                  value={templateQuery}
                  onChange={(event) => setTemplateQuery(event.target.value)}
                  placeholder="Search templates"
                  aria-label="Search follow-up email templates"
                />
              </label>
              <select
                value={templateToPrepare}
                onChange={(event) => setTemplateToPrepare(event.target.value)}
                aria-label="Select a follow-up email template"
              >
                {!filteredTemplates.length && <option value="">No matching active templates</option>}
                {filteredTemplates.map((template) => (
                  <option key={template['Template ID']} value={template['Template ID']}>
                    {template['Template Name']} · Day {template['Days After Submission']}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-primary" onClick={enroll} disabled={enrolling || !templateToPrepare}>
                {enrolling ? 'Preparing…' : 'Prepare draft'}
              </button>
            </div>
          )}
          {!loading && configured && !opportunityDrafts.length && (
            <div className={styles.empty}>
              <div>
                <strong>No follow-up drafts have been prepared</strong>
                <p>Choose a template above to prepare an editable draft for this opportunity.</p>
              </div>
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
                    <span>{draft['Template Name'] || `Day ${draft['Milestone Days']}`}</span>
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
                  <legend>Recipients from linked contacts</legend>
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
                <label>
                  <span>From</span>
                  <select value={form.From || ''} onChange={(event) => updateField('From', event.target.value)}>
                    {!senderOptions.length && <option value="">Sender not configured</option>}
                    {senderOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label} · {option.value}</option>
                    ))}
                  </select>
                </label>
                <label><span>To</span><input value={form.To || ''} onChange={(event) => updateField('To', event.target.value)} placeholder="Recipient email" /></label>
                <label><span>CC</span><input value={form.CC || ''} onChange={(event) => updateField('CC', event.target.value)} placeholder="Optional" /></label>
                <label><span>Subject</span><input value={form.Subject || ''} onChange={(event) => updateField('Subject', event.target.value)} /></label>
              </div>

              <RichEmailEditor value={form.Body || ''} onChange={(Body) => updateField('Body', Body)} ariaLabel="Email body" />

              <div className={styles.safety}>
                <span>Open in Outlook creates or updates an editable draft, then tries the installed Outlook app before falling back to the web. Nothing is sent automatically.</span>
                <div className={styles.editorActions}>
                  <button type="button" className="btn btn-ghost" onClick={undo} disabled={!undoDepth || improving} title="Undo the latest unsaved change (Ctrl+Z or Cmd+Z)">Undo</button>
                  <button type="button" className="btn btn-ghost" onClick={improve} disabled={improving}>{improving ? 'Improving…' : 'Improve with AI'}</button>
                </div>
              </div>

              <div className={styles.actions}>
                <div className={styles.disabledActions}>
                  <button type="button" className="btn" disabled title="Direct sending is reserved for Release 3">Send from CRM</button>
                  <button type="button" className="btn btn-primary" onClick={openInOutlook} disabled={openingOutlook || saving} title="Create or update this draft in Outlook">
                    {openingOutlook ? 'Opening…' : 'Open in Outlook'}
                  </button>
                </div>
                <div>
                  <button type="button" className="btn btn-ghost" onClick={() => save('Skipped')} disabled={saving}>Skip follow-up</button>
                  <button type="button" className="btn btn-primary" onClick={() => save()} disabled={saving} title="Save draft (Ctrl+S or Cmd+S)">{saving ? 'Saving…' : 'Save draft'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
