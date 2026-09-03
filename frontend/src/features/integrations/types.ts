/** camelCase DTOs for rust_gateway's integrations routes
 * (`GET /integrations/providers`, `GET/POST/DELETE /workspaces/:id/integrations`,
 * `POST /workspaces/:id/integrations/:provider/oauth/start`,
 * `PUT /workspaces/:id/integrations/agents/:agent`). See `api.ts` for the
 * snake_case -> camelCase remap.
 *
 * Two connect paths coexist, chosen per provider by `oauthAvailable`
 * (never hardcoded on this side — frontend/AGENTS.md rule #2): OAuth
 * popup (`OAuthConnectButton`) when the gateway reports credentials are
 * configured for that provider, `api_key` box (`ConnectDialog`) as
 * fallback otherwise. See `components/provider-card.tsx` for the choice. */

export type ProviderSummary = {
  id: string
  name: string
  icon: string | null
  description: string | null
  oauthAvailable: boolean
}

/** One row of OpenConnector's FULL catalog (`GET /integrations/catalog`,
 * ~1451 entries, searchable + paged) — distinct from `ProviderSummary`,
 * which is the small curated `providers.yaml` list. `service` is the raw
 * OpenConnector service id and doubles as the connection's `providerId`
 * once connected via `POST .../integrations/catalog/:service/connect`. */
export type CatalogProvider = {
  service: string
  displayName: string
  categories: string[]
  authTypes: string[]
  homepageUrl: string | null
}

export type ConnectionStatus = 'pending' | 'connected' | 'needs_reauth' | 'disconnected' | 'error'

export type IntegrationConnection = {
  providerId: string
  status: ConnectionStatus
  accountLabel: string | null
  lastError: string | null
}
