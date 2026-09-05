import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSAMOpportunityDetail, normalizeSAMStructuredResources, samDescriptionText, samOrganizationHierarchy } from '../src/lib/samOpportunityDetail.js'
import { mergeSAMArchive, samArchiveInputForDiscoveryRow } from '../src/handlers/sam.js'

test('portal files absent from the SAM API appear after archiving and remain deduplicated', () => {
  const file = { sourceUrl: 'https://www.fedconnect.net/file', fileName: 'Corrected RFI.pdf', webUrl: 'https://example.sharepoint.com/file' }
  const detail = { attachments: [], links: [{ url: 'https://www.fedconnect.net/opportunity' }] }
  const archive = { files: [file], archiveStatus: 'ready' }
  const merged = mergeSAMArchive(detail, archive)
  assert.deepEqual(merged.attachments, [file])
  assert.deepEqual(merged.links, detail.links)
  assert.deepEqual(mergeSAMArchive(merged, archive).attachments, [file])
})

test('SAM detail keeps every organization level without inventing an additional section', () => {
  assert.deepEqual(
    samOrganizationHierarchy('DEPT OF DEFENSE.DEPT OF THE ARMY.ARMY MATERIEL COMMAND.ACC-RI.W6QK ACC-RI'),
    {
      department: 'DEPT OF DEFENSE',
      subTier: 'DEPT OF THE ARMY',
      majorCommand: 'ARMY MATERIEL COMMAND',
      subCommand1: 'ACC-RI',
      subCommand2: '',
      subCommand3: '',
      office: 'W6QK ACC-RI',
      fullPath: ['DEPT OF DEFENSE', 'DEPT OF THE ARMY', 'ARMY MATERIEL COMMAND', 'ACC-RI', 'W6QK ACC-RI'],
    },
  )
})

