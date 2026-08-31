import {
  createTransactionCodingExport,
  deleteTransactionCodingRule,
  getTransactionCodingExport,
  importTransactionBatch,
  listTransactionCodingBatches,
  listTransactionCodingExports,
  listTransactionCodingExportCsv,
  listTransactionCodingRules,
  listTransactionCodingTransactions,
  transactionsForExport,
  recategorizeOpenTransactions,
  replaceTransactionCodingRules,
  saveTransactionCodingWorkspace,
  transactionCodingStorageReady,
  updateTransactionCodingTransaction,
  upsertTransactionCodingRule,
} from '../lib/transactionCodingRepository.js'
import { buildCostpointApVoucherCsv, cleanText, invoiceReferenceSequenceState, ruleWorkbookRow } from '../lib/transactionCodingDomain.js'
import {
  appendTransactionExportHistory,
  deleteTransactionRuleFromWorkbook,
  ensureTransactionCodingWorkspace,
  readTransactionRules,
  saveExportToSharePoint,
  saveTransactionRuleToWorkbook,
} from '../lib/transactionCodingSharePoint.js'

export const TRANSACTION_CODING_HTTP_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'DELETE'])

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function safeFilePart(value) {
  return String(value || 'transactions').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'transactions'
}

function delegatedGraphToken(req) {
  const authorization = req.headers.get('Authorization') || ''
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || ''
}

function accessEntries(env) {
  return new Set(String(env.TRANSACTION_CODING_ALLOWED_USERS || '')
    .split(/[\n,;]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))
}

export function transactionCodingAccess(identity, env) {
  const allowedUsers = accessEntries(env)
  const candidates = [identity?.userId, identity?.email]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  return {
    configured: allowedUsers.size > 0,
    allowed: candidates.some((candidate) => allowedUsers.has(candidate)),
  }
}

async function provision(env, graphToken = '') {
  const workspace = await ensureTransactionCodingWorkspace(env, graphToken)
  await saveTransactionCodingWorkspace(env.EBUY_DB, workspace)
  return workspace
}

async function syncRules(env, identity, graphToken = '', { recategorize = true } = {}) {
  const workspace = await provision(env, graphToken)
  const workbookRules = await readTransactionRules(workspace)
  await replaceTransactionCodingRules(env.EBUY_DB, workbookRules, identity?.name || '')
  const pendingRules = (await listTransactionCodingRules(env.EBUY_DB)).filter((rule) => rule.source === 'crm_pending')
  for (const pendingRule of pendingRules) {
    await saveTransactionRuleToWorkbook(workspace, ruleWorkbookRow(pendingRule, identity?.name || ''))
    await upsertTransactionCodingRule(env.EBUY_DB, { ...pendingRule, source: 'workbook' }, identity?.name || '')
  }
  const rules = await listTransactionCodingRules(env.EBUY_DB)
  if (recategorize) await recategorizeOpenTransactions(env.EBUY_DB)
  return { workspace, rules }
}

export async function attemptTransactionRuleSync(operation) {
  try {
    await operation()
    return ''
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'transaction_coding_rule_sync_failed',
      stage: 'before_import',
      message: error.message,
    }))
    return 'The statement was imported using the last saved categorization rules because the SharePoint rules could not refresh.'
  }
}

async function syncRulesBeforeImport(env, identity, graphToken) {
  return attemptTransactionRuleSync(() => syncRules(env, identity, graphToken, { recategorize: false }))
}

