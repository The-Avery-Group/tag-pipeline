function formatSAMDate(date) {
  const d = new Date(date)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`
}

function searchWindow() {
  const to = new Date()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - 364)
  return { postedFrom: formatSAMDate(from), postedTo: formatSAMDate(to) }
}

export async function fetchWorkspaceSAMNotice(env, workspace) {
  if (!env.SAM_API_KEY) throw new Error('SAM_API_KEY is not configured')
  const { postedFrom, postedTo } = searchWindow()
  const params = new URLSearchParams({ api_key: env.SAM_API_KEY, postedFrom, postedTo, limit: '10', offset: '0' })
  if (workspace.noticeId) params.set('noticeid', workspace.noticeId)
  else if (workspace.solicitationNumber) params.set('solnum', workspace.solicitationNumber)
  else return { noticeId: '', resourceLinks: [] }
  const response = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.message || `SAM.gov opportunity lookup failed (${response.status})`)
  const records = payload?.opportunitiesData || []
  const exactNotice = String(workspace.noticeId || '').trim().toLowerCase()
  const exactSolicitation = String(workspace.solicitationNumber || '').trim().toLowerCase()
  const record = records.find((item) => exactNotice && String(item.noticeId || '').trim().toLowerCase() === exactNotice)
    || records.find((item) => exactSolicitation && String(item.solicitationNumber || '').trim().toLowerCase() === exactSolicitation)
    || records[0]
  return {
    noticeId: record?.noticeId || workspace.noticeId || '',
    resourceLinks: [...new Set((record?.resourceLinks || []).map((url) => String(url || '').trim()).filter(Boolean))],
  }
}

function attachmentName(response, sourceUrl, index) {
  const disposition = response.headers.get('Content-Disposition') || ''
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8) {
    try { return decodeURIComponent(utf8[1].replace(/^"|"$/g, '')) } catch { /* use fallbacks */ }
  }
  const simple = disposition.match(/filename="?([^";]+)"?/i)
  if (simple?.[1]) return simple[1].trim()
  try {
    const pathName = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || '')
    if (pathName && !/^(download|resource)$/i.test(pathName)) return pathName
  } catch { /* use fallback */ }
  return `SAM attachment ${index + 1}`
}

export async function fetchSAMAttachment(env, sourceUrl, index = 0) {
  let response = await fetch(sourceUrl)
  if ([401, 403].includes(response.status) && env.SAM_API_KEY) {
    const retryUrl = new URL(sourceUrl)
    if (!retryUrl.searchParams.has('api_key')) retryUrl.searchParams.set('api_key', env.SAM_API_KEY)
    response = await fetch(retryUrl)
  }
  if (!response.ok) throw new Error(`SAM.gov attachment download failed (${response.status})`)
  const length = Number(response.headers.get('Content-Length') || 0)
  if (length > 250 * 1024 * 1024) throw new Error('The SAM.gov attachment is larger than the supported SharePoint upload size')
  return {
    response,
    fileName: attachmentName(response, sourceUrl, index),
    contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    byteSize: length || null,
    sourceSignature: [response.headers.get('ETag'), response.headers.get('Last-Modified'), length].filter(Boolean).join('|'),
  }
}

export async function attachmentRecordId(opportunityKey, sourceUrl) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${opportunityKey}\n${sourceUrl}`))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
