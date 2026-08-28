import test from 'node:test'
import assert from 'node:assert/strict'
import {
  availableTransactionFields,
  automaticInvoiceReference,
  defaultInputVoucherNumber,
  resolveTransactionPattern,
} from '../src/utils/costpointInvoiceReference.js'

const row = {
  id: 'txn-custom',
  transactionDate: '2026-08-28',
  amountCents: 1050,
  vendorId: 'VEN-7',
  clientProvidedField: 'BLUE',
}

test('invoice patterns resolve arbitrary available transaction fields', () => {
  assert.equal(resolveTransactionPattern('{clientProvidedField}-{vendorId}', row), 'BLUE-VEN-7')
  assert.ok(availableTransactionFields([row]).includes('clientProvidedField'))
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
