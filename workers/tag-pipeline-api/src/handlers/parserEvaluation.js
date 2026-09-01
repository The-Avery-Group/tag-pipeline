import {
  createParserEvaluationRun,
  getParserEvaluationReport,
  parserEvaluationAccess,
  parserEvaluationStorageReady,
  reviewParserEvaluationDocument,
} from '../lib/parserEvaluation.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function handleParserEvaluation(req, env, identity) {
  const url = new URL(req.url)
  const access = parserEvaluationAccess(identity, env)
  if (url.pathname === '/parser-evaluation/access' && req.method === 'GET') {
    return json({ ...access, ready: access.allowed && await parserEvaluationStorageReady(env.EBUY_DB) })
  }
  if (!access.allowed) {
    return json({
      error: access.configured ? 'You do not have access to parser evaluation.' : 'Parser-evaluation access has not been configured.',
      code: access.configured ? 'parser_evaluation_forbidden' : 'parser_evaluation_access_not_configured',
    }, 403)
  }
  if (!env.EBUY_DB || !(await parserEvaluationStorageReady(env.EBUY_DB))) {
    return json({ error: 'Apply the parser-evaluation D1 migration.', code: 'migration_required' }, 503)
  }
  try {
    if (url.pathname === '/parser-evaluation/runs' && req.method === 'POST') {
      return json(await createParserEvaluationRun(env, identity, await req.json().catch(() => ({}))), 202)
    }
    if (url.pathname === '/parser-evaluation/report' && req.method === 'GET') {
      return json(await getParserEvaluationReport(env, url.searchParams.get('runId') || ''))
    }
    const review = url.pathname.match(/^\/parser-evaluation\/documents\/([^/]+)\/review$/)
    if (review && req.method === 'POST') {
      await reviewParserEvaluationDocument(env, decodeURIComponent(review[1]), await req.json().catch(() => ({})), identity)
      return json({ ok: true })
    }
    return json({ error: 'Parser-evaluation route not found' }, 404)
  } catch (error) {
    return json({ error: error.message, code: error.code || '' }, error.status || 500)
  }
}
