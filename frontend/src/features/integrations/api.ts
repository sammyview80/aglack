/**
 * Client for rust_gateway's integrations routes (see
 * `rust_gateway/src/integrations/route.rs`). Envelope responses
 * (`{ok,data}` / `{ok:false,error}`) go through `apiFetch`, same as
 * `features/workspace/api.ts` — never the wrapper's own base URL,
 * matching frontend/AGENTS.md rule #2's existing pattern for every other
 * gateway-proxied feature.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'
import type {
  CatalogProvider,
  ConnectionStatus,
  IntegrationConnection,
  ProviderSummary,
} from '@/features/integrations/types'

type ProviderSummaryApiData = {
  id: string
  name: string
  icon: string | null
  description: string | null
  oauth_available: boolean
}

/** `GET /integrations/providers` — not workspace-scoped, same catalog for
 * every workspace. Never hardcode this list (frontend/AGENTS.md rule #2). */
export async function fetchProviders(): Promise<ProviderSummary[]> {
  const data = await apiFetch<ProviderSummaryApiData[]>(gatewayUrl(), '/integrations/providers')
  return data.map((provider) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    description: provider.description,
    oauthAvailable: provider.oauth_available,
  }))
}

type CatalogProviderApiData = {
  service: string
  display_name: string
  categories: string[]
  auth_types: string[]
  homepage_url: string | null
}

type CatalogListApiData = {
  providers: CatalogProviderApiData[]
  total: number
  limit: number
  offset: number
}

export type CatalogListResult = {
  providers: CatalogProvider[]
  total: number
  limit: number
  offset: number
}

/**
 * `GET /integrations/catalog?search=&limit=&offset=` — not workspace-scoped.
 * OpenConnector's full catalog (see `rust_gateway/src/integrations/catalog.rs`).
 * Omit `limit`/`offset` for the gateway defaults (echoed back, `limit`
 * capped server-side). `search` is a case-insensitive substring match on
 * `service` or `display_name`. Query string built the same way as
 * `listWorkspaces` — a param is left out entirely when undefined.
 */
export async function fetchCatalog(params: {
  search?: string
  limit?: number
  offset?: number
}): Promise<CatalogListResult> {
  const query = new URLSearchParams()
  if (params.search !== undefined) query.set('search', params.search)
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  const suffix = query.size > 0 ? `?${query}` : ''
  const data = await apiFetch<CatalogListApiData>(gatewayUrl(), `/integrations/catalog${suffix}`)
  return {
    providers: data.providers.map((provider) => ({
      service: provider.service,
      displayName: provider.display_name,
      categories: provider.categories,
      authTypes: provider.auth_types,
      homepageUrl: provider.homepage_url,
    })),
    total: data.total,
    limit: data.limit,
    offset: data.offset,
  }
}

type IntegrationConnectionApiData = {
  provider_id: string
  status: ConnectionStatus
  account_label: string | null
  last_error: string | null
}

/** `GET /workspaces/:id/integrations` */
export async function fetchIntegrations(workspaceId: string): Promise<IntegrationConnection[]> {
  const data = await apiFetch<IntegrationConnectionApiData[]>(
    gatewayUrl(),
    `/workspaces/${workspaceId}/integrations`,
  )
  return data.map((connection) => ({
    providerId: connection.provider_id,
    status: connection.status,
    accountLabel: connection.account_label,
    lastError: connection.last_error,
  }))
}

/**
 * `POST /workspaces/:id/integrations/:provider/connect` — the `api_key`
 * fallback path, used only when `ProviderSummary.oauthAvailable` is
 * false for this provider (see `startOAuthConnect` below for the
 * one-click path, and `components/provider-card.tsx` for the choice).
 */
export async function connectIntegration(
  workspaceId: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  await apiFetch(gatewayUrl(), `/workspaces/${workspaceId}/integrations/${providerId}/connect`, {
    method: 'POST',
    body: JSON.stringify({ api_key: apiKey }),
  })
}

/**
 * `POST /workspaces/:id/integrations/catalog/:service/connect` — `api_key`
 * connect for a FULL-catalog service (`CatalogProvider.service`), not a
 * curated provider id. Same body as `connectIntegration`. A `:service`
 * that collides with a curated `providers.yaml` id is rejected with
 * `provider_id_conflicts_with_curated_entry` (409) — use the curated route.
 */
export async function connectCatalogProvider(
  workspaceId: string,
  service: string,
  apiKey: string,
): Promise<void> {
  await apiFetch(
    gatewayUrl(),
    `/workspaces/${workspaceId}/integrations/catalog/${encodeURIComponent(service)}/connect`,
    {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey }),
    },
  )
}

/**
 * `POST /workspaces/:id/integrations/:provider/oauth/start` — the
 * one-click path. Returns a real provider `authorizationUrl` to open in a
 * popup; the popup navigates provider -> gateway's own `/oauth/callback`
 * -> back to OpenConnector, and this call site never learns when that
 * finishes — see `hooks/use-integrations.ts`'s `useIntegrations` polling
 * and `rust_gateway/src/integrations/route.rs`'s `list_integrations_route`
 * doc comment for why completion is detected by polling, not a callback.
 */
export async function startOAuthConnect(workspaceId: string, providerId: string): Promise<string> {
  const data = await apiFetch<{ authorization_url: string }>(
    gatewayUrl(),
    `/workspaces/${workspaceId}/integrations/${providerId}/oauth/start`,
    { method: 'POST' },
  )
  return data.authorization_url
}

/** `DELETE /workspaces/:id/integrations/:provider` */
export async function disconnectIntegration(workspaceId: string, providerId: string): Promise<void> {
  await apiFetch(gatewayUrl(), `/workspaces/${workspaceId}/integrations/${providerId}`, {
    method: 'DELETE',
  })
}

/** `PUT /workspaces/:id/integrations/agents/:agent` — forwarded verbatim
 * by the gateway to that workspace's real wrapper (see
 * `rust_gateway/src/integrations/route.rs`'s `put_integration_agent_route`),
 * so this reuses the SAME envelope, not a second response shape. */
export async function setAgentIntegrationEnabled(
  workspaceId: string,
  agentSlug: string,
  enabled: boolean,
): Promise<void> {
  await apiFetch(gatewayUrl(), `/workspaces/${workspaceId}/integrations/agents/${agentSlug}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}

type AgentEnablementApiData = {
  agent_slug: string
  enabled: boolean
}

/** `GET /workspaces/:id/integrations/agents` — current per-agent toggle
 * state, so the page can restore switches after a reload instead of
 * defaulting every one to off. Returns a lookup keyed by agent slug. */
export async function fetchAgentIntegrationEnablement(
  workspaceId: string,
): Promise<Record<string, boolean>> {
  const data = await apiFetch<AgentEnablementApiData[]>(
    gatewayUrl(),
    `/workspaces/${workspaceId}/integrations/agents`,
  )
  return Object.fromEntries(data.map((row) => [row.agent_slug, row.enabled]))
}
