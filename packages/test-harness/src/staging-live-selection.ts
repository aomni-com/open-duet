import { runAppsLiveAcceptance } from './apps-live.ts'
import { runAgentBrowserWindowsJourney } from './staging-live-agent-browser-windows.ts'
import { runRelayRecoveryJourney } from './staging-live-agent-continuity.ts'
import { runAgentDelegationJourney } from './staging-live-agent-delegation.ts'
import { runAgentLifecycleJourney } from './staging-live-agent-lifecycle.ts'
import { runAgentNamingJourney } from './staging-live-agent-naming.ts'
import { runAgentOnboardingJourney } from './staging-live-agent-onboarding.ts'
import {
  runAgentCorrectionCompletionJourney,
  runAgentPopulatedSearchJourney,
} from './staging-live-agent-workflow.ts'
import { runAgenticOnboardingJourney } from './staging-live-agentic-onboarding.ts'
import { runAgentsThreeColumnsJourney } from './staging-live-agents-three-columns.ts'
import { runAppDomainsJourney } from './staging-live-app-domains'
import { runAppKeyExportJourney } from './staging-live-app-key-export'
import { runBillingContentionJourney } from './staging-live-billing-contention.ts'
import { runChatAttachmentsJourney } from './staging-live-chat-attachments.ts'
import { runConnectedProvidersJourney } from './staging-live-connected-providers.ts'
import { runDefaultAgentChatJourney } from './staging-live-default-agent-chat.ts'
import {
  runDriveDeepLinksJourney,
  runDrivePercentIdentitiesJourney,
} from './staging-live-drive-deep-links.ts'
import { runLiveFileRefreshJourney } from './staging-live-file-refresh.ts'
import { runFirecrawlIntegrationJourney } from './staging-live-firecrawl.ts'
import { runForegroundSessionWaitsJourney } from './staging-live-foreground-session-waits.ts'
import { runGatewayLivenessJourney } from './staging-live-gateway-liveness.ts'
import { runIntegrationAgentAccessJourney } from './staging-live-integration-agent-access.ts'
import { runLowCreditRecoveryJourney } from './staging-live-low-credit.ts'
import { runMarketplaceJourney } from './staging-live-marketplace.ts'
import { runMcpOAuthJourney } from './staging-live-mcp-oauth.ts'
import { runMcpServersJourney } from './staging-live-mcp-servers.ts'
import { runModelRefreshJourney } from './staging-live-model-refresh'
import { runOfficialAgentAppsJourney } from './staging-live-official-agent-apps.ts'
import { runOpenModelAccessJourney } from './staging-live-open-model-access'
import { runProviderModelAliasesJourney } from './staging-live-provider-model-aliases.ts'
import { runPublicFormsJourney, runPublicRoutesJourney } from './staging-live-public-journeys.ts'
import { runRetrainMemoryJourney } from './staging-live-retrain-memory.ts'
import { runSessionAppPaneJourney } from './staging-live-session-app-pane.ts'
import { runSessionBucketsJourney } from './staging-live-session-buckets.ts'
import { runSessionLineageApiJourney } from './staging-live-session-lineage-api.ts'
import { runSessionTranscriptViewJourney } from './staging-live-session-transcript-view.ts'
import { runServiceCatalogStagingJourney } from './service-catalog-staging.ts'
import { runSignupAbuseJourney } from './staging-live-signup-abuse.ts'
import { runSpecificPeopleSessionsJourney } from './staging-live-specific-people-sessions.ts'
import { runTrialRecommissionJourney } from './staging-live-trial-recommission.ts'
import { runUnifiedDuetJourney } from './staging-live-unified-duet'
import {
  runTierRestorationJourney,
  runVirtualModelTiersJourney,
} from './staging-live-virtual-model-tiers.ts'
import { runVmComputeFeesJourney } from './staging-live-vm-compute-fees.ts'
import { runWorkflowReplacementJourney } from './staging-live-workflow-replacement.ts'
import { runWorkspaceBackupJourney } from './staging-live-workspace-backup'
import { runWorkspaceInvitationsJourney } from './staging-live-workspace-invitations.ts'