test('SAM detail separates external links, attachments, contacts, and formatted description', () => {
  const detail = normalizeSAMOpportunityDetail({
    noticeId: 'abc-123',
    solicitationNumber: 'W91-TEST',
    title: '  Example\n opportunity  ',
    type: 'r',
    active: true,
    fullParentPathName: 'DEPT OF DEFENSE.DEPT OF THE ARMY.W6QK ACC-RI',
    responseDeadLine: '2026-09-01T17:00:00-04:00',
    description: 'First paragraph.\n\nSee https://piee.eb.mil/sol/xhtml/unauth/index.xhtml for the package.',
    additionalInfoLink: 'https://piee.eb.mil/sol/xhtml/unauth/index.xhtml',
    resourceLinks: [
      'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/SOW.docx/download',
      'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/SOW.docx/download',
      'https://piee.eb.mil/sol/xhtml/unauth/another-link.xhtml',
    ],
    pointOfContact: [
      { type: 'secondary', fullName: 'Second POC', email: 'second@example.mil' },
      { type: 'primary', fullName: 'Primary POC', email: 'primary@example.mil', phone: '555-0100' },
    ],
    officeAddress: { streetAddress: '1 Main Street', city: 'Washington', state: 'DC', zip: '20001' },
  })

  assert.equal(detail.title, 'Example opportunity')
  assert.equal(detail.noticeType, 'RFI')
  assert.equal(detail.links.length, 2)
  assert.deepEqual(detail.links.map((link) => link.label), ['PIEE solicitation', 'PIEE solicitation'])
  assert.equal(detail.attachments.length, 1)
  assert.equal(detail.attachments[0].fileName, 'SOW.docx')
  assert.deepEqual(detail.contacts.map((contact) => contact.name), ['Primary POC', 'Second POC'])
  assert.match(detail.contractingOfficeAddress, /Washington, DC, 20001/)
  assert.match(detail.description, /\n\nSee https:\/\//)
})

test('SAM Award Notice details retain the fields needed by the outcome workflow', () => {
  const detail = normalizeSAMOpportunityDetail({
    noticeId: 'award-notice-id',
    type: 'Award Notice',
    award: {
      number: 'W91-AWARD-001', date: '2026-09-04', amount: '2500000',
      awardee: { name: 'The Avery Group, LLC', ueiSAM: 'TESTUEI12345' },
    },
  })
  assert.deepEqual(detail.award, {
    number: 'W91-AWARD-001', date: '2026-09-04', amount: 2500000,
    awardeeName: 'The Avery Group, LLC', awardeeUEI: 'TESTUEI12345',
  })
})

test('new SAM discovery rows carry enough identity to start attachment archiving', () => {
  assert.deepEqual(samArchiveInputForDiscoveryRow({
    'Notice ID': 'abc-123',
    'Solicitation Number': 'W91-EXAMPLE',
    Title: 'Program support',
    Department: 'DEPT OF DEFENSE',
    Agency: 'DEPT OF THE ARMY',
  }), {
    opportunityKey: 'w91-example',
    noticeId: 'abc-123',
    solicitationNumber: 'W91-EXAMPLE',
    title: 'Program support',
    department: 'DEPT OF DEFENSE',
    agency: 'DEPT OF THE ARMY',
  })
})

test('SAM description HTML becomes readable text and hides SAM API links', () => {
  const text = samDescriptionText({ description: [
    { body: '<p>Please see the <strong>statement of work</strong>.</p><p><a href="https://piee.eb.mil/sol">Open PIEE</a></p><p>https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc</p>' },
  ] })
  assert.equal(text, 'Please see the statement of work.\n\n[Open PIEE](https://piee.eb.mil/sol)')
})

test('SAM description decodes named bullets and common document punctuation', () => {
  const text = samDescriptionText({
    body: '<p>Requirements:</p><p>&bull; Program support<br>&bull; Reporting &amp; analysis &mdash; monthly</p>',
  })

  assert.equal(text, 'Requirements:\n\n• Program support\n• Reporting & analysis — monthly')
})

test('SAM detail keeps description links in the description but never promotes them to External links', () => {
  const detail = normalizeSAMOpportunityDetail({
    description: `<p>Full instructions are available at <a href="https://piee.eb.mil/sol/notice/123">PIEE solicitation package</a>.</p>
      <p>Questions: https://example.gov/acquisition/questions.</p>`,
  })

  assert.deepEqual(detail.links, [])
  assert.match(detail.description, /PIEE solicitation package/)
  assert.match(detail.description, /example\.gov\/acquisition\/questions/)
})

test('SAM detail uses source titles and trusted service names for authoritative external links', () => {
  const detail = normalizeSAMOpportunityDetail({
    additionalInfoLink: 'https://www.fedconnect.net/FedConnect/?doc=ABC',
    links: [
      { href: 'https://piee.eb.mil/sol/notice/123', title: 'Agency PIEE package' },
      { href: 'https://procurement.example.gov/notices/123' },
    ],
  })
  assert.deepEqual(detail.links, [
    { url: 'https://www.fedconnect.net/FedConnect/?doc=ABC', label: 'FedConnect notice', source: 'additionalInfoLink', resourceType: 'opportunity_portal', resourceTypeLabel: 'Opportunity portal', retrievalEligible: false },
    { url: 'https://piee.eb.mil/sol/notice/123', label: 'Agency PIEE package', source: 'links', resourceType: 'opportunity_portal', resourceTypeLabel: 'Opportunity portal', retrievalEligible: false },
    { url: 'https://procurement.example.gov/notices/123', label: 'procurement.example.gov', source: 'links', resourceType: 'reference', resourceTypeLabel: 'Reference website', retrievalEligible: false },
  ])
})

test('SAM website resources retain a described FedConnect portal without inventing an attachment', () => {
  const structuredResources = normalizeSAMStructuredResources({
    _embedded: { opportunityAttachmentList: [{ attachments: [{
      attachmentId: 'link-1', resourceId: 'resource-1', type: 'link',
      uri: 'https://www.fedconnect.net/FedConnect/?doc=1305M326Q0504&agency=DOC',
      description: 'Click here to see more information about this opportunity on FedConnect',
    }] }] },
  })
  const detail = normalizeSAMOpportunityDetail({ noticeId: 'sample', structuredResources })
  assert.equal(detail.attachments.length, 0)
  assert.deepEqual(detail.links, [{
    url: 'https://www.fedconnect.net/FedConnect/?doc=1305M326Q0504&agency=DOC',
    label: 'Click here to see more information about this opportunity on FedConnect',
    source: 'samResources', resourceType: 'opportunity_portal', resourceTypeLabel: 'Opportunity portal', retrievalEligible: false,
  }])
})

test('structured forms can be archived while their original URL remains available', () => {
  const structuredResources = normalizeSAMStructuredResources({ resources: [{
    type: 'link', uri: 'https://agency.gov/forms/SF-1449.pdf', description: 'SF 1449 submission form',
  }] })
  const detail = normalizeSAMOpportunityDetail({ structuredResources })
  assert.equal(detail.links.length, 0)
  assert.equal(detail.attachments.length, 1)
  assert.equal(detail.attachments[0].sourceUrl, 'https://agency.gov/forms/SF-1449.pdf')
  assert.equal(detail.attachments[0].resourceType, 'form')
})

test('structured reference websites remain visible but are not sent to the file archiver', () => {
  const structuredResources = normalizeSAMStructuredResources({ resources: [
    { type: 'link', uri: 'https://agency.gov/policy', description: 'Applicable agency policy' },
    { type: 'link', uri: 'https://standards.example.org/specification', description: 'Technical standard' },
  ] })
  const detail = normalizeSAMOpportunityDetail({ structuredResources })
  assert.equal(detail.attachments.length, 0)
  assert.deepEqual(detail.links.map((link) => link.resourceType), ['reference', 'external'])
})

test('SAM detail accepts the alternate set-aside fields returned by SAM records', () => {
  assert.equal(normalizeSAMOpportunityDetail({ setAsideDescription: 'Total Small Business Set-Aside' }).setAside, 'Total Small Business Set-Aside')
  assert.equal(normalizeSAMOpportunityDetail({ setAside: 'SBA' }).setAside, 'SBA')
})

test('SAM detail omits API self links and an unresolved description endpoint', () => {
  const detail = normalizeSAMOpportunityDetail({
    noticeId: 'abc',
    description: 'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc',
    additionalInfoLink: 'https://api.sam.gov/prod/opportunities/v2/search?noticeid=abc',
    links: [
      { href: 'https://api.sam.gov/prod/opportunities/v2/search?noticeid=abc', label: 'API' },
      { href: 'https://piee.eb.mil/sol', label: 'PIEE' },
    ],
  })
  assert.equal(detail.description, '')
  assert.deepEqual(detail.links, [{
    url: 'https://piee.eb.mil/sol', label: 'PIEE', source: 'links',
    resourceType: 'opportunity_portal', resourceTypeLabel: 'Opportunity portal', retrievalEligible: false,
  }])
})
