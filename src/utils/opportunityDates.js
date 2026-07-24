export function dateOnly(value) {
  const raw = String(value || '').trim()
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/)
  if (iso) return iso[0]
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return [parsed.getFullYear(), String(parsed.getMonth() + 1).padStart(2, '0'), String(parsed.getDate()).padStart(2, '0')].join('-')
}

export function localDate(value) {
  const date = dateOnly(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : new Date(NaN)
}

export function sbaProfileUrl(entityData, incumbentUEI) {
  const uei = String(entityData?.uei || incumbentUEI || '').trim().toUpperCase()
  const cageCode = String(entityData?.cageCode || '').trim().toUpperCase()
  return /^[A-Z0-9]{12}$/.test(uei) && /^[A-Z0-9]{5}$/.test(cageCode)
    ? `https://search.certifications.sba.gov/profile/${encodeURIComponent(uei)}/${encodeURIComponent(cageCode)}?page=1`
    : 'https://search.certifications.sba.gov/'
}