export const STAGING_JOURNEYS = {
  'open-model-access': {
    fixture: 'workspace-browser',
    description:
      'Direct workspace defaults and uncatalogued CLI/MCP media with actual-cost settlement',
    run: runOpenModelAccessJourney,
  },
  'unified-duet': {
    fixture: 'workspace-browser',
    description:
      'One human credential, explicit model billing, two-machine sync and bound runtime cutover evidence',
    run: runUnifiedDuetJourney,
  },
  'app-key-export': {
    fixture: 'workspace-browser',
    description:
      'Installed CLI, served skills, managed app auth, external catalog access and independent export lifecycle',
    run: runAppKeyExportJourney,
  },
  'workflow-replacement': {
    fixture: 'workspace-browser',
    description:
      'Stop an old state worker during a steer, replace its workflow, and prove the replacement completes',
    run: runWorkflowReplacementJourney,
  },
  'app-domains': {
    fixture: 'workspace-browser',
    description:
      'One real apex binding, standalone links, standard embeds, private return, and verified cleanup',
    run: runAppDomainsJourney,
  },
  'workspace-backup': {
    fixture: 'workspace-browser',
    description:
      'Private portable backup, complete history, Settings, replacement, independent ZIP recovery and deletion',
    run: runWorkspaceBackupJourney,
  },
  'agent-correction-completion': {
    fixture: 'workspace-browser',
    description:
      'Current user correction survives a real session interruption and completes a scoped local release',
    run: runAgentCorrectionCompletionJourney,
  },
  'agent-populated-search': {
    fixture: 'workspace-browser',
    description:
      'Agent-built People and Jobs search returns real populated fixture results through the provider',
    run: runAgentPopulatedSearchJourney,
  },
  'model-refresh': {
    fixture: 'workspace-browser',
    description:
      'Refreshed execution, saved selections, fixed tariffs, installed CLI media and delivered content',
    run: runModelRefreshJourney,
  },
  'relay-recovery': {
    fixture: 'workspace-browser',
    description:
      'Relay sleep/wake across reboot, steering, queued follow-ups, interrupt/reactivation, and active-work recovery through completion',
    run: runRelayRecoveryJourney,
  },
  'provider-model-aliases': {
    fixture: 'workspace-browser',
    description:
      'Saved provider aliases, nested managed routing, concrete execution, exact settlement, and restored conversation selection',
    run: runProviderModelAliasesJourney,
  },
  'tier-restoration': {
    fixture: 'workspace-browser',
    description:
      'One conversation completes at Frontier, resumes twice at Standard, retains its history, and bills at the requested rates',
    run: runTierRestorationJourney,
  },
  'workspace-invitations': {
    fixture: 'workspace-browser',
    description:
      'New and existing invitees enter the invited workspace without onboarding or an extra workspace',
    run: runWorkspaceInvitationsJourney,
  },
  'billing-contention': {
    fixture: 'backend',
    description:
      'Concurrent billing and credential intake, exact settlement, and workspace activity without write-conflict failures',
    run: runBillingContentionJourney,
  },
  'agents-three-columns': {
    fixture: 'workspace-browser',
    description:
      "A roster row shows the last thing said in that agent's conversation, materialized on a deployed Convex and joined onto the activity read — plus the section's front door settling on the root agent",
    run: runAgentsThreeColumnsJourney,
  },
  'gateway-liveness': {
    fixture: 'workspace-browser',
    description:
      'Bounded generated-tree attribution, retry idempotency, stable rename and folder lineage, projection completion, anchor pressure, refresh, and boot health',
    run: runGatewayLivenessJourney,
  },
  'default-agent-chat': {
    fixture: 'workspace-browser',
    description:
      'Install a hub agent that declares no onboarding, open it, send the first message through the composer, and get an answer',
    run: runDefaultAgentChatJourney,
  },
  'chat-attachments': {
    fixture: 'workspace-browser',
    description:
      'Composer upload gating, durable attachment cards, Files attribution, model path resolution, remove cleanup, locked-agent onboarding intake, and who answers a declared body over the per-file upload cap',
    run: runChatAttachmentsJourney,
  },
  'agent-browser-windows': {
    fixture: 'workspace-browser',
    description:
      'Root and named-agent Chrome windows, shared profile, exact focus, background discard, deletion cleanup, and credential refusal',
    run: runAgentBrowserWindowsJourney,
  },
  'vm-compute-fees': {
    fixture: 'workspace-browser',
    description:
      'Real exe.dev metrics for a provisioned VM, a sweep that dedups on replay, a fresh storage bar reading zero, one labelled VM compute fee that survives a second charge, and a Starter payer refused a second workspace',
    run: runVmComputeFeesJourney,
  },
  'session-buckets': {
    fixture: 'workspace-browser',
    description:
      'One list holding conversations and jobs alike, bucket filters agreeing with it on a deployed Convex, a cursor that stays in its own range, and a read clearing unread without moving the row',
    run: runSessionBucketsJourney,
  },
  'session-lineage-api': {
    fixture: 'workspace-browser',
    description:
      'Direct lineage pages, archive isolation, recursive deletion acceptance, physical metadata convergence, and unrelated-session survival',
    run: runSessionLineageApiJourney,
  },
  'session-transcript-view': {
    fixture: 'workspace-browser',
    description:
      "History's transcript view pages exactly the rows the reader sees past a real turn's task rail, and its cursor stays bound to the view",
    run: runSessionTranscriptViewJourney,
  },
  'signup-abuse': {
    fixture: 'browser',
    description:
      'Cold browser signup: an exempt identity keeps its trial, a non-exempt one has the trial withheld, and the reason is recorded',
    run: runSignupAbuseJourney,
  },
  'agent-delegation': {
    fixture: 'workspace-browser',
    description:
      "Root delegates through a child's home chat: roster shows one layer, the child asks, root answers, both complete",
    run: runAgentDelegationJourney,
  },
  'agent-onboarding': {
    fixture: 'workspace-browser',
    description:
      'Locked agent card, reused hidden onboarding session, mark-onboarded unlock, and redo re-lock',
    run: runAgentOnboardingJourney,
  },
  'agentic-onboarding': {
    fixture: 'browser',
    description:
      'Cold signup through the agentic wizard: a tap-through follow-up with zero typing, a real LLM rail of four personalized picks, the minimum-3 floor, and a composed purpose that persists',
    run: runAgenticOnboardingJourney,
  },
  'connected-providers': {
    fixture: 'workspace-browser',
    description:
      'Subscription connect card, device-code flow, plan-covered session, fallback, disconnect (requires the fake OAuth issuer env)',
    run: runConnectedProvidersJourney,
  },
  'build-app': {
    fixture: 'workspace-agent',
    description: 'Agent-built public app registration, icon, content, and theme',
    run: runAppsLiveAcceptance,
  },
  'drive-deep-links': {
    fixture: 'workspace-browser',
    description: 'Agent-emitted Drive links and durable folder/file navigation',
    run: runDriveDeepLinksJourney,
  },
  'drive-percent-identities': {
    fixture: 'workspace-browser',
    description: 'Literal percent and encoded-looking filename transport through Files',
    run: runDrivePercentIdentitiesJourney,
  },
  'foreground-session-waits': {
    fixture: 'workspace-browser',
    description:
      'Foreground create, nested child, follow-up, ask/answer, disconnect recovery, history, and async compatibility',
    run: runForegroundSessionWaitsJourney,
  },
  'firecrawl-integration': {
    fixture: 'workspace-browser',
    description:
      'Integration connect through the hosted consent screen, tool execution, and disconnect',
    run: runFirecrawlIntegrationJourney,
  },
  'service-catalog': {
    fixture: 'backend',
    description:
      'Paid ElevenLabs TTS/music, Firecrawl crawl completion, route admission, shared-pool ownership/expiry, discovery, and ledger parity',
    run: runServiceCatalogStagingJourney,
  },
  'integration-agent-access': {
    fixture: 'workspace-browser',
    description:
      'Per-agent integration policy, next-turn snapshots, provider filtering, and conversation workbench continuity',
    run: runIntegrationAgentAccessJourney,
  },
  'live-file-refresh': {
    fixture: 'workspace-browser',
    description:
      'Open Files preview convergence, autosave, identity churn, conflict decisions, deletion recovery, and cleanup',
    run: runLiveFileRefreshJourney,
  },
  'low-credit-recovery': {
    fixture: 'billing-browser',
    description:
      'Exact $2 recovery boundaries for subscriber, trial, and member; hosted top-up clearing; automatic top-up suppression; entitlement precedence; and the hard-floor stale-projection refusal',
    run: runLowCreditRecoveryJourney,
  },
  marketplace: {
    fixture: 'workspace-browser',
    description:
      'Signed-in-only catalog, official agents as verified listings, and the server-side publish gate',
    run: runMarketplaceJourney,
  },
  'mcp-oauth': {
    fixture: 'workspace-browser',
    description:
      'MCP root discovery, DCR consent, OAuth rotation/revocation, tools, audience, and cleanup',
    run: runMcpOAuthJourney,
  },
  'mcp-servers': {
    fixture: 'workspace-browser',
    description:
      'A workspace attaching its own remote MCP servers: OAuth consent in the browser, a pasted token, per-agent scoping, a broken server that degrades instead of refusing dispatch, a capped oversized result, one refresh under concurrency, and a disconnect that revokes and forgets',
    run: runMcpServersJourney,
  },
  'official-agent-apps': {
    fixture: 'workspace-browser',
    description:
      'Manifest-derived official apps loaded into one VM, reconciled, and rendered through their private agent-owned product routes',
    run: runOfficialAgentAppsJourney,
  },
  'public-forms': {
    fixture: 'public-http',
    description: 'Safe rejection contracts for deployed public forms',
    run: runPublicFormsJourney,
  },
  'public-routes': {
    fixture: 'public-browser',
    description: 'Deployed lander and documentation route ownership',
    run: runPublicRoutesJourney,
  },
  'retrain-memory': {
    fixture: 'workspace-browser',
    description:
      'A trained memory listing the sources it came from, its archive readable, restaged into the inbox with its scraped page refreshed, and a retrain that replaces that memory instead of adding a second one',
    run: runRetrainMemoryJourney,
  },
  'session-app-pane': {
    fixture: 'workspace-browser',
    description:
      'Generated app guidance, durable cwd move, responsive app pane, cwd rejection, and session recovery',
    run: runSessionAppPaneJourney,
  },
  'specific-people-sessions': {
    fixture: 'workspace-browser',
    description:
      'Specific-person creation and visibility across three browsers, audience edits, archive precedence, app-principal control, membership churn, SSE denial, and verified cleanup',
    run: runSpecificPeopleSessionsJourney,
  },
  'trial-recommission': {
    fixture: 'trial-browser',
    description:
      'Never-subscribed decommission, same-workspace fresh VM, root cwd fallback, and bound-session settlement',
    run: runTrialRecommissionJourney,
  },
  'agent-lifecycle': {
    fixture: 'workspace-browser',
    description:
      'Register an agent with an app inside it, attribute a running session, fire it, and prove the runner, the folder, and the app row all went with it',
    run: runAgentLifecycleJourney,
  },
  'agent-naming': {
    fixture: 'workspace-browser',
    description:
      'Re-register preserves a chosen name, the default agent renames at the reserved root slug, and onboarding does not overwrite it',
    run: runAgentNamingJourney,
  },
  'virtual-model-tiers': {
    fixture: 'workspace-browser',
    description:
      'Subscriber tier defaults, routed billing, live tier switch, out-of-tier model billed at cost, and tier UI evidence',
    run: runVirtualModelTiersJourney,
  },
} as const

export type StagingJourneyName = keyof typeof STAGING_JOURNEYS

export type StagingLiveSelection = { kind: 'all' } | { kind: 'journey'; name: StagingJourneyName }

const USAGE = `Usage: bun run e2e:staging [-- --journey <${Object.keys(STAGING_JOURNEYS).join('|')}>]`

export function parseStagingLiveSelection(args: readonly string[]): StagingLiveSelection {
  if (args.length === 0) return { kind: 'all' }
  if (args.length !== 2 || args[0] !== '--journey') throw new Error(USAGE)

  const name = args[1]
  if (name === undefined || !(name in STAGING_JOURNEYS)) {
    throw new Error(`Unknown staging journey "${name ?? ''}". ${USAGE}`)
  }
  return { kind: 'journey', name: name as StagingJourneyName }
}
