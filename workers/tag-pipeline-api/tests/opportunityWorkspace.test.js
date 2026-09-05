import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agencyAbbreviation,
  organizationFolderKey,
  opportunityWorkspaceFolderName,
  safeSharePointSegment,
  workspaceCalendarYear,
} from '../src/lib/opportunityWorkspaceDomain.js'
import { resetWorkspaceForRebuild } from '../src/lib/opportunityWorkspaceRepository.js'
import { opportunityUploadValidation, workspaceSplitPlan } from '../src/lib/opportunityWorkspaceSharePoint.js'
import {
  attachmentSourceName,
  discoverPortalAttachments,
  fetchSAMAttachment,
  fetchWorkspaceSAMNotice,
  isSupportedPortalOpportunityUrl,
  portalAttachmentsFromHtml,
  portalSourceMetadata,
  portalSourceScope,
  stablePortalSourceSignature,
} from '../src/lib/opportunityWorkspaceSam.js'

test('opportunity workspace uses known agency abbreviations and a safe title', () => {
  assert.equal(agencyAbbreviation('Department of Defense Education Activity'), 'DODEA')
  assert.equal(
    opportunityWorkspaceFolderName({ agency: 'Department of Defense Education Activity', title: 'Esports: Program / Support?' }),
    'DODEA_Esports_ Program _ Support_',
  )
})

test('organization folders match SAM and eBuy word-order variations', () => {
  assert.equal(
    organizationFolderKey('STATE, DEPARTMENT OF'),
    organizationFolderKey('Department of State'),
  )
  assert.equal(
    organizationFolderKey('Centers for Disease Control and Prevention (CDC)'),
    organizationFolderKey('CDC'),
  )
  assert.equal(
    organizationFolderKey('DEPT OF DEFENSE'),
    organizationFolderKey('Department of Defense'),
  )
  assert.equal(organizationFolderKey('DOW'), organizationFolderKey('Department of Defense'))
  assert.equal(organizationFolderKey('ARMY'), organizationFolderKey('Department of the Army'))
})

test('SharePoint folder segments remove reserved characters and trailing periods', () => {
  assert.equal(safeSharePointSegment('Office #4 / Capture. '), 'Office _4 _ Capture')
})

test('workspace year uses the supplied calendar year rather than a fiscal-year calculation', () => {
  assert.equal(workspaceCalendarYear(2026, new Date('2025-10-01T00:00:00Z')), 2026)
  assert.equal(workspaceCalendarYear('', new Date('2026-06-30T12:00:00Z')), 2026)
})

test('workspace rebuild clears stale SharePoint and attachment metadata together', async () => {
  const batched = []
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this },
        async first() {
          return {
            opportunity_key: 'notice-1', pipeline_id: 'notice-1', notice_id: '', solicitation_number: '',
            title: 'Test', department: '', agency: '', notice_type: 'RFI', calendar_year: 2026,
            status: 'new', progress_phase: 'Ready to rebuild', attachment_total: 0,
            archived_count: 0, failed_count: 0, created_at: '', updated_at: '', completed_at: null,
          }
        },
      }
    },
    async batch(statements) { batched.push(...statements) },
  }

  const result = await resetWorkspaceForRebuild(db, 'NOTICE-1')
  assert.equal(batched.length, 2)
  assert.match(batched[0].sql, /DELETE FROM opportunity_workspace_files/)
  assert.match(batched[1].sql, /root_folder_id = NULL/)
  assert.equal(result.status, 'new')
  assert.equal(result.rootFolderId, undefined)
})

test('opportunity reference uploads sanitize names and reject executable files', () => {
  assert.deepEqual(opportunityUploadValidation('Research #1.pdf', 1024), {
    valid: true,
    name: 'Research _1.pdf',
    size: 1024,
  })
  assert.equal(opportunityUploadValidation('run.cmd', 10).valid, false)
  assert.equal(opportunityUploadValidation('empty.docx', 0).valid, false)
})

test('workspace split restores the original root owner and detaches the other notice type', () => {
  const rfi = {
    opportunityKey: 'RFI-1', agency: 'Department of Veterans Affairs', title: 'Health Support',
    typeFolderId: 'rfi-folder', samFolderId: 'rfi-documents',
  }
  const rfp = {
    opportunityKey: 'RFP-1', agency: 'Department of Veterans Affairs', title: 'Health Support Follow-on',
    typeFolderId: 'rfp-folder', samFolderId: 'rfp-documents',
  }
  const plan = workspaceSplitPlan({ folder: {}, name: 'VA_Health Support' }, [rfi, rfp])
  assert.equal(plan.owner.opportunityKey, 'RFI-1')
  assert.equal(plan.detached.opportunityKey, 'RFP-1')
})

