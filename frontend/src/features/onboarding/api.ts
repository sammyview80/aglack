/**
 * Client for rust_gateway's per-workspace onboarding proxy
 * (`ANY /workspaces/:id/onboarding/*` — see
 * rust_gateway/src/workspaces/onboarding_proxy.rs). The gateway checks the
 * id (exists + status === ready) then forwards to that workspace's
 * wrapper. Envelope parsing is apiFetch — same helper as POST /workspaces.
 *
 * Base URL comes from VITE_GATEWAY_URL via lib/env.ts. Do not call the
 * wrapper's own base URL from this feature.
 */
import { apiFetch } from '@/lib/api'
import { gatewayUrl } from '@/lib/env'
import type {
  ApplySetupInput,
  OAuthFlow,
  OnboardingStatus,
  ProbeProviderInput,
  ProbeResult,
  ProviderCatalogEntry,
  ProviderModel,
  SelfHostedSetupInput,
  SelfHostedSetupResult,
  SetupNeedsConfirm,
} from '@/features/onboarding/types'

type WireProvider = {
  id: string
  label: string
  env_var?: string
  default_model?: string
  default_base_url?: string
  requires_base_url?: boolean
  key_optional?: boolean
  models?: ProviderModel[]
  category?: string
  quick?: boolean
  oauth_provider?: string | null
  oauth_label?: string | null
}

type WireStatus = {
  completed: boolean
  settings: Record<string, unknown>
  system: Record<string, unknown>
  setup: {
    providers?: WireProvider[]
    categories?: { id: string; label: string; providers: string[] }[]
    unsupported_note?: string
    current_is_oauth?: boolean
    current?: { provider: string; model: string; base_url: string } | null
  }
  workspaces: Record<string, unknown>
  models: unknown
}

type WireConfirm = {
  error: string
  message: string
  requires_confirm: true
}

type WireSelfHosted = {
  ok: boolean
  provider: string
  base_url: string
  model?: string
}

type WireProbe = {
  ok: boolean
  models?: ProviderModel[]
  error?: string
  detail?: string
}

type WireOAuth = {
  flow_id: string
  status: string
  user_code?: string
  verification_uri?: string
  verification_uri_complete?: string
  provider?: string
}

function onboardingPath(workspaceId: string, path: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/onboarding/${path}`
}

function mapProvider(row: WireProvider): ProviderCatalogEntry {
  return {
    id: row.id,
    label: row.label,
    envVar: row.env_var ?? '',
    defaultModel: row.default_model ?? '',
    defaultBaseUrl: row.default_base_url ?? '',
    requiresBaseUrl: Boolean(row.requires_base_url),
    keyOptional: Boolean(row.key_optional),
    models: row.models ?? [],
    category: row.category ?? '',
    quick: Boolean(row.quick),
    oauthProvider: row.oauth_provider || null,
    oauthLabel: row.oauth_label || null,
  }
}

function mapStatus(data: WireStatus): OnboardingStatus {
  const current = data.setup?.current
  return {
    completed: data.completed,
    settings: data.settings,
    system: data.system,
    setup: {
      providers: (data.setup?.providers ?? []).map(mapProvider),
      categories: data.setup?.categories ?? [],
      unsupportedNote: data.setup?.unsupported_note,
      currentIsOauth: data.setup?.current_is_oauth,
      current: current
        ? {
            provider: current.provider,
            model: current.model,
            baseUrl: current.base_url,
          }
        : current,
    },
    workspaces: data.workspaces,
    models: data.models,
  }
}

function isWireConfirm(data: unknown): data is WireConfirm {
  if (typeof data !== 'object' || data === null) return false
  const row = data as Record<string, unknown>
  return row.error === 'config_exists' && row.requires_confirm === true
}

function mapOAuth(data: WireOAuth): OAuthFlow {
  return {
    flowId: data.flow_id,
    status: data.status,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    provider: data.provider,
  }
}

export async function getOnboardingStatus(workspaceId: string): Promise<OnboardingStatus> {
  const data = await apiFetch<WireStatus>(gatewayUrl(), onboardingPath(workspaceId, 'status'))
  return mapStatus(data)
}

export async function applyOnboardingSetup(
  workspaceId: string,
  input: ApplySetupInput,
): Promise<OnboardingStatus | SetupNeedsConfirm> {
  const data = await apiFetch<WireStatus | WireConfirm>(
    gatewayUrl(),
    onboardingPath(workspaceId, 'setup'),
    {
      method: 'POST',
      body: JSON.stringify({
        provider: input.provider,
        model: input.model,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        confirm_overwrite: input.confirmOverwrite,
      }),
    },
  )
  if (isWireConfirm(data)) {
    return {
      error: data.error,
      message: data.message,
      requiresConfirm: true,
    }
  }
  return mapStatus(data)
}

export async function applySelfHostedSetup(
  workspaceId: string,
  input: SelfHostedSetupInput,
): Promise<SelfHostedSetupResult> {
  const data = await apiFetch<WireSelfHosted>(
    gatewayUrl(),
    onboardingPath(workspaceId, 'setup/self-hosted'),
    {
      method: 'POST',
      body: JSON.stringify({
        provider: input.provider,
        model: input.model,
        api_key: input.apiKey,
        base_url: input.baseUrl,
        activate: input.activate,
      }),
    },
  )
  return {
    ok: data.ok,
    provider: data.provider,
    baseUrl: data.base_url,
    model: data.model,
  }
}

export async function completeOnboarding(workspaceId: string): Promise<OnboardingStatus> {
  const data = await apiFetch<WireStatus>(gatewayUrl(), onboardingPath(workspaceId, 'complete'), {
    method: 'POST',
  })
  return mapStatus(data)
}

export async function probeProvider(
  workspaceId: string,
  input: ProbeProviderInput,
): Promise<ProbeResult> {
  return apiFetch<WireProbe>(gatewayUrl(), onboardingPath(workspaceId, 'probe'), {
    method: 'POST',
    body: JSON.stringify({
      provider: input.provider,
      base_url: input.baseUrl,
      api_key: input.apiKey,
    }),
  })
}

export async function startOAuthFlow(workspaceId: string, provider: string): Promise<OAuthFlow> {
  const data = await apiFetch<WireOAuth>(gatewayUrl(), onboardingPath(workspaceId, 'oauth/start'), {
    method: 'POST',
    body: JSON.stringify({ provider }),
  })
  return mapOAuth(data)
}

export async function pollOAuthFlow(workspaceId: string, flowId: string): Promise<OAuthFlow> {
  const q = new URLSearchParams({ flow_id: flowId })
  const data = await apiFetch<WireOAuth>(
    gatewayUrl(),
    `${onboardingPath(workspaceId, 'oauth/poll')}?${q}`,
  )
  return mapOAuth(data)
}

export async function cancelOAuthFlow(
  workspaceId: string,
  flowId: string,
  provider?: string,
): Promise<OAuthFlow> {
  const data = await apiFetch<WireOAuth>(gatewayUrl(), onboardingPath(workspaceId, 'oauth/cancel'), {
    method: 'POST',
    body: JSON.stringify({ flow_id: flowId, provider }),
  })
  return mapOAuth(data)
}
