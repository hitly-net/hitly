/**
 * Interim per-factory HITLy connection settings (hitly-net/hitly#211).
 *
 * Until upstream ships a Connections extension point, the plugin serves its
 * own admin surface under `/web/integrations/hitly/settings`: a
 * server-rendered page plus a small JSON API. Every route is gated
 * ensureUser → tenant → organization-admin, and NO response ever contains a
 * stored secret — API keys appear masked, webhook signing secrets are only
 * ever reported as configured-or-not.
 *
 * Like index.ts, this module MUST NOT import @mastra/*: it is loaded inside
 * the HITLy app process too. The host context arrives as `unknown` and is
 * narrowed structurally, mirroring the resume route's `rawRequestFrom`.
 */

import { HitlyConnectionRegistry, type FactoryProjectLister, type ResolvedConnection, type SaveConnectionInput } from './connections.ts'
import { HitlyClient } from './hitly-client.ts'

export const SETTINGS_BASE_PATH = '/web/integrations/hitly/settings'

/** Structural mirror of @mastra/factory's RouteAuth (kept @mastra-free). */
export interface SettingsRouteAuth {
  enabled(): boolean
  ensureUser(c: unknown): Promise<unknown>
  tenant(c: unknown): { orgId?: string; userId?: string } | undefined
  isOrganizationAdmin(c: unknown, organizationId: string): Promise<boolean>
}

export interface ConnectionTestResult {
  ok: boolean
  error?: string
}

export interface SettingsRoutesDeps {
  registry: HitlyConnectionRegistry
  /** Host auth (IntegrationContext.auth). Routes fail closed when absent. */
  auth?: SettingsRouteAuth
  /** Host project lister (IntegrationContext.storage.projects) for the connect form. */
  projects?: FactoryProjectLister
  /** Overridable so tests can prove the probe is read-only. */
  connectionTester?: (input: SaveConnectionInput) => Promise<ConnectionTestResult>
  fetchImpl?: typeof fetch
  log?(level: string, message: string, context?: Record<string, unknown>): void
}

