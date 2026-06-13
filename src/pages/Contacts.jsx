import { useState, useMemo, useCallback } from 'react'
import { useContacts } from '@/hooks/useContacts'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { CONTACT_TYPES } from '@/services/graphService'
import styles from './Contacts.module.css'

const BLANK = { Name: '', Title: '', Agency: '', Organization: '', Email: '', Phone: '', Notes: '', Type: 'Customer' }

export default function Contacts({ toast }) {
  const { contacts, loading, add, update, remove } = useContacts()
  const { lists } = useValidationLists()
  const contactTypeOptions = pickList(lists, 'Types', CONTACT_TYPES)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)

  // Fix: use a stable setter that doesn't re-create the object on every keystroke
  const setField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  const filtered = useMemo(
    () => contacts.filter(
      (c) =>
        !search ||
        [c.Name, c.Agency, c.Organization, c.Title, c.Email, c.Type].some((v) =>
          v?.toLowerCase().includes(search.toLowerCase())
        )
    ),
    [contacts, search]
  )

  const submitAdd = async () => {
    setSaving(true)
    try {
      await add(form)
      toast?.success('Contact added')
      setShowAdd(false)
      setForm(BLANK)
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const submitUpdate = async () => {
    setSaving(true)
    try {
      await update(editing._rowIndex, form)
      toast?.success('Contact updated')
      setEditing(null)
      setForm(BLANK)
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (c) => {
    setEditing(c)
    setForm({ ...BLANK, ...c })
  }

  const handleDelete = async () => {
    try {
      await remove(confirmDelete._rowIndex)
      toast?.success('Contact deleted')
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setConfirmDelete(null)
    }
  }

  // ContactForm is rendered inline (not as a nested component) to avoid
  // the re-mount on every keystroke that caused the one-char input bug
  const renderContactForm = () => (
    <div className={styles.formGrid}>
      {[
        ['Name',         'Name',                    true],
        ['Agency',       'Agency / Company (Account)', false],
        ['Title',        'Title',                   false],
        ['Organization', 'Department / Organization',false],
        ['Email',        'Email',                   false],
        ['Phone',        'Phone',                   false],
      ].map(([field, label, required]) => (
        <div className="form-field" key={field}>
          <label className="form-label">{label}{required && ' *'}</label>
          <input
            className="form-input"
            required={required}
            value={form[field] ?? ''}
            onChange={(e) => setField(field, e.target.value)}
          />
        </div>
      ))}
      <div className="form-field">
        <label className="form-label">Type</label>
        <select
          className="form-input"
          value={form.Type ?? 'Customer'}
          onChange={(e) => setField('Type', e.target.value)}
        >
          {contactTypeOptions.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <div className="form-field" style={{ gridColumn: '1 / -1' }}>
        <label className="form-label">Notes / linked contract #</label>
        <textarea
          className="form-input"
          rows={2}
          value={form.Notes ?? ''}
          onChange={(e) => setField('Notes', e.target.value)}
        />
      </div>
    </div>
  )

  return (
    <>
      <Topbar
        title="Contacts"
        subtitle1={`${contacts.length} contacts`}
        showFilter={false}
        showNew={true}
        newLabel="New contact"
        onNew={() => { setForm(BLANK); setShowAdd(true) }}
      />
      <div className="page-body">
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className={styles.searchBar}>
            <input
              className={styles.searchInput}
              placeholder="Search contacts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span className="text-xs text-muted">{filtered.length} contacts</span>
          </div>

          {loading
            ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 200 }} /></div>
            : filtered.length === 0
              ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--gray-400)', fontSize: 13 }}>
                  {search ? 'No contacts match your search.' : 'No contacts yet. Add your first contact.'}
                </div>
              : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Agency / Company</th>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Dept / Organization</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th>Notes</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.ContactID} onClick={() => openEdit(c)}>
                        <td>
                          <div className={styles.nameCell}>
                            <div className={styles.avatar}>{c.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}</div>
                            <span style={{ fontWeight: 500 }}>{c.Name}</span>
                          </div>
                        </td>
                        <td className="text-sm">{c.Agency}</td>
                        <td className="text-sm text-muted">{c.Title}</td>
                        <td>
                          {c.Type && <span className="badge badge-tracking">{c.Type}</span>}
                        </td>
                        <td className="text-sm">{c.Organization}</td>
                        <td><a href={`mailto:${c.Email}`} onClick={(e) => e.stopPropagation()} className="text-sm">{c.Email}</a></td>
                        <td className="text-sm text-muted">{c.Phone}</td>
                        <td className="text-sm text-muted" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.Notes}</td>
                        <td>
                          <button
                            className="btn btn-ghost btn-icon"
                            aria-label="Delete contact"
                            title="Delete"
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(c) }}
                          >✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
        </div>
      </div>

      {showAdd && (
        <Modal
          title="New contact"
          onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitAdd} disabled={saving}>
                {saving ? 'Saving…' : 'Add contact'}
              </button>
            </>
          }
        >
          {renderContactForm()}
        </Modal>
      )}

      {editing && (
        <Modal
          title="Edit contact"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitUpdate} disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </>
          }
        >
          {renderContactForm()}
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="Delete contact"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
            </>
          }
        >
          <p className="text-sm">Delete <strong>{confirmDelete.Name}</strong>? This cannot be undone.</p>
        </Modal>
      )}
    </>
  )
}
