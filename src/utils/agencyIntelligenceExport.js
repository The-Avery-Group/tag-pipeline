function clean(value) {
  return String(value ?? '').trim()
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0))
}

function join(values, fallback = 'Not reported') {
  const result = [...new Set((values || []).map(clean).filter(Boolean))]
  return escapeHtml(result.length ? result.join('; ') : fallback)
}

function rowsFor(report) {
  return (report?.vehicles || []).map((vehicle, index) => `
    <tr>
      <td class="number">${index + 1}</td>
      <td class="vehicle">${escapeHtml(vehicle.vehicleName)}</td>
      <td class="number">${Number(vehicle.recordCount || 0).toLocaleString()}</td>
      <td>${join(vehicle.issuingDepartments)}</td>
      <td>${join(vehicle.vehicleTypes)}</td>
      <td>${join(vehicle.setAsides, 'Not stated')}</td>
      <td>${join(vehicle.awardTypes)}</td>
      <td class="money">${escapeHtml(money(vehicle.totalContractValue))}</td>
    </tr>`).join('')
}

export function exportAgencyVehicleDocument(groups, reportsByAgency) {
  const sections = groups.map((group) => {
    const agencies = group.agencies.map((agency) => {
      const report = reportsByAgency.get(agency.name)
      const rows = rowsFor(report)
      return `
        <h2>${escapeHtml(agency.name)}</h2>
        ${rows ? `<table>
          <thead><tr><th>#</th><th>Vehicle or category</th><th>Records</th><th>Issuing department</th><th>Vehicle or IDV type(s)</th><th>Set-aside(s)</th><th>Award or order type(s)</th><th>Total contract value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<p class="empty">No named contract vehicles were available.</p>'}`
    }).join('')
    return `<section><h1>${escapeHtml(group.department)}</h1>${agencies}</section>`
  }).join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Target Agencies Contract Vehicles</title><style>
    @page { size: landscape; margin: 0.55in; }
    body { font-family: Calibri, Arial, sans-serif; color: #313943; font-size: 9.5pt; }
    h1 { color: #173d69; font-family: Georgia, serif; font-size: 20pt; margin: 22pt 0 12pt; page-break-after: avoid; }
    h2 { color: #315c9f; font-family: Georgia, serif; font-size: 14pt; margin: 14pt 0 7pt; page-break-after: avoid; text-transform: uppercase; }
    table { border-collapse: collapse; width: 100%; margin: 0 0 16pt; page-break-inside: auto; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
    th { background: #173d69; color: white; border: 1px solid #142d48; padding: 7pt 5pt; text-align: center; }
    td { border: 1px solid #4b535b; padding: 6pt 5pt; vertical-align: middle; }
    tbody tr:nth-child(odd) td { background: #eaf2f9; }
    .vehicle { font-weight: 700; }
    .number { text-align: center; white-space: nowrap; }
    .money { text-align: right; white-space: nowrap; }
    .empty { color: #6d7580; font-style: italic; }
  </style></head><body>${sections}</body></html>`
  const blob = new Blob([html], { type: 'application/msword;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `Target-Agencies-Contract-Vehicles-${new Date().toISOString().slice(0, 10)}.doc`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
