import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addEmailFollowUpTemplate,
  deleteEmailFollowUpTemplate,
  getEmailFollowUpTemplates,
  updateEmailFollowUpTemplate,
} from '@/services/graphService'
import { FOLLOW_UP_MERGE_FIELDS } from '@/utils/followUpEmails'
import styles from './FollowUpEmailTemplates.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'
import RichEmailEditor from '@/components/Common/RichEmailEditor'
import { isEmptyEmailHtml, sanitizeEmailHtml } from '@/utils/emailHtml'
import { onCacheRefresh, forceRefreshCache } from '@/services/dataCache'

const EMPTY_TEMPLATE = {
  'Template Name': '',
  'Days After Submission': 21,
  Subject: '',
  Body: '',
  Active: 'Yes',
}

function normalizeTemplate(template) {
  return { ...EMPTY_TEMPLATE, ...template }
}

export default function FollowUpEmailTemplates({ user, toast }) {
  const [templates, setTemplates] = useState([])
  const [selectedId, setSelectedId] = useState('new')
  const [form, setForm] = useState(EMPTY_TEMPLATE)
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [dirty, setDirty] = useState(false)
  const savingRef = useRef(false)
  const editorRef = useRef(null)
  const richEditorRef = useRef(null)

  const selected = useMemo(
    () => templates.find((item) => item['Template ID'] === selectedId) || null,
    [selectedId, templates],
  )

  const [search, setSearch] = useState('')

  const load = async ({ force = false, preserveSelection = false } = {}) => {
    setLoading(true)
    try {
      const rows = await getEmailFollowUpTemplates({ force })
      setConfigured(rows !== null)
      setTemplates(rows || [])
      if (rows?.length && (!preserveSelection || selectedId === 'new')) {
        const current = preserveSelection
          ? rows.find((item) => item['Template ID'] === selectedId)
          : null
        const next = current || rows[0]
        setSelectedId(next['Template ID'])
        if (!dirty) setForm(normalizeTemplate(next))
      } else if (preserveSelection && selectedId !== 'new') {
        const current = rows?.find((item) => item['Template ID'] === selectedId)
        if (current && !dirty) setForm(normalizeTemplate(current))
      }
    } catch (error) {
      toast?.error(`Could not load follow-up templates: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => onCacheRefresh((tables) => {
    if (tables.includes('EmailFollowUpTemplatesTable')) void load({ preserveSelection: true })
  }), [selectedId, dirty])

  const choose = (template) => {
    setSelectedId(template?.['Template ID'] || 'new')
    setForm(normalizeTemplate(template || EMPTY_TEMPLATE))
    setDirty(false)
  }

  const save = async () => {
    if (savingRef.current) return
    const name = String(form['Template Name'] || '').trim()
    const subject = String(form.Subject || '').trim()
    const body = sanitizeEmailHtml(form.Body)
    const days = Number(form['Days After Submission'])
    if (!name || !subject || isEmptyEmailHtml(body) || !Number.isInteger(days) || days < 1 || days > 365) {
      toast?.error('Template name, days after submission, subject, and body are required. Days after submission must be from 1 to 365.')
      return
    }
    savingRef.current = true
    setSaving(true)
    const payload = { ...form, Body: body, 'Days After Submission': days }
    try {
      if (selected) {
        await updateEmailFollowUpTemplate(selected._rowIndex, payload, user?.displayName, selected['Template ID'])
        setTemplates((previous) => previous.map((item) =>
          item['Template ID'] === selected['Template ID'] ? { ...item, ...payload } : item
        ))
      } else {
        const created = await addEmailFollowUpTemplate(payload, user?.displayName)
        const refreshed = await getEmailFollowUpTemplates({ force: true })
        const canonical = refreshed?.find((item) => item['Template ID'] === created['Template ID']) || created
        if (refreshed) setTemplates(refreshed)
        else setTemplates((previous) => [...previous, canonical])
        setSelectedId(canonical['Template ID'])
        setForm(normalizeTemplate(canonical))
      }
      toast?.success('Follow-up template saved')
      setDirty(false)
    } catch (error) {
      toast?.error(`Could not save template: ${error.message}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  useSaveShortcut({
    enabled: configured && !loading && !saving && !deleting,
    label: 'this follow-up email template',
    onSave: save,
    scopeRef: editorRef,
  })

  const remove = async () => {
    if (!selected || deleting) return
    if (!window.confirm(`Delete "${selected['Template Name']}"? Existing drafts will not be deleted.`)) return
    setDeleting(true)
    try {
      await deleteEmailFollowUpTemplate(selected._rowIndex)
      const remaining = templates.filter((item) => item['Template ID'] !== selected['Template ID'])
      setTemplates(remaining)
      choose(remaining[0] || null)
      toast?.success('Follow-up template deleted')
    } catch (error) {
      toast?.error(`Could not delete template: ${error.message}`)
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="skeleton" style={{ height: 180 }} />

  if (!configured) {
    return (
      <div className={styles.setup}>
        <strong>Email template tables are not configured</strong>
        <p>Create <code>EmailFollowUpTemplatesTable</code> and <code>EmailFollowUpDraftsTable</code> using the headers in the setup guide. Drafting stays disabled until both tables exist.</p>
      </div>
    )
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.templateList} aria-label="Follow-up templates">
        <div className={styles.listTools}>
          <input
            className="form-input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search templates"
            aria-label="Search follow-up email templates"
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => forceRefreshCache(['EmailFollowUpTemplatesTable'])}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
        <button type="button" className={`${styles.templateItem} ${selectedId === 'new' ? styles.selected : ''}`} onClick={() => choose(null)}>
          <span>New template</span>
          <small>Create a follow-up template</small>
        </button>
        {templates
          .slice()
          .filter((template) => !search.trim() || `${template['Template Name']} ${template.Subject}`.toLowerCase().includes(search.trim().toLowerCase()))
          .sort((a, b) => Number(a['Days After Submission']) - Number(b['Days After Submission']))
          .map((template) => (
            <button
              type="button"
              key={template['Template ID']}
              className={`${styles.templateItem} ${selectedId === template['Template ID'] ? styles.selected : ''}`}
              onClick={() => choose(template)}
            >
              <span>{template['Template Name']}</span>
              <small>Day {template['Days After Submission']} · {template.Active === 'No' ? 'Inactive' : 'Active'}</small>
            </button>
          ))}
      </aside>

      <div ref={editorRef} className={styles.editor}>
        <div className={styles.editorGrid}>
          <label>
            <span>Template name</span>
            <input className="form-input" value={form['Template Name']} onChange={(event) => { setDirty(true); setForm((current) => ({ ...current, 'Template Name': event.target.value })) }} />
          </label>
          <label>
            <span>Days after submission</span>
            <input className="form-input" type="number" min="1" max="365" value={form['Days After Submission']} onChange={(event) => { setDirty(true); setForm((current) => ({ ...current, 'Days After Submission': event.target.value })) }} />
          </label>
          <label>
            <span>Status</span>
            <select className="form-input" value={form.Active} onChange={(event) => { setDirty(true); setForm((current) => ({ ...current, Active: event.target.value })) }}>
              <option value="Yes">Active</option>
              <option value="No">Inactive</option>
            </select>
          </label>
        </div>
        <label className={styles.fullField}>
          <span>Subject</span>
          <input className="form-input" value={form.Subject} onChange={(event) => { setDirty(true); setForm((current) => ({ ...current, Subject: event.target.value })) }} placeholder="Following up on {{opportunity_title}}" />
        </label>
        <div className={styles.fullField}>
          <span id="follow-up-template-body-label">Email body</span>
          <RichEmailEditor
            ref={richEditorRef}
            value={form.Body}
            onChange={(Body) => { setDirty(true); setForm((current) => ({ ...current, Body })) }}
            ariaLabel="Follow-up email template body"
            allowSignature
            highlightMergeFields
          />
        </div>
        <div className={styles.mergeFields}>
          <span>Template fields</span>
          {FOLLOW_UP_MERGE_FIELDS.map((field) => (
            <button
              type="button"
              key={field}
              title={`Insert ${field} at the cursor`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => richEditorRef.current?.insertMergeField(field)}
            >
              {field}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          {selected && <button type="button" className="btn btn-danger" onClick={remove} disabled={deleting || saving}>{deleting ? 'Deleting…' : 'Delete'}</button>}
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || deleting}>{saving ? 'Saving…' : 'Save template'}</button>
        </div>
      </div>
    </div>
  )
}
