import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addEmailFollowUpTemplate,
  deleteEmailFollowUpTemplate,
  getEmailFollowUpTemplates,
  updateEmailFollowUpTemplate,
} from '@/services/graphService'
import { FOLLOW_UP_MERGE_FIELDS } from '@/utils/followUpEmails'
import styles from './FollowUpEmailTemplates.module.css'

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
  const savingRef = useRef(false)

  const selected = useMemo(
    () => templates.find((item) => item['Template ID'] === selectedId) || null,
    [selectedId, templates],
  )

  const load = async () => {
    setLoading(true)
    try {
      const rows = await getEmailFollowUpTemplates()
      setConfigured(rows !== null)
      setTemplates(rows || [])
      if (rows?.length && selectedId === 'new') {
        setSelectedId(rows[0]['Template ID'])
        setForm(normalizeTemplate(rows[0]))
      }
    } catch (error) {
      toast?.error(`Could not load follow-up templates: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const choose = (template) => {
    setSelectedId(template?.['Template ID'] || 'new')
    setForm(normalizeTemplate(template || EMPTY_TEMPLATE))
  }

  const save = async () => {
    if (savingRef.current) return
    const name = String(form['Template Name'] || '').trim()
    const subject = String(form.Subject || '').trim()
    const body = String(form.Body || '').trim()
    const days = Number(form['Days After Submission'])
    if (!name || !subject || !body || !Number.isInteger(days) || days < 1 || days > 365) {
      toast?.error('Template name, milestone day, subject, and body are required. Milestone day must be from 1 to 365.')
      return
    }
    savingRef.current = true
    setSaving(true)
    const payload = { ...form, 'Days After Submission': days }
    try {
      if (selected) {
        await updateEmailFollowUpTemplate(selected._rowIndex, payload, user?.displayName)
        setTemplates((previous) => previous.map((item) =>
          item['Template ID'] === selected['Template ID'] ? { ...item, ...payload } : item
        ))
      } else {
        const created = await addEmailFollowUpTemplate(payload, user?.displayName)
        setTemplates((previous) => [...previous, created])
        setSelectedId(created['Template ID'])
        setForm(normalizeTemplate(created))
      }
      toast?.success('Follow-up template saved')
    } catch (error) {
      toast?.error(`Could not save template: ${error.message}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

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
        <button type="button" className={`${styles.templateItem} ${selectedId === 'new' ? styles.selected : ''}`} onClick={() => choose(null)}>
          <span>New template</span>
          <small>Create a milestone</small>
        </button>
        {templates
          .slice()
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

      <div className={styles.editor}>
        <div className={styles.editorGrid}>
          <label>
            <span>Template name</span>
            <input className="form-input" value={form['Template Name']} onChange={(event) => setForm((current) => ({ ...current, 'Template Name': event.target.value }))} />
          </label>
          <label>
            <span>Days after submission</span>
            <input className="form-input" type="number" min="1" max="365" value={form['Days After Submission']} onChange={(event) => setForm((current) => ({ ...current, 'Days After Submission': event.target.value }))} />
          </label>
          <label>
            <span>Status</span>
            <select className="form-input" value={form.Active} onChange={(event) => setForm((current) => ({ ...current, Active: event.target.value }))}>
              <option value="Yes">Active</option>
              <option value="No">Inactive</option>
            </select>
          </label>
        </div>
        <label className={styles.fullField}>
          <span>Subject</span>
          <input className="form-input" value={form.Subject} onChange={(event) => setForm((current) => ({ ...current, Subject: event.target.value }))} placeholder="Following up on {{opportunity_title}}" />
        </label>
        <label className={styles.fullField}>
          <span>Email body</span>
          <textarea className="form-input" rows="9" value={form.Body} onChange={(event) => setForm((current) => ({ ...current, Body: event.target.value }))} />
        </label>
        <div className={styles.mergeFields}>
          <span>Available fields</span>
          {FOLLOW_UP_MERGE_FIELDS.map((field) => <code key={field}>{field}</code>)}
        </div>
        <div className={styles.actions}>
          {selected && <button type="button" className="btn btn-danger" onClick={remove} disabled={deleting || saving}>{deleting ? 'Deleting…' : 'Delete'}</button>}
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || deleting}>{saving ? 'Saving…' : 'Save template'}</button>
        </div>
      </div>
    </div>
  )
}
