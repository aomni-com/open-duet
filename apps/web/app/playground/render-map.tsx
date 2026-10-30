import type { ReactNode } from 'react'

import { AgentDetailPlayground } from '../../components/playground/agent-detail-playground'
import { AgentSurfaceDrivePlayground } from '../../components/playground/agent-surface-drive-playground'
import { AgentSurfacePlayground } from '../../components/playground/agent-surface-playground'
import { AgentsRailPlayground } from '../../components/playground/agents-rail-playground'
import { AppDomainsPlayground } from '../../components/playground/app-domains-playground'
import { AppUpdateNoticePlayground } from '../../components/playground/app-update-notice-playground'
import { AttachmentCardsPlayground } from '../../components/playground/attachment-cards-playground'
import { AuthSurfacesPlayground } from '../../components/playground/auth/auth-surfaces-playground'
import { DeviceApprovalPlayground } from '../../components/playground/auth/device-approval-playground'
import { OAuthConsentPlayground } from '../../components/playground/auth/oauth-consent-playground'
import { BuildingPagePlayground } from '../../components/playground/building-page-playground'
import { CacheContinuityPlayground } from '../../components/playground/cache-continuity-playground'
import { ComposeBarPlayground } from '../../components/playground/compose-bar-playground'
import { DesktopPanePlayground } from '../../components/playground/desktop-pane-playground'
import { DriveShellPlayground } from '../../components/playground/drive-shell-playground'
import { EdgePausedPagePlayground } from '../../components/playground/edge-paused-page-playground'
import { TransactionalEmailPlayground } from '../../components/playground/email/transactional-email-playground'
import { EntitlementWallPlayground } from '../../components/playground/entitlement-wall-playground'
import { FilesPlayground } from '../../components/playground/files-playground'
import { InternalAdminPlayground } from '../../components/playground/internal-admin-playground'
import { KnowledgeMapHomePlayground } from '../../components/playground/knowledge-map-home-playground'
import { KnowledgeMapPlayground } from '../../components/playground/knowledge-map-playground'
import { LowCreditGatePlayground } from '../../components/playground/low-credit-gate-playground'
import {
  MarkdownPlayground,
  SessionMarkdownPlayground,
} from '../../components/playground/markdown-playground'
import { MarketplaceAgentsIntegrationPlayground } from '../../components/playground/marketplace-integration-playground'
import { MarketplaceAgentsPlayground } from '../../components/playground/marketplace-playground'
import { OnboardingChainPlayground } from '../../components/playground/onboarding-chain-playground'
import { OnboardingJourneyPlayground } from '../../components/playground/onboarding-journey-playground'
import { OnboardingPlayground } from '../../components/playground/onboarding-playground'
import {
  PublishBrowserPlayground,
  PublishPreviewPlayground,
  PublishViewerBannerPlayground,
  PublishViewerDeepFolderPlayground,
  PublishViewerEmptyFolderPlayground,
  PublishViewerErrorPlayground,
  PublishViewerFolderRootPlayground,
  PublishViewerLoadingPlayground,
  PublishViewerMediaPlayground,
  PublishViewerNotFoundPlayground,
  PublishViewerSingleFilePlayground,
  PublishViewerSvgSourcePlayground,
  PublishViewerTextSourcePlayground,
  ShowHiddenTogglePlayground,
} from '../../components/playground/publish-viewer-playground'
import { SessionAuthoredMessagesPlayground } from '../../components/playground/session-authored-messages-playground'
import { SessionChatPlayground } from '../../components/playground/session-chat-playground'
import { SessionComposerPlayground } from '../../components/playground/session-composer-playground'
import { SessionInlineMediaPlayground } from '../../components/playground/session-inline-media-playground'
import { SessionOrderedPartsPlayground } from '../../components/playground/session-ordered-parts-playground'
import { SessionProjectionWorkbench } from '../../components/playground/session-projection-workbench'
import { SessionRelayCompactPlayground } from '../../components/playground/session-relay-compact-playground'
import { SessionRelayDisclosurePlayground } from '../../components/playground/session-relay-disclosure-playground'
import { ShareDialogPlayground } from '../../components/playground/share-dialog-playground'
import { SpaShellPlayground } from '../../components/playground/spa-shell-playground'
import { StorageSurfacesPlayground } from '../../components/playground/storage-surfaces-playground'
import { TeamSpacePlayground } from '../../components/playground/team-space/team-space-playground'
import { UiPrimitivesPlayground } from '../../components/playground/ui-primitives/ui-primitives-playground'
import { WorkspaceAppDomainsPlayground } from '../../components/playground/workspace-app-domains-playground'
import type { PlaygroundId } from './registry'

