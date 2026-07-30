import Modal from '@/components/Common/Modal'

export function RfiActivityPhaseModal({ pendingSave, activityPhaseColumn, onClose, onSave }) {
  if (!pendingSave) return null
  return <Modal
    title="Update activity phase?"
    onClose={onClose}
    footer={<>
      <button className="btn" onClick={() => onSave(pendingSave)}>Not now</button>
      <button className="btn btn-primary" onClick={() => onSave({ ...pendingSave, [activityPhaseColumn]: 'Submitted RFI' })}>Set to Submitted RFI</button>
    </>}
  >
    <p className="text-sm">An RFI submission date was added. Update this opportunity's Activity Phase to Submitted RFI?</p>
  </Modal>
}

export function OpportunityRenameModal({ pendingSave, preview, opportunity, columns, saving, progress, onClose, onConfirm }) {
  if (!pendingSave || !preview) return null
  return <Modal
    title="Confirm title or identifier change"
    onClose={() => !saving && onClose()}
    footer={<>
      <button className="btn" disabled={saving} onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" onClick={onConfirm} disabled={saving}>{saving ? (progress || 'Saving…') : 'Confirm and update linked records'}</button>
    </>}
  >
    <p className="text-sm" style={{ marginTop: 0 }}>This change updates the opportunity and its structured links across the pipeline.</p>
    <ul className="text-sm" style={{ margin: '10px 0', paddingLeft: 20, lineHeight: 1.7 }}>
      {preview.identifierChanged && <li>Identifier: <strong>{opportunity[columns.contractNumber]}</strong> to <strong>{pendingSave[columns.contractNumber]}</strong></li>}
      {preview.titleChanged && <li>Title: <strong>{opportunity[columns.title]}</strong> to <strong>{pendingSave[columns.title]}</strong></li>}
      <li>{preview.taskCount} linked task{preview.taskCount === 1 ? '' : 's'} will be updated</li>
      <li>{preview.noteCount} linked note{preview.noteCount === 1 ? '' : 's'} will be updated</li>
      <li>{preview.relationshipCount} related-opportunity link{preview.relationshipCount === 1 ? '' : 's'} will be updated</li>
      {preview.emailDraftCount > 0 && <li>{preview.emailDraftCount} RFI follow-up email draft{preview.emailDraftCount === 1 ? '' : 's'} will be updated</li>}
    </ul>
    <p className="text-sm text-muted" style={{ marginBottom: 0 }}>Free-text task descriptions and notes, contacts, and Expiring Contract Number will not be changed. If a linked write fails, completed linked changes are rolled back where possible and you will be told to review the affected records.</p>
    {saving && progress && <p className="text-sm" style={{ marginBottom: 0 }}>{progress}</p>}
  </Modal>
}
