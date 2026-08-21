import {
  createTransactionCodingExport,
  getTransactionCodingExport,
  importTransactionBatch,
  listTransactionCodingBatches,
  listTransactionCodingExports,
  listTransactionCodingRules,
  listTransactionCodingTransactions,
  readyTransactionsForExport,
  recategorizeOpenTransactions,
  replaceTransactionCodingRules,
  saveTransactionCodingWorkspace,
  transactionCodingStorageReady,
  updateTransactionCodingTransaction,
  upsertTransactionCodingRule,
} from '../lib/transactionCodingRepository.js'
import { buildNeutralExportCsv, cleanText, ruleWorkbookRow } from '../lib/transactionCodingDomain.js'
import {
  appendTransactionExportHistory,
  ensureTransactionCodingWorkspace,
  readTransactionRules,
  saveExportToSharePoint,
  saveTransactionRuleToWorkbook,
} from '../lib/transactionCodingSharePoint.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function safeFilePart(value) {
  return String(value || 'transactions').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'transactions'
}

async function provision(env) {
  const workspace = await ensureTransactionCodingWorkspace(env)
  await saveTransactionCodingWorkspace(env.EBUY_DB, workspace)
  return workspace
}

async function syncRules(env, identity, { recategorize = true } = {}) {
  const workspace = await provision(env)
  const workbookRules = await readTransactionRules(workspace)
  const rules = await replaceTransactionCodingRules(env.EBUY_DB, workbookRules, identity?.name || '')
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

async function syncRulesBeforeImport(env, identity) {
  return attemptTransactionRuleSync(() => syncRules(env, identity, { recategorize: false }))
}

export async function handleTransactionCoding(req, env, identity) {
  if (!env.EBUY_DB || !(await transactionCodingStorageReady(env.EBUY_DB))) {
    return json({ error: 'Apply the latest D1 migration to enable Transaction Coding.', code: 'migration_required' }, 503)
  }
  const url = new URL(req.url)
  const path = url.pathname
  const actor = identity?.name || identity?.userId || ''

  if (path === '/transaction-coding/status' && req.method === 'GET') {
    try {
      const workspace = await provision(env)
      return json({ ready: true, retentionDays: 60, workspace: {
        folderUrl: workspace.folderUrl,
        workbookUrl: workspace.workbookUrl,
      } })
    } catch (error) {
      return json({ ready: false, retentionDays: 60, error: error.message }, 502)
    }
  }

  if (path === '/transaction-coding/provision' && req.method === 'POST') {
    const workspace = await provision(env)
    return json({ ok: true, workspace: { folderUrl: workspace.folderUrl, workbookUrl: workspace.workbookUrl } })
  }

  if (path === '/transaction-coding/batches' && req.method === 'GET') {
    return json({ batches: await listTransactionCodingBatches(env.EBUY_DB) })
  }

  if (path === '/transaction-coding/imports' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    if (!Array.isArray(body.rows) || !body.rows.length) return json({ error: 'The statement contains no importable transaction rows.' }, 400)
    const warning = await syncRulesBeforeImport(env, identity)
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
      try {
        const workspace = await provision(env)
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
        await saveTransactionRuleToWorkbook(workspace, ruleWorkbookRow(ruleInput, actor))
        rule = await upsertTransactionCodingRule(env.EBUY_DB, ruleInput, actor)
      } catch (error) {
        ruleWarning = `Transaction saved, but the rule could not be synchronized: ${error.message}`
      }
    }
    return json({ ok: true, transaction, rule, warning: ruleWarning })
  }

  if (path === '/transaction-coding/rules' && req.method === 'GET') {
    if (url.searchParams.get('refresh') === '1') await syncRules(env, identity)
    return json({ rules: await listTransactionCodingRules(env.EBUY_DB) })
  }

  if (path === '/transaction-coding/rules' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    try {
      const workspace = await provision(env)
      const ruleInput = { ...body, id: cleanText(body.id) || crypto.randomUUID() }
      await saveTransactionRuleToWorkbook(workspace, ruleWorkbookRow(ruleInput, actor))
      const rule = await upsertTransactionCodingRule(env.EBUY_DB, ruleInput, actor)
      return json({ ok: true, rule }, 201)
    } catch (error) {
      console.error(JSON.stringify({ event: 'transaction_coding_rule_save_failed', message: error.message }))
      return json({
        error: `The categorization rule could not be saved: ${error.message}`,
        code: 'transaction_rule_save_failed',
      }, 502)
    }
  }

  if (path === '/transaction-coding/exports' && req.method === 'GET') {
    return json({ exports: await listTransactionCodingExports(env.EBUY_DB) })
  }

  if (path === '/transaction-coding/exports' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const batchId = String(body.batchId || '').trim()
    if (!batchId) return json({ error: 'Select an import batch first.' }, 400)
    const rows = await readyTransactionsForExport(env.EBUY_DB, batchId)
    if (!rows.length) return json({ error: 'There are no unexported ready transactions in this batch.' }, 409)
    const csv = buildNeutralExportCsv(rows)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fileName = `${safeFilePart(body.fileName || 'Transaction-Coding')}-${timestamp}.csv`
    let workspace = null
    let archivedItem = null
    let warning = ''
    if (body.archive !== false) {
      try {
        workspace = await provision(env)
        const item = await saveExportToSharePoint(workspace, fileName, csv)
        archivedItem = { ...item, driveId: workspace.driveId }
      } catch (error) {
        warning = `CSV generated, but SharePoint archiving failed: ${error.message}`
      }
    }
    const exported = await createTransactionCodingExport(env.EBUY_DB, { batchId, csvText: csv, fileName, archivedItem }, actor)
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
    return json({ ok: true, export: exported, csv, warning }, 201)
  }

  const exportMatch = path.match(/^\/transaction-coding\/exports\/([^/]+)$/)
  if (exportMatch && req.method === 'GET') {
    const exported = await getTransactionCodingExport(env.EBUY_DB, decodeURIComponent(exportMatch[1]))
    return exported ? json({ export: exported }) : json({ error: 'Export not found.' }, 404)
  }

  return json({ error: 'Not found' }, 404)
}
