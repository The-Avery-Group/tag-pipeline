/**
 * SAM.gov entity enrichment used by opportunity details.
 *
 * This deliberately returns only the public 8(a) certification status needed
 * by the UI. The raw Entity Management API response can contain a much wider
 * entity profile and must not be passed through to the browser.
 */

const ENTITY_BASE = 'https://api.sam.gov/entity-information/v4/entities'
const CACHE_TTL_SECONDS = 14 * 24 * 60 * 60

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function normalizeUEI(value) {
  return String(value || '').trim().toUpperCase()
}

function isValidUEI(value) {
  return /^[A-Z0-9]{12}$/.test(value)
}

function eightACertification(data) {
  const certifications = data?.entityData?.[0]?.coreData?.businessTypes?.sbaBusinessTypeList
  if (!Array.isArray(certifications)) return null
  return certifications.find((item) => String(item?.sbaBusinessTypeCode || '').trim().toUpperCase() === 'A6') || null
}

async function getCached(env, key) {
  return env.CACHE ? env.CACHE.get(key, 'json') : null
}

async function setCached(env, key, value) {
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS })
}

export async function handleEntityEightA(req, env) {
  if (!env.SAM_API_KEY) return json({ error: 'SAM_API_KEY not configured' }, 503)

  const url = new URL(req.url)
  const uei = normalizeUEI(url.searchParams.get('uei'))
  const forceRefresh = url.searchParams.get('refresh') === '1'
  if (!isValidUEI(uei)) return json({ error: 'Provide a valid 12-character UEI' }, 400)

  const cacheKey = `entity_8a:v2:${uei}`
  if (!forceRefresh) {
    const cached = await getCached(env, cacheKey)
    if (cached) {
      return json({
        ...cached,
        cache: { source: 'cache', fetchedAt: cached.cachedAt, expiresAt: cached.cacheExpiresAt },
      })
    }
  }

  try {
    const query = new URLSearchParams({
      api_key: env.SAM_API_KEY,
      ueiSAM: uei,
      includeSections: 'entityRegistration,coreData',
    })
    const response = await fetch(`${ENTITY_BASE}?${query}`)
    if (!response.ok) {
      throw new Error(`SAM Entity API error ${response.status}`)
    }

    const data = await response.json()
    const certification = eightACertification(data)
    const entity = data?.entityData?.[0]
    const cachedAt = new Date().toISOString()
    const result = {
      uei,
      cageCode: String(entity?.entityRegistration?.cageCode || '').trim().toUpperCase() || null,
      eightA: certification
        ? {
            code: certification.sbaBusinessTypeCode,
            description: certification.sbaBusinessTypeDesc || 'SBA Certified 8(a) Program Participant',
            entryDate: certification.certificationEntryDate || null,
            exitDate: certification.certificationExitDate || null,
          }
        : null,
      source: 'SAM.gov Entity Management API',
      cachedAt,
      cacheExpiresAt: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
    }
    await setCached(env, cacheKey, result)
    return json({ ...result, cache: { source: 'live', fetchedAt: cachedAt, expiresAt: result.cacheExpiresAt } })
  } catch (error) {
    console.error('[Entity 8(a)] Lookup error:', error.message)
    return json({ error: error.message }, 502)
  }
}