export async function handleTransactionCoding(req, env, identity) {
  const url = new URL(req.url)
  const path = url.pathname
  const access = transactionCodingAccess(identity, env)
  if (path === '/transaction-coding/access' && req.method === 'GET') {
    return json(access)
  }
  if (!access.allowed) {
    return json({
      error: access.configured
        ? 'You do not have access to Transaction Coding.'
        : 'Transaction Coding access has not been configured.',
      code: access.configured ? 'transaction_coding_forbidden' : 'transaction_coding_access_not_configured',
    }, 403)
  }
  if (!env.EBUY_DB || !(await transactionCodingStorageReady(env.EBUY_DB))) {
    return json({ error: 'Apply the latest D1 migration to enable Transaction Coding.', code: 'migration_required' }, 503)
  }
  const actor = identity?.name || identity?.userId || ''
  const graphToken = delegatedGraphToken(req)

  if (path === '/transaction-coding/status' && req.method === 'GET') {
    try {
      const workspace = await provision(env, graphToken)
      return json({ ready: true, retentionDays: 60, workspace: {
        folderUrl: workspace.folderUrl,
        workbookUrl: workspace.workbookUrl,
      } })
    } catch (error) {
      return json({ ready: false, retentionDays: 60, error: error.message }, 502)
    }
  }

  if (path === '/transaction-coding/provision' && req.method === 'POST') {
    const workspace = await provision(env, graphToken)
    return json({ ok: true, workspace: { folderUrl: workspace.folderUrl, workbookUrl: workspace.workbookUrl } })
  }

  if (path === '/transaction-coding/batches' && req.method === 'GET') {
    return json({ batches: await listTransactionCodingBatches(env.EBUY_DB) })
  }

  if (path === '/transaction-coding/imports' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    if (!Array.isArray(body.rows) || !body.rows.length) return json({ error: 'The statement contains no importable transaction rows.' }, 400)
    const warning = await syncRulesBeforeImport(env, identity, graphToken)
    try {
      const result = await importTransactionBatch(env.EBUY_DB, body, actor)
      return json({ ok: true, ...result, warning }, result.duplicate ? 200 : 201)
    } catch (error) {
      console.error(JSON.stringify({
        event: 'transaction_coding_import_failed',
        fileName: String(body.fileName || '').slice(0, 160),
        rowCount: body.rows.length,
        message: error.message,
      }))
      return json({
        error: 'The statement could not be imported. No partial import was kept.',
        detail: error.message,
        code: 'transaction_import_failed',
      }, 500)
    }
  }

  if (path === '/transaction-coding/transactions' && req.method === 'GET') {
    const transactions = await listTransactionCodingTransactions(env.EBUY_DB, {
      batchId: url.searchParams.get('batchId') || '',
      status: url.searchParams.get('status') || '',
      search: url.searchParams.get('search') || '',
    })
    return json({ transactions })
  }

  const transactionMatch = path.match(/^\/transaction-coding\/transactions\/([^/]+)$/)
  if (transactionMatch && req.method === 'PATCH') {
    const body = await req.json().catch(() => ({}))
    const transaction = await updateTransactionCodingTransaction(env.EBUY_DB, decodeURIComponent(transactionMatch[1]), body)
    if (!transaction) return json({ error: 'Transaction not found.' }, 404)
    let rule = null
    let ruleWarning = ''
    if (body.rememberRule) {
      const ruleInput = {
        id: body.ruleId || transaction.ruleId || `rule-${transaction.id}`,
        active: true,
        priority: body.rulePriority || 100,
        matchType: body.ruleMatchType || 'contains',
        matchPattern: body.rulePattern || transaction.rawDescription,
        vendor: transaction.vendor,
        vendorId: transaction.vendorId,
        project: transaction.project,
        account: transaction.account,
        organization: transaction.organization,
        notes: `Learned from transaction ${transaction.id}`,
      }
      try {
        rule = await upsertTransactionCodingRule(env.EBUY_DB, { ...ruleInput, source: 'crm_pending' }, actor)
        const workspace = await provision(env, graphToken)
        await saveTransactionRuleToWorkbook(workspace, ruleWorkbookRow(ruleInput, actor))
        rule = await upsertTransactionCodingRule(env.EBUY_DB, { ...ruleInput, source: 'workbook' }, actor)
      } catch (error) {
        ruleWarning = rule
          ? `Transaction and rule saved in the CRM, but SharePoint synchronization is pending: ${error.message}`
          : `Transaction saved, but the rule could not be saved: ${error.message}`
      }
    }
    return json({ ok: true, transaction, rule, warning: ruleWarning })
  }

  if (path === '/transaction-coding/rules' && req.method === 'GET') {
    if (url.searchParams.get('refresh') === '1') await syncRules(env, identity, graphToken)
    return json({ rules: await listTransactionCodingRules(env.EBUY_DB) })
  }

  if (path === '/transaction-coding/rules' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const ruleInput = { ...body, id: cleanText(body.id) || crypto.randomUUID() }
    try {
      let rule = await upsertTransactionCodingRule(env.EBUY_DB, { ...ruleInput, source: 'crm_pending' }, actor)
      let warning = ''
      try {
        const workspace = await provision(env, graphToken)
        await saveTransactionRuleToWorkbook(workspace, ruleWorkbookRow(ruleInput, actor))
        rule = await upsertTransactionCodingRule(env.EBUY_DB, { ...ruleInput, source: 'workbook' }, actor)
      } catch (syncError) {
        warning = `Rule saved in the CRM, but SharePoint synchronization is pending: ${syncError.message}`
        console.warn(JSON.stringify({ event: 'transaction_coding_rule_workbook_sync_pending', ruleId: ruleInput.id, message: syncError.message }))
      }
      await recategorizeOpenTransactions(env.EBUY_DB)
      return json({ ok: true, rule, warning }, 201)
    } catch (error) {
      console.error(JSON.stringify({ event: 'transaction_coding_rule_save_failed', ruleId: ruleInput.id, message: error.message }))
      return json({
        error: `The categorization rule could not be saved: ${error.message}`,
        code: 'transaction_rule_save_failed',
      }, 502)
    }
  }


  const ruleMatch = path.match(/^\/transaction-coding\/rules\/([^/]+)$/)
  if (ruleMatch && req.method === 'PATCH') {
    const ruleId = decodeURIComponent(ruleMatch[1])
    const body = await req.json().catch(() => ({}))
    try {
      const ruleInput = { ...body, id: ruleId }
      let rule = await upsertTransactionCodingRule(env.EBUY_DB, { ...ruleInput, source: 'crm_pending' }, actor)
      let warning = ''
      try {
        const workspace = await provision(env, graphToken)
        await saveTransactionRuleToWorkbook(workspace, ruleWorkbookRow(ruleInput, actor))
        rule = await upsertTransactionCodingRule(env.EBUY_DB, { ...ruleInput, source: 'workbook' }, actor)
      } catch (syncError) {
        warning = `Rule updated in the CRM, but SharePoint synchronization is pending: ${syncError.message}`
        console.warn(JSON.stringify({ event: 'transaction_coding_rule_workbook_sync_pending', ruleId, message: syncError.message }))
      }
      await recategorizeOpenTransactions(env.EBUY_DB)
      return json({ ok: true, rule, warning })
    } catch (error) {
      console.error(JSON.stringify({ event: 'transaction_coding_rule_update_failed', ruleId, message: error.message }))
      return json({
        error: `The categorization rule could not be updated: ${error.message}`,
        code: 'transaction_rule_update_failed',
      }, 502)
    }
  }

  if (ruleMatch && req.method === 'DELETE') {
    const ruleId = decodeURIComponent(ruleMatch[1])
    try {
      const deleted = await deleteTransactionCodingRule(env.EBUY_DB, ruleId)
      let warning = ''
      try {
        const workspace = await provision(env, graphToken)
        await deleteTransactionRuleFromWorkbook(workspace, ruleId)
      } catch (syncError) {
        warning = `Rule deleted from the CRM, but SharePoint cleanup is pending: ${syncError.message}`
        console.warn(JSON.stringify({ event: 'transaction_coding_rule_workbook_delete_pending', ruleId, message: syncError.message }))
      }
      await recategorizeOpenTransactions(env.EBUY_DB)
      return json({ ok: true, deleted, warning })
    } catch (error) {
      console.error(JSON.stringify({ event: 'transaction_coding_rule_delete_failed', ruleId, message: error.message }))
      return json({
        error: `The categorization rule could not be deleted: ${error.message}`,
        code: 'transaction_rule_delete_failed',
      }, 502)
    }
  }

  if (path === '/transaction-coding/exports' && req.method === 'GET') {
    return json({ exports: await listTransactionCodingExports(env.EBUY_DB) })
  }

  if (path === '/transaction-coding/invoice-reference-sequences' && req.method === 'GET') {
    const state = invoiceReferenceSequenceState(await listTransactionCodingExportCsv(env.EBUY_DB))
    return json({ nextByMonth: state.nextByMonth })
  }

  if (path === '/transaction-coding/exports' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const batchId = String(body.batchId || '').trim()
    if (!batchId) return json({ error: 'Select an import batch first.' }, 400)
    const transactionIds = Array.isArray(body.transactionIds)
      ? [...new Set(body.transactionIds.map(cleanText).filter(Boolean))].slice(0, 5000)
      : null
    if (Array.isArray(transactionIds) && !transactionIds.length) return json({ error: 'Select at least one transaction to export.' }, 400)
    let rows
    try {
      rows = await transactionsForExport(env.EBUY_DB, batchId, transactionIds)
    } catch (error) {
      return json({ error: error.message, code: 'transaction_selection_changed' }, 409)
    }
    if (!rows.length) return json({ error: 'There are no selected transactions available to export.' }, 409)
    let costpointExport
    try {
      costpointExport = buildCostpointApVoucherCsv(rows, {
        invoiceReferenceMode: body.invoiceReferenceMode,
        invoiceReferencePattern: body.invoiceReferencePattern,
        invoiceReferences: body.invoiceReferences,
        inputVoucherNumbers: body.inputVoucherNumbers,
      })
    } catch (error) {
      return json({ error: error.message, code: 'invalid_costpoint_export' }, 400)
    }
    if (body.invoiceSequenceScope === 'monthly') {
      const previous = invoiceReferenceSequenceState(await listTransactionCodingExportCsv(env.EBUY_DB))
      const used = new Set(previous.references.map((reference) => reference.toLowerCase()))
      const duplicate = Object.values(costpointExport.invoiceReferences).find((reference) => used.has(String(reference).toLowerCase()))
      if (duplicate) {
        return json({ error: `Invoice reference “${duplicate}” was already generated in an earlier export. Choose a later starting sequence.`, code: 'invoice_reference_already_used' }, 409)
      }
    }
    const { csv, invoiceReferences, inputVoucherNumbers } = costpointExport
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fileName = `${safeFilePart(body.fileName || 'Costpoint-AP-Vouchers')}-${timestamp}.csv`
    let workspace = null
    let archivedItem = null
    let warning = ''
    if (body.archive !== false) {
      try {
        workspace = await provision(env, graphToken)
        const item = await saveExportToSharePoint(workspace, fileName, csv)
        archivedItem = { ...item, driveId: workspace.driveId }
      } catch (error) {
        warning = `CSV generated, but SharePoint archiving failed: ${error.message}`
      }
    }
    const exported = await createTransactionCodingExport(env.EBUY_DB, { batchId, transactionIds: rows.map((row) => row.id), csvText: csv, fileName, archivedItem }, actor)
    if (workspace) {
      try {
        await appendTransactionExportHistory(workspace, [
          exported.id, exported.batchId, exported.fileName, exported.rowCount,
          (exported.totalCents / 100).toFixed(2), exported.sharePointUrl, actor,
          exported.createdAt, exported.expiresAt,
        ])
      } catch (error) {
        console.warn(JSON.stringify({ event: 'transaction_export_history_write_failed', exportId: exported.id, message: error.message }))
      }
    }
    return json({ ok: true, export: exported, csv, invoiceReferences, inputVoucherNumbers, warning }, 201)
  }

  const exportMatch = path.match(/^\/transaction-coding\/exports\/([^/]+)$/)
  if (exportMatch && req.method === 'GET') {
    const exported = await getTransactionCodingExport(env.EBUY_DB, decodeURIComponent(exportMatch[1]))
    return exported ? json({ export: exported }) : json({ error: 'Export not found.' }, 404)
  }

  return json({ error: 'Not found' }, 404)
}
