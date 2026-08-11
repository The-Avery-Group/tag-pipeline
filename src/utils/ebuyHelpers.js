export function ebuyToPipelineRecord(opportunity, outlook = 'New') {
  const buyerContact = [opportunity.buyerName, opportunity.buyerEmail, opportunity.buyerPhone]
    .map((value) => String(value || '').trim()).filter(Boolean).join(' | ')
  const vehicle = opportunity.vehiclePairs?.length
    ? opportunity.vehiclePairs.join(', ')
    : opportunity.vehicleSources?.join(', ') || ''
  return {
    'Contract Number / Notice ID': opportunity.requestId,
    'Project Title / Description*': opportunity.title,
    'Agency*': opportunity.buyerAgency,
    'Department*': opportunity.buyerDepartment,
    'TAG Opportunity Phase': 'Identified',
    'TAG Pipeline Activity Phase': '',
    'Opportunity Outlook': outlook,
    'Submission Date (Response Date)*': String(opportunity.closesAt || '').slice(0, 10),
    'Solicitation Number': opportunity.referenceNumber || opportunity.requestId,
    'Notice Type': opportunity.requestType,
    'Priority': 'Warm',
    'Set- Aside*': opportunity.setAsideType || '-',
    'Contract Classification*': opportunity.contractType || '',
    'Contract Vehicle': vehicle,
    'Contract Vehicle Number': opportunity.vehicleSources?.join(', ') || '',
    'Contracting Officer / Specialist (POC)*': buyerContact,
    'Office*': opportunity.buyerAgency,
    'Notes*': opportunity.description || '',
  }
}

