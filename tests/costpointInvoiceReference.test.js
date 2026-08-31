import test from 'node:test'
import assert from 'node:assert/strict'
import {
  availableTransactionFields,
  automaticInvoiceReference,
  defaultInputVoucherNumber,
  INVOICE_REFERENCE_PATTERN_FIELDS,
  invoiceReferenceSequencePlan,
  invoiceReferenceForMode,
  resolveTransactionPattern,
} from '../src/utils/costpointInvoiceReference.js'

const row = {
  id: 'txn-custom',
  transactionDate: '2026-08-28',
  amountCents: 1050,
  vendorId: 'VEN-7',
  clientProvidedField: 'BLUE',
}

test('invoice patterns expose only month and padded sequence', () => {
  assert.equal(resolveTransactionPattern('INV-{date}-{sequence}', row, 1), 'INV-2026-08-001')
  assert.equal(resolveTransactionPattern('INV{date}{sequence}', row, 1000), 'INV2026-081000')
  assert.deepEqual(INVOICE_REFERENCE_PATTERN_FIELDS, ['date', 'sequence'])
  // Arbitrary transaction properties were intentionally retired from the
  // custom-pattern builder. Keep this assertion aligned with the restricted
  // UI and Worker validation so CI cannot preserve the former behavior.
  assert.throws(() => invoiceReferenceForMode(row, 1, 'custom', '{clientProvidedField}-{sequence}'), /Unavailable field/)
  assert.throws(() => invoiceReferenceForMode(row, 1, 'custom', '{vendorId}-{date}'), /Unavailable field/)
})

test('legacy pattern helpers remain compatible without exposing their fields in the CRM', () => {
  assert.equal(resolveTransactionPattern('{clientProvidedField}-{vendorId}', row), 'BLUE-VEN-7')
  assert.ok(availableTransactionFields([row]).includes('clientProvidedField'))
})

test('sequence plans reset per statement or continue independently by month', () => {
  const rows = [
    { id: 'later', transactionDate: '2026-08-20', sourceRow: 4 },
    { id: 'earlier', transactionDate: '2026-08-01', sourceRow: 2 },
    { id: 'september', transactionDate: '2026-09-01', sourceRow: 3 },
  ]
  assert.deepEqual(invoiceReferenceSequencePlan(rows, { start: 7 }).sequences, { earlier: 7, later: 8, september: 9 })
  assert.deepEqual(invoiceReferenceSequencePlan(rows, {
    scope: 'monthly', start: 7, nextByMonth: { '2026-08': 20, '2026-09': 3 },
  }).sequences, { earlier: 20, later: 21, september: 7 })
})

test('automatic invoice references fit the Costpoint field', () => {
  const reference = automaticInvoiceReference(row)
  assert.equal(reference.length, 15)
  assert.match(reference, /^TC260828/)
})

test('default Costpoint transaction IDs are stable numeric values', () => {
  assert.equal(defaultInputVoucherNumber(row), defaultInputVoucherNumber(row))
  assert.match(defaultInputVoucherNumber(row), /^\d{9}$/)
})
