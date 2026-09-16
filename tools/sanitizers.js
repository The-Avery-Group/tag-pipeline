(function attachEbuyHarSanitizer(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.EbuyHarSanitizer = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEbuyHarSanitizer() {
  'use strict'

  const VERSION = '1.0.0'
  const REDACTED = '[REDACTED]'
  const AUTH_HOST_SUFFIXES = ['gsa.gov', 'login.gov', 'okta.com']
  const TRACKING_HOST_PARTS = [
    'google-analytics', 'googletagmanager', 'doubleclick', 'googleadservices',
    'cloudflareinsights', 'clarity.ms', 'newrelic', 'nr-data.net', 'sentry.io',
  ]
  const STATIC_EXTENSIONS = /\.(?:avif|bmp|css|eot|gif|ico|jpe?g|js|map|mp3|mp4|ogg|otf|pdf|png|svg|ttf|webm|webp|woff2?)(?:$|\?)/i
  const STATIC_MIME = /^(?:image|font|audio|video)\//i
  const SENSITIVE_HEADERS = new Set([
    'authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key',
    'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'x-okta-user-agent-extended',
  ])
  const SAFE_HEADER_VALUES = new Set([
    'accept', 'content-disposition', 'content-length', 'content-type', 'origin', 'referer', 'location',
    'x-requested-with', 'cache-control', 'pragma',
  ])

  function asArray(value) {
    return Array.isArray(value) ? value : []
  }

  function parseHar(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!parsed || typeof parsed !== 'object' || !parsed.log || !Array.isArray(parsed.log.entries)) {
      throw new Error('This file is not a valid HAR export.')
    }
    return parsed
  }

  function safeUrl(value) {
    try {
      return new URL(value)
    } catch {
      return null
    }
  }

  function isKnownAuthHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    return AUTH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  }

  function isTrackingHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    return TRACKING_HOST_PARTS.some((part) => host.includes(part))
  }

  function scrubPath(pathname) {
    return String(pathname || '/')
      .split('/')
      .map((segment) => {
        if (!segment) return segment
        if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':uuid'
        if (/^\d{9,}$/.test(segment)) return ':numeric-id'
        if (segment.length >= 32 && /^[A-Za-z0-9_~.%+=-]+$/.test(segment)) return ':opaque-id'
        return segment
      })
      .join('/') || '/'
  }

  function endpointFromUrl(value) {
    const url = safeUrl(value)
    if (!url) return { origin: '[invalid URL]', path: '/', queryParameters: [] }
    return {
      origin: url.origin,
      path: scrubPath(url.pathname),
      queryParameters: [...new Set([...url.searchParams.keys()])].map((name) => ({ name, value: REDACTED })),
    }
  }

  function sanitizedUrlValue(value) {
    const endpoint = endpointFromUrl(value)
    if (endpoint.origin === '[invalid URL]') return REDACTED
    return `${endpoint.origin}${endpoint.path}`
  }

  function sanitizeContentDisposition(value) {
    const input = String(value || '')
    const disposition = input.split(';')[0].trim() || 'attachment'
    const extension = input.match(/filename\*?=(?:UTF-8''|["'])?[^;"']+(\.[A-Za-z0-9]{1,8})(?:["'])?/i)?.[1] || ''
    return `${disposition}; filename="[redacted]${extension}"`
  }

  function sanitizeHeaderValue(name, value) {
    const lower = String(name || '').toLowerCase()
    if (SENSITIVE_HEADERS.has(lower)) return REDACTED
    if (!SAFE_HEADER_VALUES.has(lower)) return REDACTED
    if (lower === 'origin' || lower === 'referer' || lower === 'location') return sanitizedUrlValue(value)
    if (lower === 'content-disposition') return sanitizeContentDisposition(value)
    return String(value || '').slice(0, 500)
  }

  function sanitizeHeaders(headers) {
    return asArray(headers).map((header) => ({
      name: String(header?.name || ''),
      value: sanitizeHeaderValue(header?.name, header?.value),
    }))
  }

  function scalarDescriptor(value) {
    if (value === null) return { type: 'null' }
    if (Array.isArray(value)) return describeValue(value)
    if (typeof value === 'object') return describeValue(value)
    if (typeof value === 'boolean') return { type: 'boolean' }
    if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' }
    if (typeof value !== 'string') return { type: typeof value }
    if (/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/.test(value)) return { type: 'string', format: 'date-time' }
    if (/^https?:\/\//i.test(value)) return { type: 'string', format: 'url' }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { type: 'string', format: 'email' }
    return { type: 'string' }
  }

  function mergeDescriptors(left, right) {
    if (!left) return right
    if (!right) return left
    if (left.type !== right.type) {
      const types = [...new Set([...(left.anyOf || [left.type]), ...(right.anyOf || [right.type])])]
      return { type: 'mixed', anyOf: types }
    }
    if (left.type === 'object') {
      const fields = { ...left.fields }
      for (const [key, descriptor] of Object.entries(right.fields || {})) {
        fields[key] = mergeDescriptors(fields[key], descriptor)
      }
      return { type: 'object', fields }
    }
    if (left.type === 'array') return { type: 'array', item: mergeDescriptors(left.item, right.item) }
    return left.format ? left : right
  }

  function describeValue(value, depth = 0) {
    if (depth >= 10) return { type: 'truncated' }
    if (Array.isArray(value)) {
      const sample = value.slice(0, 5).reduce(
        (descriptor, item) => mergeDescriptors(descriptor, describeValue(item, depth + 1)),
        null,
      )
      return { type: 'array', item: sample || { type: 'unknown' } }
    }
    if (value && typeof value === 'object') {
      const fields = {}
      for (const [key, nested] of Object.entries(value).slice(0, 200)) {
        fields[key] = describeValue(nested, depth + 1)
      }
      return { type: 'object', fields }
    }
    return scalarDescriptor(value)
  }

  function requestBodyShape(postData) {
    if (!postData) return null
    const mimeType = String(postData.mimeType || '')
    if (Array.isArray(postData.params) && postData.params.length) {
      return {
        mimeType,
        encoding: 'parameters',
        fields: postData.params.map((item) => ({ name: String(item?.name || ''), value: REDACTED })),
      }
    }
    const text = String(postData.text || '')
    if (!text) return { mimeType, encoding: 'empty' }
    try {
      const parsed = JSON.parse(text)
      return { mimeType, encoding: 'json', shape: describeValue(parsed), valuesRemoved: true }
    } catch {
      try {
        const params = new URLSearchParams(text)
        const names = [...new Set([...params.keys()])]
        if (names.length) {
          return {
            mimeType,
            encoding: 'form',
            fields: names.map((name) => ({ name, value: REDACTED })),
          }
        }
      } catch {
        // Fall through to a metadata-only body.
      }
    }
    return { mimeType, encoding: 'opaque', byteLength: text.length, bodyRemoved: true }
  }

  function responseBodyShape(content) {
    const mimeType = String(content?.mimeType || '')
    const text = String(content?.text || '')
    if (!text) return { mimeType, byteLength: Number(content?.size || 0), bodyRemoved: true }
    if (/json/i.test(mimeType) || /^[\s]*[\[{]/.test(text)) {
      try {
        return {
          mimeType,
          byteLength: Number(content?.size || text.length),
          shape: describeValue(JSON.parse(text)),
          valuesRemoved: true,
        }
      } catch {
        return { mimeType, byteLength: Number(content?.size || text.length), bodyRemoved: true }
      }
    }
    return { mimeType, byteLength: Number(content?.size || text.length), bodyRemoved: true }
  }

  function resourceTypeOf(entry) {
    const explicit = String(entry?._resourceType || entry?._initiator?.type || '').toLowerCase()
    if (explicit) return explicit
    const mimeType = String(entry?.response?.content?.mimeType || '').toLowerCase()
    if (mimeType.includes('json')) return 'fetch'
    if (mimeType.includes('html')) return 'document'
    return 'other'
  }

  function isStaticEntry(entry) {
    const url = String(entry?.request?.url || '')
    const mimeType = String(entry?.response?.content?.mimeType || '')
    const resourceType = resourceTypeOf(entry)
    return STATIC_EXTENSIONS.test(url) || STATIC_MIME.test(mimeType) || ['image', 'font', 'stylesheet', 'script', 'media'].includes(resourceType)
  }

  function shouldRetain(entry, kind) {
    const url = safeUrl(entry?.request?.url)
    if (!url || isTrackingHost(url.hostname) || isStaticEntry(entry)) return false
    const resourceType = resourceTypeOf(entry)
    const method = String(entry?.request?.method || 'GET').toUpperCase()
    if (isKnownAuthHost(url.hostname)) return true
    if (kind === 'authentication') return ['document', 'fetch', 'xhr', 'other'].includes(resourceType) || method !== 'GET'
    return ['fetch', 'xhr', 'document'].includes(resourceType) || method !== 'GET'
  }

  function roundTiming(value) {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : -1
  }

  function sanitizeEntry(entry, index, kind) {
    const request = entry?.request || {}
    const response = entry?.response || {}
    const url = safeUrl(request.url)
    const responseBody = kind === 'authentication'
      ? {
          mimeType: String(response?.content?.mimeType || ''),
          byteLength: Number(response?.content?.size || 0),
          bodyRemoved: true,
          reason: 'Authentication response bodies are never exported.',
        }
      : responseBodyShape(response?.content)
    return {
      sequence: index + 1,
      startedAt: String(entry?.startedDateTime || ''),
      resourceType: resourceTypeOf(entry),
      sourceScope: url && isKnownAuthHost(url.hostname) ? 'GSA or identity provider' : 'external connector candidate',
      method: String(request.method || 'GET').toUpperCase(),
      endpoint: endpointFromUrl(request.url),
      request: {
        httpVersion: String(request.httpVersion || ''),
        headers: sanitizeHeaders(request.headers),
        cookieCountRemoved: asArray(request.cookies).length,
        body: requestBodyShape(request.postData),
      },
      response: {
        status: Number(response.status || 0),
        statusText: String(response.statusText || ''),
        httpVersion: String(response.httpVersion || ''),
        headers: sanitizeHeaders(response.headers),
        cookieCountRemoved: asArray(response.cookies).length,
        body: responseBody,
      },
      timingsMs: {
        blocked: roundTiming(entry?.timings?.blocked),
        connect: roundTiming(entry?.timings?.connect),
        send: roundTiming(entry?.timings?.send),
        wait: roundTiming(entry?.timings?.wait),
        receive: roundTiming(entry?.timings?.receive),
        total: roundTiming(entry?.time),
      },
    }
  }

  function sanitizeCapture(input, options = {}) {
    const har = parseHar(input)
    const kind = options.kind === 'authentication' ? 'authentication' : 'activity'
    const originalEntries = har.log.entries
    const retained = originalEntries.filter((entry) => shouldRetain(entry, kind))
    const hosts = [...new Set(retained.map((entry) => safeUrl(entry?.request?.url)?.hostname).filter(Boolean))].sort()
    return {
      kind,
      label: kind === 'authentication' ? 'Authentication flow' : 'Authenticated eBuy activity',
      summary: {
        totalRequests: originalEntries.length,
        retainedRequests: retained.length,
        excludedRequests: originalEntries.length - retained.length,
        hosts,
        authenticationBodiesRemoved: kind === 'authentication' ? retained.length : 0,
      },
      entries: retained.map((entry, index) => sanitizeEntry(entry, index, kind)),
    }
  }

  function inspectSafety(value) {
    const serialized = JSON.stringify(value)
    const issues = []
    const patterns = [
      ['JWT-like token', /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/],
      ['Bearer credential', /Bearer\s+[A-Za-z0-9._~+\/-]{12,}/i],
      ['Basic credential', /Basic\s+[A-Za-z0-9+/=]{12,}/i],
      ['Email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
      ['Possible secret query value', /[?&](?:token|code|key|secret|session|samlresponse)=[^&\s"\]]{6,}/i],
    ]
    for (const [label, pattern] of patterns) {
      if (pattern.test(serialized)) issues.push(label)
    }
    for (const capture of asArray(value?.captures)) {
      for (const entry of asArray(capture?.entries)) {
        for (const header of [...asArray(entry?.request?.headers), ...asArray(entry?.response?.headers)]) {
          if (SENSITIVE_HEADERS.has(String(header?.name || '').toLowerCase()) && header?.value !== REDACTED) {
            issues.push(`Unredacted ${header.name} header`)
          }
        }
        if (asArray(entry?.endpoint?.queryParameters).some((parameter) => parameter?.value !== REDACTED)) {
          issues.push('Unredacted query parameter')
        }
      }
    }
    return { safe: issues.length === 0, issues: [...new Set(issues)] }
  }

  function buildPackage(captures) {
    const normalized = asArray(captures).filter(Boolean)
    if (!normalized.length) throw new Error('Add at least one HAR file before generating the package.')
    const result = {
      format: 'TAG CRM GSA eBuy connector mapping',
      version: VERSION,
      generatedAt: new Date().toISOString(),
      privacy: {
        originalHarIncluded: false,
        requestValuesIncluded: false,
        responseValuesIncluded: false,
        cookiesIncluded: false,
        authenticationBodiesIncluded: false,
      },
      completeness: {
        authenticationCapture: normalized.some((capture) => capture.kind === 'authentication'),
        activityCapture: normalized.some((capture) => capture.kind === 'activity'),
      },
      captures: normalized,
    }
    result.safety = inspectSafety(result)
    return result
  }

  return {
    VERSION,
    parseHar,
    sanitizeCapture,
    buildPackage,
    inspectSafety,
    describeValue,
    endpointFromUrl,
  }
})
