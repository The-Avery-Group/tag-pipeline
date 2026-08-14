// Five MiB is a multiple of Microsoft Graph's required 320 KiB fragment size.
const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024
const MAX_UPLOAD_ATTEMPTS = 3

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('Retry-After'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 10000)
  return 500 * (2 ** attempt)
}

async function uploadChunk(uploadUrl, chunk, start, totalSize) {
  const end = start + chunk.size - 1
  let lastError = null
  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Content-Type': 'application/octet-stream',
        },
        body: chunk,
      })
      const payload = await response.json().catch(() => ({}))
      if (response.ok) return { response, payload }
      const message = payload?.error?.message || `SharePoint upload failed (${response.status})`
      lastError = new Error(message)
      if (response.status !== 429 && response.status < 500) {
        lastError.nonRetryable = true
        throw lastError
      }
      if (attempt < MAX_UPLOAD_ATTEMPTS - 1) await delay(retryDelay(response, attempt))
    } catch (error) {
      lastError = error
      if (error?.nonRetryable) throw error
      if (attempt < MAX_UPLOAD_ATTEMPTS - 1) await delay(500 * (2 ** attempt))
    }
  }
  throw lastError || new Error('SharePoint upload failed')
}

async function cancelUploadSession(uploadUrl) {
  await fetch(uploadUrl, { method: 'DELETE' }).catch(() => {})
}

async function uploadOne(file, prepareUpload, validateFile, onChunk) {
  const validationError = validateFile?.(file)
  if (validationError) throw new Error(validationError)
  const prepared = await prepareUpload(file)
  const uploadUrl = prepared?.upload?.uploadUrl
  if (!uploadUrl) throw new Error(`SharePoint did not prepare ${file.name} for upload`)

  try {
    let completedItem = null
    for (let start = 0; start < file.size; start += UPLOAD_CHUNK_SIZE) {
      const chunk = file.slice(start, Math.min(start + UPLOAD_CHUNK_SIZE, file.size))
      const { response, payload } = await uploadChunk(uploadUrl, chunk, start, file.size)
      onChunk?.(chunk.size)
      if (response.status === 200 || response.status === 201) completedItem = payload
    }
    if (!completedItem?.webUrl) throw new Error(`SharePoint did not return a link for ${file.name}`)
    return {
      id: completedItem.id || '',
      name: completedItem.name || prepared.upload.fileName || file.name,
      webUrl: completedItem.webUrl,
      size: Number(completedItem.size || file.size),
    }
  } catch (error) {
    await cancelUploadSession(uploadUrl)
    throw error
  }
}

export async function uploadSharePointFiles({ files, prepareUpload, rollback, validateFile, onProgress }) {
  const selected = Array.from(files || [])
  const totalBytes = selected.reduce((sum, file) => sum + Number(file.size || 0), 0)
  let uploadedBytes = 0
  const uploaded = []
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index]
      onProgress?.({ fileName: file.name, fileIndex: index, fileCount: selected.length, uploadedBytes, totalBytes })
      uploaded.push(await uploadOne(file, prepareUpload, validateFile, (chunkSize) => {
        uploadedBytes += chunkSize
        onProgress?.({ fileName: file.name, fileIndex: index, fileCount: selected.length, uploadedBytes, totalBytes })
      }))
    }
  } catch (error) {
    if (uploaded.length) await rollback(uploaded).catch(() => {})
    throw error
  }
  return uploaded
}
