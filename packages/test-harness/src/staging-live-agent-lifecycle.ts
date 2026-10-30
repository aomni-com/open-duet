import { runAgentLifecycleAcceptance, type AgentLifecycleEvidence } from './staging-live-agents.ts'
import { runWorkspaceBrowserJourney } from './staging-live-workspace-browser.ts'

/**
 * The agent lifecycle as its own journey: register, attribute a session, fire the
 * agent while that session runs, and prove what firing actually took with it.
 *
 * The same legs run inside the full staging probe. They are reachable alone
 * because the thing they now assert — that firing an agent deletes its folder,
 * and the app registered inside it with it — is a claim about real filesystem
 * state on a real VM, and a claim like that is worth checking after a change
 * without paying an hour for the whole suite.
 */
export async function runAgentLifecycleJourney(args: {
  onProgress?: (stage: string) => void
}): Promise<AgentLifecycleEvidence> {
  const result = await runWorkspaceBrowserJourney({
    journey: 'agent-lifecycle',
    label: 'Agent lifecycle',
    entitlement: 'synthetic-subscription',
    ...(args.onProgress === undefined ? {} : { onProgress: args.onProgress }),
    run: async context =>
      await runAgentLifecycleAcceptance({
        env: context.env,
        login: { token: context.apiToken },
        workspace: context.workspace,
        runId: context.runId,
        ledger: context.ledger,
        convex: context.convex,
        artifacts: context.artifacts,
        progress: context.progress,
      }),
  })
  return result.evidence
}
