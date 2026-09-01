import test from 'node:test'
import assert from 'node:assert/strict'
import { requiredCrmToolForMessage } from '../src/handlers/ai.js'

test('contact-to-contract questions require the relationship tool', () => {
  assert.equal(
    requiredCrmToolForMessage('I need a table of contracts that have Amanda Haynes as their contact'),
    'get_contact_contracts'
  )
  assert.equal(
    requiredCrmToolForMessage('Which opportunities are linked with Amanda Haynes?'),
    'get_contact_contracts'
  )
})

test('ordinary conversation does not force a relationship tool', () => {
  assert.equal(requiredCrmToolForMessage('hello'), '')
  assert.equal(requiredCrmToolForMessage('Summarize the pipeline'), '')
})
