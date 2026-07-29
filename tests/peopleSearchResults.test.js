import assert from 'node:assert/strict'
import test from 'node:test'
import { possibleFormerRoleReason } from '../src/utils/peopleSearchResults.js'

test('flags explicit former-role language in public profile results', () => {
  assert.match(
    possibleFormerRoleReason({
      title: 'Jane Doe - Former Chief of Staff',
      snippet: 'Department of Example',
    }),
    /former/i,
  )
})

test('flags closed year ranges unless the result also identifies a current role', () => {
  assert.match(
    possibleFormerRoleReason({
      title: 'John Doe',
      snippet: 'Program Manager at Example Agency · 2018 - 2020',
    }),
    /past end year/i,
  )
  assert.equal(
    possibleFormerRoleReason({
      title: 'John Doe',
      snippet: 'Program Manager at Example Agency · 2018 - 2020 · Current business owner',
    }),
    '',
  )
})

test('still flags an explicit former agency role when a different current role is present', () => {
  assert.match(
    possibleFormerRoleReason({
      title: 'Jane Doe - Former Chief of Staff',
      snippet: 'Example Agency · Current business owner',
    }),
    /former/i,
  )
})

test('does not infer that an undated public result is historical', () => {
  assert.equal(
    possibleFormerRoleReason({
      title: 'Alex Doe - Chief of Staff',
      snippet: 'Example Agency',
    }),
    '',
  )
})