test('workspace split refuses indistinguishable same-type folders', () => {
  assert.throws(() => workspaceSplitPlan({ folder: {}, name: 'Shared' }, [
    { opportunityKey: 'RFI-1', typeFolderId: 'same-folder' },
    { opportunityKey: 'RFI-2', typeFolderId: 'same-folder' },
  ]), /same notice-type folder/)
})

test('only recognized FedConnect and PIEE opportunity pages are expanded', () => {
  assert.equal(isSupportedPortalOpportunityUrl('https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'), true)
  assert.equal(isSupportedPortalOpportunityUrl('http://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'), false)
  assert.equal(isSupportedPortalOpportunityUrl('https://www.fedconnect.net/FedConnect/Help/default.htm'), false)
  assert.equal(isSupportedPortalOpportunityUrl('https://piee.eb.mil/sol/xhtml/unauth/search/oppMgmtLink.xhtml?noticeId=ABC&noticeType=SolicitationNotice'), true)
  assert.equal(isSupportedPortalOpportunityUrl('https://piee.eb.mil/piee-landing/'), false)
})

test('portal attachment metadata cannot claim a different provider than its host', () => {
  const source = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE#tag-portal-file=provider%3Dpiee%26id%3Dfile-1%26name%3DSOW.pdf'
  assert.equal(portalSourceMetadata(source), null)
})

test('FedConnect public document postbacks become stable archive sources', () => {
  const portal = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'
  const html = `<a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)"><img alt=""></a>
    <a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)">Statement of Work</a>`
  const sources = portalAttachmentsFromHtml(portal, html)
  assert.equal(sources.length, 1)
  const metadata = portalSourceMetadata(sources[0])
  assert.equal(metadata.provider, 'fedconnect')
  assert.equal(metadata.target, 'AttachmentTree')
  assert.equal(metadata.id, 'sABC\\10\\SUPPORTDOC,55')
  assert.equal(attachmentSourceName(sources[0]), 'Statement of Work')
  assert.match(stablePortalSourceSignature(sources[0]), /^fedconnect\|/)
  assert.equal(portalSourceScope(sources[0]), `fedconnect|${portal}`)
})