export interface SettingsApiRoute {
  path: string
  method: 'GET' | 'POST'
  requiresAuth: boolean
  handler: (context: unknown) => Promise<Response>
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requestFrom(context: unknown): Request {
  if (context instanceof Request) return context
  const candidate = context as { req?: { raw?: unknown } } | null
  if (candidate?.req?.raw instanceof Request) return candidate.req.raw
  throw new TypeError('hitly settings: expected a Request or Hono context')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function maskSecret(value: string): string {
  if (!value) return ''
  return `••••${value.slice(-4)}`
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

interface Authorized {
  orgId: string
  userId: string
}

async function authorize(deps: SettingsRoutesDeps, c: unknown): Promise<Authorized | Response> {
  const auth = deps.auth
  if (!auth) return json(503, { error: 'hitly settings: auth unavailable on host context' })
  try {
    await auth.ensureUser(c)
  } catch {
    return json(401, { error: 'authentication required' })
  }
  const tenant = auth.tenant(c)
  if (!auth.enabled()) {
    // Local single-user development mode: everyone present is an admin.
    return { orgId: tenant?.orgId ?? 'default', userId: tenant?.userId ?? 'local' }
  }
  const orgId = tenant?.orgId
  if (!orgId) return json(401, { error: 'authentication required' })
  let admin = false
  try {
    admin = await auth.isOrganizationAdmin(c, orgId)
  } catch {
    admin = false // fail closed
  }
  if (!admin) return json(403, { error: 'organization admin required' })
  return { orgId, userId: tenant?.userId ?? 'unknown' }
}

/** Secret-free projection of a connection for the settings UI/JSON. */
function connectionView(conn: ResolvedConnection) {
  return {
    factoryProjectId: conn.factoryProjectId,
    factoryName: conn.factoryName ?? null,
    orgId: conn.orgId,
    source: conn.source,
    hitlyBaseUrl: conn.status.hitlyBaseUrl,
    hitlyProjectId: conn.status.projectId,
    apiKeyMasked: maskSecret(conn.status.hitlyApiKey),
    signingSecretsConfigured: conn.status.webhookSigningSecrets.length,
    gates: conn.config.gates,
    mergeAfterAccept: conn.status.mergeAfterAccept,
    connectedAt: conn.status.connectedAt,
    lastCallbackAt: conn.status.lastCallbackAt ?? null,
    lastError: conn.status.lastError ?? null,
  }
}

type ConnectionView = ReturnType<typeof connectionView>

async function readJsonBody(context: unknown): Promise<Record<string, unknown>> {
  const body = await requestFrom(context).json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('expected a JSON object')
  return body as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`)
  return value.trim()
}

const defaultConnectionTester =
  (deps: SettingsRoutesDeps) =>
  async (input: SaveConnectionInput): Promise<ConnectionTestResult> => {
    // Read-only probe: GET the HITLy integration config endpoint. Never POSTs,
    // never creates an approval, never touches gates.
    const client = new HitlyClient({
      hitlyBaseUrl: input.hitlyBaseUrl,
      hitlyApiKey: input.hitlyApiKey,
      projectId: input.projectId,
      fetchImpl: deps.fetchImpl,
    })
    try {
      await client.getIntegrationConfig()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function renderRow(conn: ResolvedConnection): string {
  const v = connectionView(conn)
  const label = v.factoryName ? `${escapeHtml(v.factoryName)} (${escapeHtml(v.factoryProjectId)})` : escapeHtml(v.factoryProjectId)
  const badge =
    v.source === 'env'
      ? '<span class="badge env">env fallback</span>'
      : '<span class="badge saved">connected</span>'
  const error = v.lastError ? `<span class="error">${escapeHtml(v.lastError)}</span>` : ''
  const callback = v.lastCallbackAt ? escapeHtml(v.lastCallbackAt) : '—'
  return `<tr>
<td>${label}</td>
<td>${badge}</td>
<td>${escapeHtml(v.hitlyBaseUrl)}<br><small>project ${escapeHtml(v.hitlyProjectId)} · key ${escapeHtml(v.apiKeyMasked)}</small></td>
<td>${escapeHtml(Object.entries(v.gates).filter(([, on]) => on).map(([g]) => g).join(', ') || 'none')}</td>
<td>${callback}${error ? `<br>${error}` : ''}</td>
<td><button data-fpid="${escapeHtml(v.factoryProjectId)}" class="test">Test</button>
<button data-fpid="${escapeHtml(v.factoryProjectId)}" class="disconnect">Disconnect</button></td>
</tr>`
}

function renderPage(conns: ResolvedConnection[], options: { orgProjects: Array<{ id: string; name?: string }>; envFallbackActive: boolean }): string {
  const rows = conns.length
    ? conns.map(renderRow).join('\n')
    : '<tr><td colspan="6">No HITLy connections yet.</td></tr>'
  const projectOptions = options.orgProjects.length
    ? options.orgProjects
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name ?? p.id)}</option>`)
        .join('')
    : '<option value="">enter factory project id manually</option>'
  const fallbackNote = options.envFallbackActive
    ? '<p class="badge env">Environment fallback is active for factories without a saved connection.</p>'
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>HITLy Connections</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:64rem;color:#1a1a2e}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8d8e0;padding:.5rem .65rem;text-align:left;vertical-align:top}
.badge{padding:.1rem .5rem;border-radius:.6rem;font-size:.8rem}
.badge.saved{background:#e3f4e4;color:#1c6b24}.badge.env{background:#fdf1d7;color:#8a5b00}
.error{color:#a11919;font-size:.85rem}
button{cursor:pointer;padding:.25rem .6rem;margin-right:.3rem}
form label{display:block;margin:.5rem 0 .15rem}form input{width:22rem;padding:.25rem}
#result{white-space:pre-wrap;font-family:monospace;font-size:.85rem}
</style></head><body>
<h1>HITLy connections</h1>
${fallbackNote}
<table><thead><tr><th>Factory</th><th>Status</th><th>HITLy</th><th>Gates</th><th>Last callback</th><th></th></tr></thead>
<tbody>
${rows}
</tbody></table>
<h2>Add or update a connection</h2>
<form id="connect">
<label>Factory project<select name="factoryProjectId">${projectOptions}</select></label>
<input name="factoryProjectIdText" placeholder="factory project id (if not listed)">
<label>HITLy URL<input name="hitlyBaseUrl" placeholder="https://hitly.example.com" required></label>
<label>API key<input name="hitlyApiKey" type="password" autocomplete="off" required></label>
<label>HITLy project id<input name="projectId" required></label>
<label>Webhook signing secret<input name="webhookSigningSecret" type="password" autocomplete="off" required></label>
<button type="submit">Save connection</button>
</form>
<h3>Result</h3>
<pre id="result"></pre>
<script>
const base = ${JSON.stringify(SETTINGS_BASE_PATH)};
async function post(path, body){
  const res = await fetch(base + path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  let data; try { data = await res.json() } catch { data = { ok: res.ok } }
  document.getElementById('result').textContent = (res.ok ? 'ok: ' : 'error: ') + JSON.stringify(data, null, 2);
  if (res.ok) setTimeout(() => location.reload(), 600);
}
document.querySelectorAll('button.test').forEach(b => b.addEventListener('click', () => post('/test', { factoryProjectId: b.dataset.fpid })));
document.querySelectorAll('button.disconnect').forEach(b => b.addEventListener('click', () => {
  if (confirm('Disconnect HITLy for this factory? New gates will not be created.')) post('/disconnect', { factoryProjectId: b.dataset.fpid });
}));
document.getElementById('connect').addEventListener('submit', ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  post('/connect', {
    factoryProjectId: (f.get('factoryProjectIdText') || f.get('factoryProjectId') || '').toString().trim(),
    hitlyBaseUrl: (f.get('hitlyBaseUrl') || '').toString(),
    hitlyApiKey: (f.get('hitlyApiKey') || '').toString(),
    projectId: (f.get('projectId') || '').toString(),
    webhookSigningSecret: (f.get('webhookSigningSecret') || '').toString(),
  });
});
</script>
</body></html>`
}

// ---------------------------------------------------------------------------
// route factory
// ---------------------------------------------------------------------------

export function buildSettingsRoutes(deps: SettingsRoutesDeps): SettingsApiRoute[] {
  const tester = deps.connectionTester ?? defaultConnectionTester(deps)

  const listConnections = async (orgId: string | null): Promise<{ conns: ResolvedConnection[]; orgProjects: Array<{ id: string; name?: string }> }> => {
    const all = await deps.registry.listAll()
    const conns = orgId ? all.filter((conn) => conn.orgId === orgId) : all
    let orgProjects: Array<{ id: string; name?: string }> = []
    if (orgId && deps.projects) {
      try {
        orgProjects = (await deps.projects.listAll())
          .filter((project) => project.orgId === orgId)
          .map((project) => ({ id: project.id, name: project.name }))
      } catch (error) {
        deps.log?.('warn', 'hitly settings: project list failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { conns, orgProjects }
  }

  return [
    {
      path: SETTINGS_BASE_PATH,
      method: 'GET',
      requiresAuth: false, // gated manually below — the host has no idea what this page is
      handler: async (context) => {
        const authed = await authorize(deps, context)
        if (authed instanceof Response) return authed
        const { conns, orgProjects } = await listConnections(authed.orgId)
        return html(renderPage(conns, { orgProjects, envFallbackActive: conns.some((conn) => conn.source === 'env') }))
      },
    },
    {
      path: `${SETTINGS_BASE_PATH}/api`,
      method: 'GET',
      requiresAuth: false,
      handler: async (context) => {
        const authed = await authorize(deps, context)
        if (authed instanceof Response) return authed
        const { conns } = await listConnections(authed.orgId)
        const views: ConnectionView[] = conns.map(connectionView)
        return json(200, { connections: views })
      },
    },
    {
      path: `${SETTINGS_BASE_PATH}/connect`,
      method: 'POST',
      requiresAuth: false,
      handler: async (context) => {
        const authed = await authorize(deps, context)
        if (authed instanceof Response) return authed
        try {
          const body = await readJsonBody(context)
          const factoryProjectId = requiredString(body, 'factoryProjectId')
          const saved = await deps.registry.save(authed.orgId, authed.userId, factoryProjectId, {
            hitlyBaseUrl: requiredString(body, 'hitlyBaseUrl'),
            hitlyApiKey: requiredString(body, 'hitlyApiKey'),
            projectId: requiredString(body, 'projectId'),
            webhookSigningSecret: requiredString(body, 'webhookSigningSecret'),
          })
          const conn = await deps.registry.resolve(authed.orgId, factoryProjectId)
          deps.log?.('info', 'hitly settings: connection saved', { orgId: authed.orgId, factoryProjectId })
          return json(200, { ok: true, connectedAt: saved.connectedAt, connection: conn ? connectionView(conn) : null })
        } catch (error) {
          return json(400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${SETTINGS_BASE_PATH}/disconnect`,
      method: 'POST',
      requiresAuth: false,
      handler: async (context) => {
        const authed = await authorize(deps, context)
        if (authed instanceof Response) return authed
        try {
          const body = await readJsonBody(context)
          const factoryProjectId = requiredString(body, 'factoryProjectId')
          await deps.registry.disconnect(authed.orgId, factoryProjectId)
          deps.log?.('info', 'hitly settings: connection disconnected', { orgId: authed.orgId, factoryProjectId })
          return json(200, { ok: true })
        } catch (error) {
          return json(400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: `${SETTINGS_BASE_PATH}/test`,
      method: 'POST',
      requiresAuth: false,
      handler: async (context) => {
        const authed = await authorize(deps, context)
        if (authed instanceof Response) return authed
        try {
          const body = await readJsonBody(context)
          let input: SaveConnectionInput
          if (body.hitlyBaseUrl || body.hitlyApiKey || body.projectId) {
            // Test unsaved credentials straight from the form.
            input = {
              hitlyBaseUrl: requiredString(body, 'hitlyBaseUrl'),
              hitlyApiKey: requiredString(body, 'hitlyApiKey'),
              projectId: requiredString(body, 'projectId'),
              webhookSigningSecret: '',
            }
          } else {
            const factoryProjectId = requiredString(body, 'factoryProjectId')
            const conn = await deps.registry.resolve(authed.orgId, factoryProjectId)
            if (!conn) return json(404, { error: 'no connection for this factory' })
            input = {
              hitlyBaseUrl: conn.status.hitlyBaseUrl,
              hitlyApiKey: conn.status.hitlyApiKey,
              projectId: conn.status.projectId,
              webhookSigningSecret: '',
            }
          }
          const result = await tester(input)
          return json(200, result)
        } catch (error) {
          return json(400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
