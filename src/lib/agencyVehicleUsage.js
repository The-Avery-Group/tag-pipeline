const ORDER_CODES = ['A', 'C']

function clean(value) {
  return String(value || '').trim()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalized(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
}

function codeValue(value) {
  if (value && typeof value === 'object') return clean(value.code)
  return clean(value)
}

function incrementCount(target, value) {
  const key = codeValue(value)
  if (key) target[key] = (target[key] || 0) + 1
}

function mostCommon(counts = {}) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || ''
}

export function currentFiveFiscalYears(now = new Date()) {
  const year = now.getUTCFullYear()
  const currentFiscalYear = now.getUTCMonth() >= 9 ? year + 1 : year
  return {
    firstFiscalYear: currentFiscalYear - 4,
    lastFiscalYear: currentFiscalYear,
    startDate: `${currentFiscalYear - 5}-10-01`,
    endDate: now.toISOString().slice(0, 10),
  }
}

export function agencyUsageFilters(agency, scope = 'funding', now = new Date()) {
  const selected = {
    type: scope === 'awarding' ? 'awarding' : 'funding',
    tier: agency?.tier === 'subtier' ? 'subtier' : 'toptier',
    name: clean(agency?.name),
  }
  if (selected.tier === 'subtier' && agency?.parentName) {
    selected.toptier_name = clean(agency.parentName)
  }
  const period = currentFiveFiscalYears(now)
  return {
    agencies: [selected],
    award_type_codes: ORDER_CODES,
    time_period: [{ start_date: period.startDate, end_date: period.endDate }],
  }
}

export function agencyUsageIdentity(agency, scope = 'funding') {
  return [
    scope === 'awarding' ? 'awarding' : 'funding',
    agency?.tier === 'subtier' ? 'subtier' : 'toptier',
    normalized(agency?.parentName),
    normalized(agency?.name),
  ].join(':')
}

export function parentAwardIdFromRecord(record) {
  const awardId = clean(record?.['Award ID'])
  const generatedId = clean(record?.generated_internal_id)
  const prefix = `CONT_AWD_${awardId}_`
  if (!awardId || !generatedId.toUpperCase().startsWith(prefix.toUpperCase())) return ''
  const parts = generatedId.slice(prefix.length).split('_')
  if (parts.length < 3) return ''
  const parentAwardId = clean(parts.slice(1, -1).join('_')).toUpperCase()
  return parentAwardId && !/^[-]?NONE[-]?$/i.test(parentAwardId) ? parentAwardId : ''
}

export function aggregateVehicleOrders(records = [], seed = {}) {
  const aggregate = { ...seed }
  for (const record of records) {
    const parentAwardId = clean(record?.['Parent Award ID']).toUpperCase() || parentAwardIdFromRecord(record)
    if (!parentAwardId) continue
    const orderId = clean(record?.['Award ID']).toUpperCase()
    const contractor = clean(record?.['Recipient Name'])
    const contractorKey = clean(record?.['Recipient UEI']) || normalized(contractor)
    const signedDate = clean(record?.['Last Modified Date']) || clean(record?.['Base Obligation Date'])
    const current = aggregate[parentAwardId] || {
      parentAwardId,
      orderIds: {},
      contractors: {},
      obligations: 0,
      lastUsed: '',
      naics: {},
      psc: {},
      samples: [],
    }
    if (!orderId || !current.orderIds[orderId]) {
      if (orderId) current.orderIds[orderId] = true
      current.obligations += number(record?.['Award Amount'])
      if (contractorKey) current.contractors[contractorKey] = contractor || contractorKey
      incrementCount(current.naics, record?.NAICS)
      incrementCount(current.psc, record?.PSC)
      if (signedDate && (!current.lastUsed || signedDate > current.lastUsed)) current.lastUsed = signedDate
      if (current.samples.length < 8) {
        current.samples.push({
          awardId: orderId,
          generatedId: clean(record?.generated_internal_id),
          contractor,
          obligation: number(record?.['Award Amount']),
          signedDate,
          description: clean(record?.Description),
        })
      }
    }
    aggregate[parentAwardId] = current
  }
  return aggregate
}

export function finalizeVehicleUsage(aggregate = {}, resolutions = {}) {
  const vehicles = Object.values(aggregate).map((item) => {
    const resolved = resolutions[item.parentAwardId] || {}
    return {
      parentAwardId: item.parentAwardId,
      vehicleName: clean(resolved.description),
      vehicleType: clean(resolved.vehicleType),
      generatedId: clean(resolved.generatedId),
      ceiling: number(resolved.ceiling),
      lastDateToOrder: clean(resolved.lastDateToOrder),
      orders: Object.keys(item.orderIds || {}).length || item.samples?.length || 0,
      contractors: Object.keys(item.contractors || {}).length,
      obligations: number(item.obligations),
      lastUsed: clean(item.lastUsed),
      topNaics: mostCommon(item.naics),
      topPsc: mostCommon(item.psc),
      sampleOrders: item.samples || [],
    }
  }).sort((a, b) => b.orders - a.orders || b.obligations - a.obligations || a.parentAwardId.localeCompare(b.parentAwardId))

  return {
    vehicles,
    totals: {
      vehicles: vehicles.length,
      orders: vehicles.reduce((sum, item) => sum + item.orders, 0),
      contractors: new Set(Object.values(aggregate).flatMap((item) => Object.keys(item.contractors || {}))).size,
      obligations: vehicles.reduce((sum, item) => sum + item.obligations, 0),
    },
  }
}
