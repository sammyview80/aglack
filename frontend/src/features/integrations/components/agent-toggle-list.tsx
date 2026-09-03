import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAgents } from '@/features/agent-history/hooks/use-agent-history'
import {
  useAgentIntegrationEnablement,
  useSetAgentIntegrationEnabled,
} from '@/features/integrations/hooks/use-agent-integrations'
import { integrationsUi } from '@/features/integrations/integrations-ui'

/**
 * One switch per agent in this workspace, wired straight to
 * `PUT /workspaces/:id/integrations/agents/:agent` (see
 * `docs/integrations-plan.md`'s "Enable/disable per agent" section) —
 * connecting a provider does NOT turn its tools on for any agent by
 * itself, this list is the only thing that does.
 */
export function AgentToggleList({ workspaceId }: { workspaceId: string }) {
  const agentsQuery = useAgents(workspaceId, true)
  const enablementQuery = useAgentIntegrationEnablement(workspaceId)
  const setEnabled = useSetAgentIntegrationEnabled(workspaceId)

  const agents = agentsQuery.data?.agents ?? []
  const enablement = enablementQuery.data ?? {}

  if (agents.length === 0) return null

  return (
    <section className={integrationsUi.agents}>
      <div className={integrationsUi.agentsHead}>
        <div>
          <h3 className={integrationsUi.agentsTitle}>Enable per agent</h3>
          <p className={integrationsUi.agentsHint}>Installed plugins stay off until an agent is allowed to use them.</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col">
        {agents.map((agent) => (
          <div key={agent.name} className={integrationsUi.agentRow}>
            <Label htmlFor={`agent-integrations-${agent.name}`} className="text-sm capitalize text-[var(--th-text)]">
              {agent.name}
            </Label>
            <Switch
              id={`agent-integrations-${agent.name}`}
              checked={Boolean(enablement[agent.name])}
              className={cn(integrationsUi.switch)}
              disabled={setEnabled.isPending}
              onCheckedChange={(checked) =>
                setEnabled.mutate({ agentSlug: agent.name, enabled: checked })
              }
            />
          </div>
        ))}
      </div>
    </section>
  )
}
