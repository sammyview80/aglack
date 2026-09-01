/**
 * Feature-facing onboarding types. Wire JSON is snake_case; api.ts remaps
 * to camelCase here (same pattern as features/workspace).
 */

export type ProviderModel = {
  id: string
  label: string
}

export type ProviderCatalogEntry = {
  id: string
  label: string
  envVar: string
  defaultModel: string
  defaultBaseUrl: string
  requiresBaseUrl: boolean
  keyOptional: boolean
  models: ProviderModel[]
  category: string
  quick: boolean
  oauthProvider?: string | null
  oauthLabel?: string | null
}

export type ProviderCategory = {
  id: string
  label: string
  providers: string[]
}

export type OnboardingCurrent = {
  provider: string
  model: string
  baseUrl: string
}

export type OnboardingSetup = {
  providers: ProviderCatalogEntry[]
  categories: ProviderCategory[]
  unsupportedNote?: string
  currentIsOauth?: boolean
  current?: OnboardingCurrent | null
}

export type OnboardingStatus = {
  completed: boolean
  settings: Record<string, unknown>
  system: Record<string, unknown>
  setup: OnboardingSetup
  workspaces: Record<string, unknown>
  models: unknown
}

export type SetupNeedsConfirm = {
  error: string
  message: string
  requiresConfirm: true
}

export type ApplySetupInput = {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  confirmOverwrite?: boolean
}

export type SelfHostedSetupInput = {
  provider: string
  model: string
  apiKey?: string
  baseUrl?: string
  activate?: boolean
}

export type SelfHostedSetupResult = {
  ok: boolean
  provider: string
  baseUrl: string
  model?: string
}

export type ProbeProviderInput = {
  provider?: string
  baseUrl: string
  apiKey?: string
}

export type ProbeResult = {
  ok: boolean
  models?: ProviderModel[]
  error?: string
  detail?: string
}

export type OAuthFlow = {
  flowId: string
  status: string
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  provider?: string
}

export function isSetupNeedsConfirm(
  data: OnboardingStatus | SetupNeedsConfirm,
): data is SetupNeedsConfirm {
  return (
    'requiresConfirm' in data && data.requiresConfirm === true && data.error === 'config_exists'
  )
}
