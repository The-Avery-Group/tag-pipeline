const pendingCreates = new Map()
const tableMutationTails = new Map()

/**
 * Serialize workbook writes per table. Excel row indexes are positional, so
 * an append/delete that overlaps another mutation can make the second write
 * target yesterday's row layout. Different tables remain fully concurrent.
 */
export function queueTableMutation(tableName, operation) {
  const key = String(tableName || '').trim()
  if (!key) return Promise.resolve().then(operation)

  const previous = tableMutationTails.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  tableMutationTails.set(key, current)
  current.finally(() => {
    if (tableMutationTails.get(key) === current) tableMutationTails.delete(key)
  }).catch(() => {})
  return current
}

export function createStableId(prefix) {
  const webCrypto = globalThis.crypto
  const suffix = typeof webCrypto?.randomUUID === 'function'
    ? webCrypto.randomUUID()
    : Array.from(webCrypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
  return `${prefix}-${suffix}`
}

function normalized(value) {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Coalesce identical creates that are still in flight. This protects against
 * rapid repeated clicks across separate hook instances, not only within the
 * component that rendered the button.
 */
export function createOnce(operationKey, operation) {
  const key = String(operationKey || '').trim()
  if (!key) return operation()
  if (pendingCreates.has(key)) return pendingCreates.get(key)

  const promise = Promise.resolve().then(operation)
  pendingCreates.set(key, promise)
  promise.finally(() => {
    if (pendingCreates.get(key) === promise) pendingCreates.delete(key)
  }).catch(() => {})
  return promise
}

/**
 * Append a record with a stable workbook identity. When Graph returns an
 * ambiguous failure, read the table and look for that identity before retrying
 * the append. If reconciliation itself fails, do not risk creating a duplicate.
 */
export async function appendWithReconciliation({
  operationKey,
  idColumn,
  idValue,
  record,
  append,
  readRows,
  attempts = 2,
  checkBeforeAppend = false,
}) {
  if (!idColumn || !String(idValue || '').trim()) {
    throw new Error('A stable record identifier is required before creating this record')
  }

  return createOnce(operationKey || `${idColumn}:${normalized(idValue)}`, async () => {
    let lastError = null

    if (checkBeforeAppend) {
      const existing = (await readRows()).find((row) =>
        normalized(row?.[idColumn]) === normalized(idValue)
      )
      if (existing) return { ...existing, _recovered: true, _alreadyExisted: true }
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await append()
        const rowIndex = Number(response?.index)
        return {
          ...record,
          ...(Number.isFinite(rowIndex) ? { _rowIndex: rowIndex } : {}),
          _recovered: false,
        }
      } catch (error) {
        lastError = error
        let rows
        try {
          rows = await readRows()
        } catch {
          const ambiguous = new Error(
            `${error.message}. The workbook could not be checked safely, so the create was not retried.`,
          )
          ambiguous.cause = error
          ambiguous.ambiguousCreate = true
          throw ambiguous
        }

        const existing = rows.find((row) =>
          normalized(row?.[idColumn]) === normalized(idValue)
        )
        if (existing) return { ...existing, _recovered: true }
      }
    }

    throw lastError || new Error('The record could not be created')
  })
}

export function createFingerprint(values) {
  return Object.entries(values || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${normalized(value)}`)
    .join('|')
}

/**
 * Retry only operations whose repeated execution is safe, such as a patch to
 * the same row or deleting the same known row. Never use this for appends.
 */
export async function retryIdempotent(operation, attempts = 3) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
