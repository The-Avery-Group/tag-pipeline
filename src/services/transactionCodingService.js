import { workerJson } from '@/services/workerClient'

export const getTransactionCodingAccess = () => workerJson('/transaction-coding/access', { cache: 'no-store' })
export const getTransactionCodingStatus = () => workerJson('/transaction-coding/status', { cache: 'no-store' })
export const getTransactionBatches = () => workerJson('/transaction-coding/batches', { cache: 'no-store' }).then((data) => data.batches || [])
export const deleteTransactionBatch = (id) => workerJson(`/transaction-coding/batches/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const importTransactionStatement = (payload) => workerJson('/transaction-coding/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
export const getTransactions = (batchId, status = '', search = '') => {
  const query = new URLSearchParams({ batchId })
  if (status) query.set('status', status)
  if (search) query.set('search', search)
  return workerJson(`/transaction-coding/transactions?${query}`, { cache: 'no-store' }).then((data) => data.transactions || [])
}
export const updateTransaction = (id, payload) => workerJson(`/transaction-coding/transactions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
export const getTransactionRules = (refresh = false) => workerJson(`/transaction-coding/rules${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' }).then((data) => data.rules || [])
export const createTransactionRule = (payload) => workerJson('/transaction-coding/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
export const updateTransactionRule = (id, payload) => workerJson(`/transaction-coding/rules/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
export const deleteTransactionRule = (id) => workerJson(`/transaction-coding/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getTransactionExports = () => workerJson('/transaction-coding/exports', { cache: 'no-store' }).then((data) => data.exports || [])
export const getInvoiceReferenceSequences = () => workerJson('/transaction-coding/invoice-reference-sequences', { cache: 'no-store' })
export const getTransactionExport = (id) => workerJson(`/transaction-coding/exports/${encodeURIComponent(id)}`, { cache: 'no-store' }).then((data) => data.export)
export const createTransactionExport = (payload) => workerJson('/transaction-coding/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })

export function downloadCsv(csv, fileName) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
