import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSAMOpportunityDetail, samDescriptionText, samOrganizationHierarchy } from '../src/lib/samOpportunityDetail.js'
import { samArchiveInputForDiscoveryRow } from '../src/handlers/sam.js'

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
    { url: 'https://www.fedconnect.net/FedConnect/?doc=ABC', label: 'FedConnect notice', source: 'additionalInfoLink' },
    { url: 'https://piee.eb.mil/sol/notice/123', label: 'Agency PIEE package', source: 'links' },
    { url: 'https://procurement.example.gov/notices/123', label: 'procurement.example.gov', source: 'links' },
  ])
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
  assert.deepEqual(detail.links, [{ url: 'https://piee.eb.mil/sol', label: 'PIEE', source: 'links' }])
})
