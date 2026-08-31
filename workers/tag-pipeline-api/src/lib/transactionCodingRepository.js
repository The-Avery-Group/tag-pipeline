import { categorizeTransaction, cleanText, publicRule, transactionStatus } from './transactionCodingDomain.js'

const RETENTION_DAYS = 60

function expiresAt(from = new Date()) {
  return new Date(from.getTime() + RETENTION_DAYS * 86_400_000).toISOString()
}

function publicBatch(row) {
  if (!row) return null
  return {
    id: row.id,
    fileName: row.file_name,
    fileHash: row.file_hash,
    importedBy: row.imported_by,
    rowCount: Number(row.row_count || 0),
    totalCents: Number(row.total_cents || 0),
    readyCount: Number(row.ready_count || 0),
    reviewCount: Number(row.review_count || 0),
    uncategorizedCount: Number(row.uncategorized_count || 0),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicTransaction(row) {
  if (!row) return null
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceRow: Number(row.source_row || 0),
    sourceHash: row.source_hash,
    transactionDate: row.transaction_date,
    rawDescription: row.raw_description,
    location: row.location,
    city: row.city,
    amountCents: Number(row.amount_cents || 0),
    direction: row.direction,
    vendor: row.vendor,
    vendorId: row.vendor_id,
    project: row.project,
    account: row.account,
    organization: row.organization,
    status: row.status,
    ruleId: row.rule_id,
    confidence: row.confidence,
    exportedAt: row.exported_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicExport(row) {
  if (!row) return null
  return {
    id: row.id,
    batchId: row.batch_id,
    fileName: row.file_name,
    rowCount: Number(row.row_count || 0),
    totalCents: Number(row.total_cents || 0),
    archived: Boolean(row.archived),
    sharePointUrl: row.sharepoint_web_url || '',
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

export async function transactionCodingStorageReady(db) {
  if (!db) return false
  const required = [
    'transaction_coding_batches',
    'transaction_coding_transactions',
    'transaction_coding_rules',
    'transaction_coding_exports',
    'transaction_coding_settings',
  ]
  const result = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => '?').join(',')})`)
    .bind(...required).all()
  const available = new Set((result.results || []).map((row) => row.name))
  return required.every((name) => available.has(name))
}

export async function saveTransactionCodingWorkspace(db, workspace) {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO transaction_coding_settings (
      id, sharepoint_drive_id, sharepoint_folder_id, sharepoint_folder_url, workbook_item_id,
      workbook_url, exports_folder_id, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sharepoint_drive_id = excluded.sharepoint_drive_id,
      sharepoint_folder_id = excluded.sharepoint_folder_id,
      sharepoint_folder_url = excluded.sharepoint_folder_url,
      workbook_item_id = excluded.workbook_item_id,
      workbook_url = excluded.workbook_url,
      exports_folder_id = excluded.exports_folder_id,
      updated_at = excluded.updated_at`)
    .bind(workspace.driveId, workspace.folderId, workspace.folderUrl, workspace.workbookItemId, workspace.workbookUrl, workspace.exportsFolderId, now).run()
}

export async function replaceTransactionCodingRules(db, workbookRules, actor = '') {
  const now = new Date().toISOString()
  const rules = workbookRules.map(publicRule).filter((rule) => rule.id && rule.matchPattern)
  const statements = [db.prepare("DELETE FROM transaction_coding_rules WHERE source = 'workbook'")]
  rules.forEach((rule) => statements.push(db.prepare(`INSERT INTO transaction_coding_rules (
      id, active, priority, match_type, match_pattern, vendor, vendor_id, project, account,
      organization, context, notes, source, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'workbook', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET active=excluded.active, priority=excluded.priority, match_type=excluded.match_type,
      match_pattern=excluded.match_pattern, vendor=excluded.vendor, vendor_id=excluded.vendor_id,
      project=excluded.project, account=excluded.account,
      organization=excluded.organization, context=excluded.context, notes=excluded.notes,
      source='workbook', updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(rule.id, rule.active ? 1 : 0, rule.priority, rule.matchType, rule.matchPattern, rule.vendor,
      rule.vendorId, rule.project, rule.account, rule.organization, rule.context, rule.notes,
      rule.updatedBy || actor, rule.updatedAt || now, rule.updatedAt || now)))
  statements.push(db.prepare('UPDATE transaction_coding_settings SET rules_synced_at = ?, updated_at = ? WHERE id = 1').bind(now, now))
  for (let offset = 0; offset < statements.length; offset += 50) await db.batch(statements.slice(offset, offset + 50))
  return rules
}

export async function listTransactionCodingRules(db) {
  const result = await db.prepare('SELECT * FROM transaction_coding_rules ORDER BY active DESC, priority DESC, match_pattern').all()
  return (result.results || []).map(publicRule)
}

export async function recategorizeOpenTransactions(db) {
  const rules = await listTransactionCodingRules(db)
  const result = await db.prepare("SELECT * FROM transaction_coding_transactions WHERE exported_at IS NULL AND confidence != 'reviewed'").all()
  const rows = result.results || []
  const batchIds = new Set()
  for (let offset = 0; offset < rows.length; offset += 50) {
    const statements = rows.slice(offset, offset + 50).map((row) => {
      batchIds.add(row.batch_id)
      const categorized = categorizeTransaction({
        ...publicTransaction(row),
        vendor: '',
        vendorId: '',
        project: '',
        account: '',
        organization: '',
        ruleId: null,
        confidence: 'none',
      }, rules)
      if (!categorized.ruleId) categorized.status = transactionStatus(categorized)
      return db.prepare(`UPDATE transaction_coding_transactions SET vendor=?, vendor_id=?, project=?, account=?, organization=?, status=?, rule_id=?, confidence=?, updated_at=? WHERE id=?`)
        .bind(categorized.vendor || '', categorized.vendorId || '', categorized.project || '', categorized.account || '', categorized.organization || '', categorized.status, categorized.ruleId, categorized.confidence, new Date().toISOString(), row.id)
    })
    if (statements.length) await db.batch(statements)
  }
  for (const batchId of batchIds) await refreshBatchCounts(db, batchId)
  return rows.length
}

export async function upsertTransactionCodingRule(db, input, actor = '') {
  const now = new Date().toISOString()
  const rule = publicRule({ ...input, id: cleanText(input.id) || crypto.randomUUID(), updatedAt: now, updatedBy: actor })
  if (!rule.matchPattern) throw new Error('A match pattern is required')
  const source = rule.source === 'crm_pending' ? 'crm_pending' : 'workbook'
  await db.prepare(`INSERT INTO transaction_coding_rules (
      id, active, priority, match_type, match_pattern, vendor, vendor_id, project, account,
      organization, context, notes, source, updated_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET active=excluded.active, priority=excluded.priority, match_type=excluded.match_type,
      match_pattern=excluded.match_pattern, vendor=excluded.vendor, vendor_id=excluded.vendor_id,
      project=excluded.project, account=excluded.account,
      organization=excluded.organization, context=excluded.context, notes=excluded.notes,
      source=excluded.source, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(rule.id, rule.active ? 1 : 0, rule.priority, rule.matchType, rule.matchPattern, rule.vendor,
      rule.vendorId, rule.project, rule.account, rule.organization, rule.context, rule.notes, source, actor, now, now).run()
  return { ...rule, source }
}

export async function deleteTransactionCodingRule(db, id) {
  const ruleId = cleanText(id)
  if (!ruleId) return false
  const result = await db.prepare('DELETE FROM transaction_coding_rules WHERE id = ?').bind(ruleId).run()
  return Number(result?.meta?.changes || 0) > 0
}

async function refreshBatchCounts(db, batchId) {
  const counts = await db.prepare(`SELECT COUNT(*) AS row_count, COALESCE(SUM(amount_cents), 0) AS total_cents,
      SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END) AS ready_count,
      SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review_count,
      SUM(CASE WHEN status='uncategorized' THEN 1 ELSE 0 END) AS uncategorized_count
    FROM transaction_coding_transactions WHERE batch_id = ?`).bind(batchId).first()
  const now = new Date().toISOString()
  await db.prepare(`UPDATE transaction_coding_batches SET row_count=?, total_cents=?, ready_count=?, review_count=?, uncategorized_count=?, updated_at=? WHERE id=?`)
    .bind(Number(counts?.row_count || 0), Number(counts?.total_cents || 0), Number(counts?.ready_count || 0), Number(counts?.review_count || 0), Number(counts?.uncategorized_count || 0), now, batchId).run()
  return getTransactionCodingBatch(db, batchId)
}

export async function getTransactionCodingBatch(db, batchId) {
  return publicBatch(await db.prepare('SELECT * FROM transaction_coding_batches WHERE id = ?').bind(batchId).first())
}

export async function importTransactionBatch(db, input, actor = '') {
  const fileHash = cleanText(input.fileHash)
  if (!fileHash) throw new Error('The statement fingerprint is missing')
  const existing = await db.prepare(`SELECT batch.*, COUNT(txn.id) AS persisted_rows
      FROM transaction_coding_batches batch
      LEFT JOIN transaction_coding_transactions txn ON txn.batch_id = batch.id
      WHERE batch.file_hash = ?
      GROUP BY batch.id`).bind(fileHash).first()
  if (existing && Number(existing.persisted_rows || 0) > 0) return { duplicate: true, batch: publicBatch(existing) }
  if (existing) {
    // A previous interrupted import may have created the batch before any rows
    // were committed. Remove that shell so a retry can complete normally.
    await db.prepare('DELETE FROM transaction_coding_batches WHERE id = ?').bind(existing.id).run()
  }
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const rules = await listTransactionCodingRules(db)
  const sourceHashes = new Set()
  const rows = (Array.isArray(input.rows) ? input.rows : []).slice(0, 5000).map((source, index) => {
    const sourceHash = cleanText(source.sourceHash)
    if (!sourceHash || sourceHashes.has(sourceHash)) return null
    sourceHashes.add(sourceHash)
    return categorizeTransaction({
      id: crypto.randomUUID(),
      batchId: id,
      sourceRow: Number(source.sourceRow || index + 2),
      sourceHash,
      transactionDate: cleanText(source.transactionDate),
      rawDescription: cleanText(source.rawDescription),
      location: cleanText(source.location),
      city: cleanText(source.city),
      amountCents: Math.round(Number(source.amountCents || 0)),
      direction: source.direction === 'credit' ? 'credit' : 'charge',
    }, rules)
  }).filter((row) => row && row.rawDescription && row.amountCents !== 0)
  if (!rows.length) throw new Error('The statement contains no non-zero transaction rows after normalization')

  try {
    await db.prepare(`INSERT INTO transaction_coding_batches (id, file_name, file_hash, imported_by, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, cleanText(input.fileName) || 'Statement', fileHash, actor, expiresAt(), now, now).run()
    for (let offset = 0; offset < rows.length; offset += 100) {
      await db.batch(rows.slice(offset, offset + 100).map((row) => db.prepare(`INSERT OR IGNORE INTO transaction_coding_transactions (
        id, batch_id, source_row, source_hash, transaction_date, raw_description, location, city,
        amount_cents, direction, vendor, vendor_id, project, account, organization, status, rule_id, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(row.id, id, row.sourceRow, row.sourceHash, row.transactionDate, row.rawDescription,
          row.location, row.city, row.amountCents, row.direction, row.vendor || '', row.vendorId || '', row.project || '',
          row.account || '', row.organization || '', row.status, row.ruleId, row.confidence, now, now)))
    }
    return { duplicate: false, batch: await refreshBatchCounts(db, id) }
  } catch (error) {
    try {
      await db.prepare('DELETE FROM transaction_coding_transactions WHERE batch_id = ?').bind(id).run()
      await db.prepare('DELETE FROM transaction_coding_batches WHERE id = ?').bind(id).run()
    } catch (cleanupError) {
      console.error(JSON.stringify({ event: 'transaction_coding_import_cleanup_failed', batchId: id, message: cleanupError.message }))
    }
    throw error
  }
}

export async function listTransactionCodingBatches(db) {
  const result = await db.prepare('SELECT * FROM transaction_coding_batches ORDER BY created_at DESC LIMIT 50').all()
  return (result.results || []).map(publicBatch)
}

export async function listTransactionCodingTransactions(db, { batchId = '', status = '', search = '' } = {}) {
  const conditions = []
  const bindings = []
  if (batchId) { conditions.push('batch_id = ?'); bindings.push(batchId) }
  if (status) { conditions.push('status = ?'); bindings.push(status) }
  if (search) {
    conditions.push('(raw_description LIKE ? OR vendor LIKE ? OR project LIKE ? OR account LIKE ? OR organization LIKE ?)')
    const term = `%${search}%`
    bindings.push(term, term, term, term, term)
  }
  const result = await db.prepare(`SELECT * FROM transaction_coding_transactions ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY transaction_date DESC, source_row DESC LIMIT 5000`).bind(...bindings).all()
  return (result.results || []).map(publicTransaction)
}

export async function updateTransactionCodingTransaction(db, id, patch) {
  const current = await db.prepare('SELECT * FROM transaction_coding_transactions WHERE id = ?').bind(id).first()
  if (!current) return null
  const next = {
    vendor: cleanText(patch.vendor ?? current.vendor),
    vendorId: cleanText(patch.vendorId ?? current.vendor_id),
    project: cleanText(patch.project ?? current.project),
    account: cleanText(patch.account ?? current.account),
    organization: cleanText(patch.organization ?? current.organization),
  }
  const status = transactionStatus(next)
  const now = new Date().toISOString()
  await db.prepare(`UPDATE transaction_coding_transactions SET vendor=?, vendor_id=?, project=?, account=?, organization=?, status=?, confidence=?, updated_at=? WHERE id=?`)
    .bind(next.vendor, next.vendorId, next.project, next.account, next.organization, status, 'reviewed', now, id).run()
  await refreshBatchCounts(db, current.batch_id)
  return publicTransaction(await db.prepare('SELECT * FROM transaction_coding_transactions WHERE id = ?').bind(id).first())
}

export async function createTransactionCodingExport(db, { batchId, transactionIds, csvText, fileName, archivedItem = null }, actor = '') {
  const selected = await transactionsForExport(db, batchId, transactionIds)
  if (!selected.length) throw new Error('There are no selected transactions available to export')
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const expiry = expiresAt()
  const total = selected.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0)
  // Export state is independent from coding state. Ready and deliberately
  // selected incomplete rows keep their coding status; exported_at keeps each
  // row out of later exports from the same batch.
  const statements = selected.map((row) => db.prepare('UPDATE transaction_coding_transactions SET exported_at=?, updated_at=? WHERE id=?').bind(now, now, row.id))
  statements.push(db.prepare(`INSERT INTO transaction_coding_exports (
      id, batch_id, file_name, row_count, total_cents, csv_text, archived, sharepoint_drive_id,
      sharepoint_item_id, sharepoint_web_url, created_by, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, batchId, fileName, selected.length, total, csvText, archivedItem ? 1 : 0, archivedItem?.driveId || null,
      archivedItem?.id || null, archivedItem?.webUrl || null, actor, expiry, now))
  await db.batch(statements)
  await refreshBatchCounts(db, batchId)
  return publicExport(await db.prepare('SELECT * FROM transaction_coding_exports WHERE id=?').bind(id).first())
}

export async function transactionsForExport(db, batchId, transactionIds = null) {
  const result = await db.prepare('SELECT * FROM transaction_coding_transactions WHERE batch_id = ? AND exported_at IS NULL ORDER BY transaction_date, source_row').bind(batchId).all()
  const available = result.results || []
  if (!Array.isArray(transactionIds)) return available.filter((row) => row.status === 'ready')
  const requested = [...new Set(transactionIds.map(cleanText).filter(Boolean))]
  if (!requested.length) return []
  const requestedIds = new Set(requested)
  const selected = available.filter((row) => requestedIds.has(row.id))
  if (selected.length !== requested.length) throw new Error('One or more selected transactions changed or were already exported. Refresh the transactions and try again.')
  return selected
}

export async function listTransactionCodingExports(db) {
  const result = await db.prepare('SELECT * FROM transaction_coding_exports ORDER BY created_at DESC LIMIT 100').all()
  return (result.results || []).map(publicExport)
}

export async function listTransactionCodingExportCsv(db) {
  const result = await db.prepare('SELECT csv_text FROM transaction_coding_exports WHERE expires_at > ? ORDER BY created_at')
    .bind(new Date().toISOString()).all()
  return (result.results || []).map((row) => row.csv_text || '')
}

export async function getTransactionCodingExport(db, exportId) {
  const row = await db.prepare('SELECT * FROM transaction_coding_exports WHERE id = ?').bind(exportId).first()
  return row ? { ...publicExport(row), csv: row.csv_text } : null
}

export async function purgeExpiredTransactionCodingData(db) {
  const now = new Date().toISOString()
  const exportsResult = await db.prepare('DELETE FROM transaction_coding_exports WHERE expires_at <= ?').bind(now).run()
  const batchResult = await db.prepare('DELETE FROM transaction_coding_batches WHERE expires_at <= ?').bind(now).run()
  return {
    exports: Number(exportsResult?.meta?.changes || 0),
    batches: Number(batchResult?.meta?.changes || 0),
  }
}