test('FedConnect public attachments are downloaded through the portal session', async () => {
  const originalFetch = globalThis.fetch
  const portal = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'
  const html = `<form action="/FedConnect/PublicPages/PublicSearch/Public_OpportunitySummary.aspx?doc=ABC">
    <input type="hidden" name="__VIEWSTATE" value="state">
    <input type="hidden" name="__EVENTVALIDATION" value="validation">
    <a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)">Statement of Work</a>
  </form>`
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if ((options.method || 'GET') === 'POST') {
      return new Response('%PDF-test', {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="SOW.pdf"' },
      })
    }
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'ASP.NET_SessionId=session; Path=/; Secure' },
    })
  }

  try {
    const [source] = await discoverPortalAttachments(portal)
    const attachment = await fetchSAMAttachment({}, source)
    assert.match(attachment.fileName, /^Statement of Work - [a-f0-9]{12}\.pdf$/)
    assert.match(attachment.sourceSignature, /^fedconnect\|/)
    assert.equal(requests.length, 3)
    const posted = requests.at(-1)
    assert.equal(posted.options.method, 'POST')
    assert.match(posted.options.headers.Cookie, /ASP\.NET_SessionId=session/)
    assert.match(String(posted.options.body), /__EVENTTARGET=AttachmentTree/)
    assert.match(String(posted.options.body), /SUPPORTDOC%2C55/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('PIEE public JSF attachment actions are enumerated and downloaded', async () => {
  const originalFetch = globalThis.fetch
  const portal = 'https://piee.eb.mil/sol/xhtml/unauth/search/oppMgmtLink.xhtml?noticeId=ABC&noticeType=SolicitationNotice'
  const html = `<form id="noticeForm" action="/sol/xhtml/unauth/search/viewPublicNotice.xhtml">
    <input type="hidden" name="javax.faces.ViewState" value="view-state">
    <a id="noticeForm:attachments:0:file" href="#" onclick="mojarra.jsfcljs(document.getElementById('noticeForm'),{'noticeForm:attachments:0:file':'noticeForm:attachments:0:file'},'');return false;">Performance_Work_Statement.pdf</a>
  </form>`
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if ((options.method || 'GET') === 'POST') {
      return new Response('%PDF-piee', { status: 200, headers: { 'Content-Type': 'application/pdf' } })
    }
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'JSESSIONID=piee-session; Path=/; Secure' },
    })
  }

  try {
    const [source] = await discoverPortalAttachments(portal)
    assert.equal(attachmentSourceName(source), 'Performance_Work_Statement.pdf')
    const attachment = await fetchSAMAttachment({}, source)
    assert.match(attachment.fileName, /^Performance_Work_Statement - [a-f0-9]{12}\.pdf$/)
    const posted = requests.at(-1)
    assert.equal(posted.options.method, 'POST')
    assert.match(posted.options.headers.Cookie, /JSESSIONID=piee-session/)
    assert.match(String(posted.options.body), /javax\.faces\.ViewState=view-state/)
    assert.match(String(posted.options.body), /noticeForm%3Aattachments%3A0%3Afile/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a portal listing failure remains visible without inventing files', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('connection unavailable') }
  try {
    const [source] = await discoverPortalAttachments('https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE')
    assert.equal(portalSourceMetadata(source).issue, true)
    assert.equal(attachmentSourceName(source), 'FedConnect opportunity documents')
    await assert.rejects(() => fetchSAMAttachment({}, source), /could not be retrieved/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('portal attachment downloads reject redirects outside the approved provider', async () => {
  const originalFetch = globalThis.fetch
  const portal = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'
  const [source] = portalAttachmentsFromHtml(portal,
    `<a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)">SOW.pdf</a>`)
  globalThis.fetch = async () => new Response(null, {
    status: 302,
    headers: { Location: 'https://example.com/untrusted-file.pdf' },
  })
  try {
    await assert.rejects(() => fetchSAMAttachment({}, source), /redirected outside its approved host/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('portal attachment downloads reject an HTML page in place of a file', async () => {
  const originalFetch = globalThis.fetch
  const portal = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'
  const html = `<form><input type="hidden" name="__VIEWSTATE" value="state">
    <a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)">SOW.pdf</a></form>`
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  }
  try {
    const [source] = portalAttachmentsFromHtml(portal, html)
    await assert.rejects(() => fetchSAMAttachment({}, source), /did not return a publicly downloadable file/)
    assert.equal(requests, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a Cache API failure does not discard successfully discovered portal files', async () => {
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches
  const portal = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'
  globalThis.fetch = async () => new Response(
    `<form><a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)">Statement of Work</a></form>`,
    { headers: { 'Content-Type': 'text/html' } },
  )
  globalThis.caches = { default: {
    async match() { throw new Error('cache unavailable') },
    async put() { throw new Error('cache unavailable') },
  } }
  try {
    const sources = await discoverPortalAttachments(portal)
    assert.equal(sources.length, 1)
    assert.equal(attachmentSourceName(sources[0]), 'Statement of Work')
  } finally {
    globalThis.fetch = originalFetch
    if (originalCaches === undefined) delete globalThis.caches
    else globalThis.caches = originalCaches
  }
})

test('SAM workspace discovery expands an authoritative FedConnect opportunity link', async () => {
  const originalFetch = globalThis.fetch
  const portal = 'https://www.fedconnect.net/FedConnect/?doc=ABC&agency=DOE'
  globalThis.fetch = async (url) => {
    const value = url instanceof Request ? url.url : String(url)
    if (value.includes('api.sam.gov/opportunities/v2/search')) {
      return Response.json({ opportunitiesData: [{ noticeId: 'notice-1', additionalInfoLink: portal, resourceLinks: [] }] })
    }
    if (value.includes('sam.gov/api/prod/opps/v3/opportunities/notice-1/resources')) {
      return Response.json({ resources: [] })
    }
    if (value.startsWith('https://www.fedconnect.net/')) {
      return new Response(`<form><a href="javascript:__doPostBack(&#39;AttachmentTree&#39;,&#39;sABC\\\\10\\\\SUPPORTDOC,55&#39;)">Statement of Work</a></form>`, {
        headers: { 'Content-Type': 'text/html' },
      })
    }
    throw new Error(`Unexpected URL: ${value}`)
  }

  try {
    const notice = await fetchWorkspaceSAMNotice({ SAM_API_KEY: 'test-key' }, { noticeId: 'notice-1' })
    assert.equal(notice.resourceLinks.length, 1)
    assert.equal(attachmentSourceName(notice.resourceLinks[0]), 'Statement of Work')
  } finally {
    globalThis.fetch = originalFetch
  }
})