export const PLAYGROUND_RENDERERS = {
  'workspace-app-domains': () => <WorkspaceAppDomainsPlayground />,
  'app-domains-management': () => <AppDomainsPlayground />,
  'attachment-cards': () => <AttachmentCardsPlayground />,
  'desktop-connecting': () => <DesktopPanePlayground state="connecting" />,
  'desktop-live': () => <DesktopPanePlayground state="live" />,
  'desktop-driving': () => <DesktopPanePlayground state="driving" />,
  'desktop-unhealthy': () => <DesktopPanePlayground state="unhealthy" />,
  'knowledge-map': () => <KnowledgeMapPlayground />,
  'knowledge-map-home': () => <KnowledgeMapHomePlayground />,
  'knowledge-map-zoom': () => <KnowledgeMapHomePlayground state="zoomed" />,
  'knowledge-map-empty': () => <KnowledgeMapHomePlayground state="empty" />,
  'knowledge-map-loading': () => <KnowledgeMapHomePlayground state="loading" />,
  'agent-page-loading': () => <KnowledgeMapHomePlayground state="skeleton" />,
  'low-credit-gate': () => <LowCreditGatePlayground />,
  'agent-surface': () => <AgentSurfacePlayground />,
  'agent-surface-busy': () => <AgentSurfaceDrivePlayground />,
  'agent-surface-quiet': () => <AgentSurfaceDrivePlayground drive="quiet" />,
  'agent-surface-duet': () => <AgentSurfaceDrivePlayground drive="quiet" centre />,
  'agent-surface-setup': () => <AgentSurfaceDrivePlayground drive="quiet" setup="cta" />,
  'agent-surface-setup-waiting': () => (
    <AgentSurfaceDrivePlayground drive="quiet" setup="waiting" />
  ),
  'agent-surface-setup-chat': () => <AgentSurfaceDrivePlayground drive="quiet" setup="chat" />,
  'agent-surface-setup-app': () => <AgentSurfaceDrivePlayground drive="quiet" setup="app" />,
  'agent-surface-app-frame': () => <AgentSurfaceDrivePlayground drive="quiet" frame />,
  'agent-surface-app-loading': () => <AgentSurfaceDrivePlayground drive="quiet" frame="loading" />,
  'agents-rail': () => <AgentsRailPlayground />,
  'agents-rail-open': () => <AgentsRailPlayground view="open" />,
  'agents-rail-inside': () => <AgentsRailPlayground view="inside" />,
  'agents-rail-inside-folded': () => <AgentsRailPlayground view="inside-folded" />,
  'agents-rail-states': () => <AgentsRailPlayground view="states" />,
  'agent-detail': () => <AgentDetailPlayground />,
  'app-building': () => <BuildingPagePlayground />,
  'auth-surfaces': () => <AuthSurfacesPlayground />,
  'compose-bar': () => <ComposeBarPlayground />,
  'device-approval': () => <DeviceApprovalPlayground />,
  'oauth-consent': () => <OAuthConsentPlayground />,
  'oauth-grants-settings': () => <SpaShellPlayground initialScenario="settings-oauth-grants" />,
  'drive-shell': () => <DriveShellPlayground />,
  'entitlement-wall-trial-exhausted': () => <EntitlementWallPlayground variant="trial-exhausted" />,
  'entitlement-wall-trial-timed-out': () => <EntitlementWallPlayground variant="trial-timed-out" />,
  'entitlement-wall-lapsed': () => <EntitlementWallPlayground variant="lapsed" />,
  'entitlement-wall-day-7': () => (
    <EntitlementWallPlayground variant="trial-timed-out" stage="warned" />
  ),
  'entitlement-wall-day-14': () => (
    <EntitlementWallPlayground variant="trial-timed-out" stage="decommissioned" />
  ),
  'entitlement-wall-billing-issue': () => <EntitlementWallPlayground variant="billing-issue" />,
  'entitlement-wall-member': () => <EntitlementWallPlayground variant="member" />,
  'edge-paused': () => <EdgePausedPagePlayground />,
  'email-auth-magic-link': () => <TransactionalEmailPlayground kind="auth_magic_link" />,
  'email-share-invite': () => <TransactionalEmailPlayground kind="share_invite" />,
  'email-train-complete': () => <TransactionalEmailPlayground kind="train_complete" />,
  'email-workspace-invite': () => <TransactionalEmailPlayground kind="workspace_invite" />,
  files: () => <FilesPlayground />,
  'files-app-continuation': () => <FilesPlayground initialScenario="apps-paginated" />,
  'files-seen-by-incomplete': () => <FilesPlayground incompleteSeenBy />,
  markdown: () => <MarkdownPlayground />,
  'session-markdown': () => <SessionMarkdownPlayground />,
  'files-unhealthy': () => <FilesPlayground initialScenario="unhealthy" />,
  'files-activity-summaries': () => <FilesPlayground activity="root" />,
  'files-activity-scoped': () => <FilesPlayground activity="scoped" />,
  'files-inline': () => <FilesPlayground chrome="inline" />,
  'publish-browser': () => <PublishBrowserPlayground />,
  'publish-preview': () => <PublishPreviewPlayground />,
  'publish-viewer-banner': () => <PublishViewerBannerPlayground />,
  'publish-viewer-folder-root': () => <PublishViewerFolderRootPlayground />,
  'publish-viewer-deep-folder': () => <PublishViewerDeepFolderPlayground />,
  'publish-viewer-text-source': () => <PublishViewerTextSourcePlayground />,
  'publish-viewer-svg-source': () => <PublishViewerSvgSourcePlayground />,
  'publish-viewer-media': () => <PublishViewerMediaPlayground />,
  'publish-viewer-single-file': () => <PublishViewerSingleFilePlayground />,
  'publish-viewer-empty-folder': () => <PublishViewerEmptyFolderPlayground />,
  'publish-viewer-loading': () => <PublishViewerLoadingPlayground />,
  'publish-viewer-not-found': () => <PublishViewerNotFoundPlayground />,
  'publish-viewer-error': () => <PublishViewerErrorPlayground />,
  'show-hidden-toggle': () => <ShowHiddenTogglePlayground />,
  'internal-admin': () => <InternalAdminPlayground />,
  marketplace: () => <MarketplaceAgentsPlayground />,
  'marketplace-integration': () => <MarketplaceAgentsIntegrationPlayground />,
  'workspace-invitations-low-credit': () => (
    <SpaShellPlayground initialScenario="invitations-low-credit" />
  ),
  'workspace-invitations-blocked': () => (
    <SpaShellPlayground initialScenario="invitations-blocked" />
  ),
  'workspace-invitations': () => <SpaShellPlayground initialScenario="invitations" />,
  'workspace-invitations-onboarding': () => (
    <SpaShellPlayground initialScenario="invitations-onboarding" />
  ),
  'spa-shell': () => <SpaShellPlayground />,
  'spa-shell-file-pagination': () => <SpaShellPlayground initialScenario="files-pagination" />,
  'spa-shell-train-pagination-empty': () => (
    <SpaShellPlayground initialScenario="train-pagination-empty" />
  ),
  'spa-shell-integrations-pagination-empty': () => (
    <SpaShellPlayground initialScenario="integrations-pagination-empty" />
  ),
  'session-audience': () => <SpaShellPlayground initialScenario="sessions-audience-invalid" />,
  'low-credit-shell-lifecycle': () => <SpaShellPlayground initialScenario="low-credit-lifecycle" />,
  'workspace-backups-empty': () => <SpaShellPlayground initialScenario="settings-backups-empty" />,
  'workspace-backups-capturing': () => (
    <SpaShellPlayground initialScenario="settings-backups-capturing" />
  ),
  'workspace-backups-uploading': () => (
    <SpaShellPlayground initialScenario="settings-backups-uploading" />
  ),
  'workspace-backups-ready': () => <SpaShellPlayground initialScenario="settings-backups-ready" />,
  'workspace-backups-partial': () => (
    <SpaShellPlayground initialScenario="settings-backups-partial" />
  ),
  'workspace-backups-failed': () => (
    <SpaShellPlayground initialScenario="settings-backups-failed" />
  ),
  'workspace-backups-deleting': () => (
    <SpaShellPlayground initialScenario="settings-backups-deleting" />
  ),
  'workspace-backups-archived': () => (
    <SpaShellPlayground initialScenario="settings-backups-archived" />
  ),
  'settings-default-tier-subscribed': () => (
    <SpaShellPlayground initialScenario="settings-default-tier-subscribed" />
  ),
  'settings-usage-tier-badges': () => (
    <SpaShellPlayground initialScenario="settings-usage-tier-badges" />
  ),
  'sessions-desktop-pane': () => <SpaShellPlayground initialScenario="sessions-pane-open" />,
  onboarding: () => <OnboardingPlayground />,
  'onboarding-journey': () => <OnboardingJourneyPlayground />,
  'cache-continuity': () => <CacheContinuityPlayground />,
  'onboarding-chain': () => <OnboardingChainPlayground />,
  'session-authored-messages': () => <SessionAuthoredMessagesPlayground />,
  'session-chat': () => <SessionChatPlayground />,
  'session-projection': () => <SessionProjectionWorkbench />,
  'session-composer': () => <SessionComposerPlayground />,
  'session-inline-media': () => <SessionInlineMediaPlayground />,
  'session-ordered-parts': () => <SessionOrderedPartsPlayground />,
  'session-relay-compact': () => <SessionRelayCompactPlayground />,
  'session-relay-disclosure': () => <SessionRelayDisclosurePlayground />,
  'share-dialog': () => <ShareDialogPlayground />,
  'storage-empty-measuring-en': () => (
    <StorageSurfacesPlayground state="empty-measuring" locale="en" />
  ),
  'storage-empty-measuring-es': () => (
    <StorageSurfacesPlayground state="empty-measuring" locale="es-419" />
  ),
  'storage-empty-zero-en': () => (
    <StorageSurfacesPlayground state="empty-sampled-zero" locale="en" />
  ),
  'storage-empty-zero-es': () => (
    <StorageSurfacesPlayground state="empty-sampled-zero" locale="es-419" />
  ),
  'storage-ordinary-en': () => <StorageSurfacesPlayground state="ordinary" locale="en" />,
  'storage-ordinary-es': () => <StorageSurfacesPlayground state="ordinary" locale="es-419" />,
  'storage-89-en': () => <StorageSurfacesPlayground state="89-percent" locale="en" />,
  'storage-89-es': () => <StorageSurfacesPlayground state="89-percent" locale="es-419" />,
  'storage-90-starter-en': () => (
    <StorageSurfacesPlayground state="90-percent-starter" locale="en" />
  ),
  'storage-90-starter-es': () => (
    <StorageSurfacesPlayground state="90-percent-starter" locale="es-419" />
  ),
  'storage-90-pro-en': () => <StorageSurfacesPlayground state="90-percent-pro" locale="en" />,
  'storage-90-pro-es': () => <StorageSurfacesPlayground state="90-percent-pro" locale="es-419" />,
  'storage-near-full-max-en': () => <StorageSurfacesPlayground state="near-full-max" locale="en" />,
  'storage-near-full-max-es': () => (
    <StorageSurfacesPlayground state="near-full-max" locale="es-419" />
  ),
  'storage-full-en': () => <StorageSurfacesPlayground state="full-hard-stop" locale="en" />,
  'storage-full-es': () => <StorageSurfacesPlayground state="full-hard-stop" locale="es-419" />,
  'storage-downgraded-kept-58-en': () => (
    <StorageSurfacesPlayground state="downgraded-kept-58" locale="en" />
  ),
  'storage-downgraded-kept-58-es': () => (
    <StorageSurfacesPlayground state="downgraded-kept-58" locale="es-419" />
  ),
  'storage-multi-workspace-en': () => (
    <StorageSurfacesPlayground state="multi-workspace" locale="en" />
  ),
  'storage-multi-workspace-es': () => (
    <StorageSurfacesPlayground state="multi-workspace" locale="es-419" />
  ),
  'storage-seven-day-wall-en': () => (
    <StorageSurfacesPlayground state="seven-day-wall" locale="en" />
  ),
  'storage-seven-day-wall-es': () => (
    <StorageSurfacesPlayground state="seven-day-wall" locale="es-419" />
  ),
  'app-update-notice-en': () => <AppUpdateNoticePlayground locale="en" />,
  'app-update-notice-es': () => <AppUpdateNoticePlayground locale="es-419" />,
  'team-space': () => <TeamSpacePlayground />,
  'team-space-home': () => <SpaShellPlayground initialScenario="team-space-home" />,
  'team-space-home-two-owners': () => (
    <SpaShellPlayground initialScenario="team-space-home-two-owners" />
  ),
  'team-space-home-error': () => <SpaShellPlayground initialScenario="team-space-home-error" />,
  'team-space-chat': () => <SpaShellPlayground initialScenario="team-space-chat" />,
  'team-space-app': () => <SpaShellPlayground initialScenario="team-space-app" />,
  'team-space-build': () => <SpaShellPlayground initialScenario="team-space-build" />,
  'ui-primitives': () => <UiPrimitivesPlayground />,
} satisfies Record<PlaygroundId, () => ReactNode>
