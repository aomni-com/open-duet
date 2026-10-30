import type { VisualCoverageEntry } from '../../../../scripts/visual-coverage-core'

export const VISUAL_COVERAGE = [
  {
    target: 'spa/sessions/default-chat-jobs.tsx#DefaultChatJobs',
    kind: 'fixture',
    fixture: 'spa-shell',
  },
  ...[
    'spa/settings/workspace-app-domains.tsx#WorkspaceAppDomains',
    'spa/routes/workspace-settings.tsx#AppDomainsSettings',
    'components/playground/workspace-app-domains-playground.tsx#WorkspaceAppDomainsPlayground',
    'components/playground/workspace-app-domains-playground.tsx#InventoryNavigationDestination',
    'components/playground/workspace-app-domains-playground.tsx#InventoryAppMenu',
  ].map(target => ({ target, kind: 'fixture' as const, fixture: 'workspace-app-domains' })),
  ...[
    'spa/apps/app-domain-dialog.tsx#AppDomainDialog',
    'spa/apps/app-domain-dialog.tsx#AppDomainPanel',
    'spa/apps/app-domain-dialog.tsx#DomainStatus',
    'spa/apps/app-domain-dialog.tsx#DnsRecord',
    'components/playground/app-domains-playground.tsx#AppDomainsPlayground',
    'components/playground/app-domains-playground.tsx#DomainMenuHost',
  ].map(target => ({ target, kind: 'fixture' as const, fixture: 'app-domains-management' })),
  {
    target: 'spa/settings/workspace-backups-card.tsx#WorkspaceBackupsCard',
    kind: 'fixture',
    fixture: 'workspace-backups-partial',
  },
  {
    target: 'spa/settings/workspace-backups-card.tsx#BackupRow',
    kind: 'fixture',
    fixture: 'workspace-backups-partial',
  },
  {
    target: 'spa/shell/pending-invitations.tsx#PendingInvitations',
    kind: 'fixture',
    fixture: 'workspace-invitations',
  },
  {
    target: 'spa/entitlements/low-credit-gate.test.tsx#renderGate',
    kind: 'nonvisual',
    reason:
      'test-only localized component renderer; production component is covered by low-credit-gate',
  },
  {
    target: 'components/playground/desktop-pane-playground.tsx#DesktopPanePlayground',
    kind: 'fixture',
    fixture: 'desktop-live',
  },
  {
    target: 'app/playground/desktop-frame/page.tsx#DesktopFrameFixture',
    kind: 'fixture',
    fixture: 'desktop-live',
  },
  {
    target: 'spa/desktop/desktop-pane.tsx#DesktopPane',
    kind: 'fixture',
    fixture: 'desktop-driving',
  },
  {
    target: 'spa/desktop/desktop-pane.tsx#DriverRail',
    kind: 'fixture',
    fixture: 'desktop-driving',
  },
  {
    target: 'spa/desktop/desktop-pane.tsx#DesktopFrameSourceProvider',
    kind: 'nonvisual',
    reason:
      'source context provider renders no pixels; the three desktop fixtures exercise its substitution boundary',
  },
  {
    target: 'spa/desktop/desktop-pane.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production DesktopPane',
  },
  {
    target: 'components/playground/knowledge-map-playground.tsx#KnowledgeMapPlayground',
    kind: 'fixture',
    fixture: 'knowledge-map',
  },
  {
    target: 'components/playground/knowledge-map-home-playground.tsx#KnowledgeMapHomePlayground',
    kind: 'fixture',
    fixture: 'knowledge-map-home',
  },
  {
    target: 'components/playground/agent-surface-playground.tsx#AgentSurfacePlayground',
    kind: 'fixture',
    fixture: 'agent-surface',
  },
  {
    target: 'spa/routes/agents-map/knowledge-map-home.tsx#KnowledgeMapHome',
    kind: 'fixture',
    fixture: 'knowledge-map-home',
  },
  {
    target: 'components/playground/agent-surface-busy-fixture.tsx#FixtureChat',
    kind: 'fixture',
    fixture: 'agent-surface-busy',
  },
  {
    target: 'components/playground/agent-surface-drive-playground.tsx#AgentSurfaceDrivePlayground',
    kind: 'fixture',
    fixture: 'agent-surface-busy',
  },
  {
    /* Named rather than left to the import graph, which would hand the
       placeholder to the first fixture that merely *reaches* the frame module
       and record a loading state nothing photographs. This is the one fixture
       that draws it. */
    target: 'spa/apps/app-frame.tsx#AppFramePlaceholder',
    kind: 'owned-by',
    owner: 'fixture:agent-surface-app-loading',
  },
  {
    target: 'spa/routes/agents-map/agent-surface/index.tsx#AgentSurface',
    kind: 'fixture',
    fixture: 'agent-surface',
  },
  {
    /* The locked surface, which no route fixture can reach: nothing in the spa
       shell's agent list is mid-onboarding, and giving one an `agent.json` with
       an onboarding block would relist every agent in every other shot. */
    target: 'spa/routes/agents-map/agent-surface/parts.tsx#SetupStage',
    kind: 'fixture',
    fixture: 'agent-surface-setup',
  },
  {
    target: 'components/playground/agents-rail-playground.tsx#AgentsRailPlayground',
    kind: 'fixture',
    fixture: 'agents-rail',
  },
  {
    target: 'spa/routes/agents-map/agents-rail/index.tsx#AgentsRail',
    kind: 'fixture',
    fixture: 'agents-rail-open',
  },
  {
    target: 'spa/routes/agents-map/agents-rail/list.tsx#AgentsRailList',
    kind: 'fixture',
    fixture: 'agents-rail-states',
  },
  {
    target: 'spa/routes/agents-map/agents-rail/list.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production AgentsRailList',
  },
  {
    target: 'spa/routes/agents-map/agents-rail/rail.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production AgentsRail',
  },
  {
    target: 'spa/routes/agents-map/agents-rail/skeleton-column.test.tsx#render',
    kind: 'nonvisual',
    reason:
      'server-render test helper; the cold-landing column it asserts on is drawn for one frame and is owned by fixture:spa-shell',
  },
  {
    target: 'spa/loading/home-loading.tsx#HomeLoadingIsland',
    kind: 'fixture',
    fixture: 'knowledge-map-loading',
  },
  {
    target: 'app/onboarding/page.tsx#OnboardingPage',
    kind: 'nonvisual',
    reason: 'authenticated alias redirects into the canonical workspace onboarding gate',
  },
  {
    target: 'app/(product)/loading.tsx#ProductLoading',
    kind: 'fixture',
    fixture: 'spa-shell',
  },
  {
    target: 'app/playground/layout.tsx#PlaygroundLayout',
    kind: 'nonvisual',
    reason: 'pass-through playground layout renders no presentation beyond its child route',
  },
  {
    target: 'app/device/layout.tsx#Layout',
    kind: 'nonvisual',
    reason: 'identity provider layout has no rendered presentation of its own',
  },
  {
    target: 'app/device/page.tsx#Page',
    kind: 'nonvisual',
    reason: 'controller delegates all stable presentation to DeviceApprovalScreen',
  },
  {
    target: 'app/oauth/authorize/layout.tsx#Layout',
    kind: 'nonvisual',
    reason: 'identity provider layout has no rendered presentation of its own',
  },
  {
    target: 'app/oauth/authorize/page.tsx#Page',
    kind: 'nonvisual',
    reason: 'controller delegates all stable presentation to OAuthConsentScreen',
  },
  {
    target: 'app/oauth/authorize/controller.tsx#OAuthConsentController',
    kind: 'nonvisual',
    reason: 'network and navigation controller delegates stable presentation to OAuthConsentScreen',
  },
  {
    target: 'app/sign-out/layout.tsx#Layout',
    kind: 'nonvisual',
    reason: 'transient logout redirect layout has no stable visual state',
  },
  {
    target: 'app/sign-out/page.tsx#Page',
    kind: 'nonvisual',
    reason: 'controller delegates stable progress and recovery presentation to SignOutStatus',
  },
  {
    target: 'spa/routes/train.test.tsx#renderRecordsCards',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production TrainRecordsCard',
  },
  {
    target: 'spa/knowledge-map-data/use-workspace-map.test.tsx#renderMap',
    kind: 'nonvisual',
    reason: 'server-render test helper; it mounts the hook and reads state, drawing nothing',
  },
  {
    target: 'spa/entitlements/subscribe-wall.test.tsx#renderWall',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production SubscribeWall',
  },
  {
    target: 'spa/shell/create-workspace-dialog.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production CreateDriveRefusal',
  },
  {
    target: 'spa/routes/agents-map/agent-surface/surface-copy.test.tsx#renderSurface',
    kind: 'nonvisual',
    reason: 'server-render test helper reads the production AgentSurface copy, drawing nothing',
  },
  {
    target: 'spa/routes/agents-map/agent-surface/surface-copy.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render test helper collects missing-message reports, drawing nothing',
  },
  {
    target: 'spa/routes/train.test.tsx#renderTrainAt',
    kind: 'nonvisual',
    reason: 'server-render test helper drives the production Train route at one scope',
  },
  {
    target: 'spa/routes/train.test.tsx#renderSourceCards',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production TrainSourceCard',
  },
  {
    target: 'spa/apps/app-frame-body.test.tsx#renderBody',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production AppFrameBody',
  },
  {
    target: 'spa/sessions/session-message.test.tsx#renderMessage',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production SessionMessage',
  },
  {
    target: 'spa/sessions/compose-placeholder.test.tsx#placeholderOf',
    kind: 'nonvisual',
    reason: 'server-render test helper reads one string out of the production hook',
  },
  {
    target: 'spa/files/apps-context.tsx#WorkspaceAppsProvider',
    kind: 'nonvisual',
    reason: 'data-source context provider renders no presentation beyond its children',
  },
  {
    target: 'spa/files/drive-view.test.tsx#renderDrive',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production DriveBrowser',
  },
  {
    target: 'spa/routes/agents-map/agent-drive.test.tsx#renderAgentDrive',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production WorkspaceDrive',
  },
  {
    target: 'spa/routes/agents-map/knowledge-map-home.test.tsx#renderHome',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production KnowledgeMapHome',
  },
  {
    target: 'spa/publish/publish-viewer-shell.test.tsx#renderShell',
    kind: 'nonvisual',
    reason: 'server-render test helper delegates presentation to the production PublishViewerShell',
  },
  {
    target: 'spa/files/files-surface.tsx#FileActionsMenu',
    kind: 'fixture',
    fixture: 'files',
  },
  {
    target: 'spa/shares/recipient-requests.tsx#RecipientShareRequests',
    kind: 'fixture',
    fixture: 'spa-shell',
  },
  {
    target: 'spa/shares/shares-management.tsx#SharesManagement',
    kind: 'fixture',
    fixture: 'spa-shell',
  },
  {
    target:
      'spa/connected-providers/connected-providers-management.tsx#ConnectedProvidersManagement',
    kind: 'fixture',
    fixture: 'spa-shell',
  },
  {
    target: 'components/playground/auth/auth-surfaces-playground.tsx#AuthSurfacesPlayground',
    kind: 'fixture',
    fixture: 'auth-surfaces',
  },
  {
    target: 'components/auth/sign-out-status.tsx#SignOutStatus',
    kind: 'fixture',
    fixture: 'auth-surfaces',
  },
  {
    target: 'components/auth/consent-panel.tsx#ConsentPanel',
    kind: 'fixture',
    fixture: 'oauth-consent',
  },
  {
    target: 'components/auth/oauth-consent-card.tsx#OAuthConsentScreen',
    kind: 'fixture',
    fixture: 'oauth-consent',
  },
  {
    target: 'components/auth/consent-panel.tsx#ConsentClientIdentity',
    kind: 'fixture',
    fixture: 'oauth-consent',
  },
  {
    target: 'components/playground/auth/device-approval-playground.tsx#DeviceApprovalPlayground',
    kind: 'fixture',
    fixture: 'device-approval',
  },
  {
    target: 'components/playground/auth/oauth-consent-playground.tsx#OAuthConsentPlayground',
    kind: 'fixture',
    fixture: 'oauth-consent',
  },
  {
    target: 'spa/routes/user-settings.tsx#ConnectedAppsCard',
    kind: 'fixture',
    fixture: 'oauth-grants-settings',
  },
  {
    target: 'spa/settings/collection-load-more.tsx#CollectionLoadMore',
    kind: 'fixture',
    fixture: 'oauth-grants-settings',
  },
  {
    target: 'spa/settings/workspace-default-tier-card.tsx#WorkspaceDefaultTierCard',
    kind: 'fixture',
    fixture: 'settings-default-tier-subscribed',
  },
  {
    target: 'spa/settings/usage-tier-badge.tsx#UsageTierBadge',
    kind: 'fixture',
    fixture: 'settings-usage-tier-badges',
  },
  {
    target: 'components/playground/building-page-playground.tsx#BuildingPagePlayground',
    kind: 'fixture',
    fixture: 'app-building',
  },
  {
    target: 'components/playground/compose-bar-playground.tsx#ComposeBarPlayground',
    kind: 'fixture',
    fixture: 'compose-bar',
  },
  {
    target: 'spa/files/drive-toolbar.tsx#DriveToolbar',
    kind: 'fixture',
    fixture: 'files-inline',
  },
  {
    target: 'components/playground/files-playground.tsx#FilesPlayground',
    kind: 'fixture',
    fixture: 'files',
  },
  {
    target: 'spa/files/files-not-found.tsx#FilesNotFound',
    kind: 'fixture',
    fixture: 'files',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishBrowserPlayground',
    kind: 'fixture',
    fixture: 'publish-browser',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishPreviewPlayground',
    kind: 'fixture',
    fixture: 'publish-preview',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#ShowHiddenTogglePlayground',
    kind: 'fixture',
    fixture: 'show-hidden-toggle',
  },
  {
    target: 'components/playground/entitlement-wall-playground.tsx#EntitlementWallPlayground',
    kind: 'fixture',
    fixture: 'entitlement-wall-lapsed',
  },
  {
    target: 'components/playground/low-credit-gate-playground.tsx#LowCreditGatePlayground',
    kind: 'fixture',
    fixture: 'low-credit-gate',
  },
  {
    target: 'spa/entitlements/low-credit-gate.tsx#LowCreditGate',
    kind: 'fixture',
    fixture: 'low-credit-gate',
  },
  {
    target: 'spa/entitlements/subscription-plan-chooser.tsx#SubscriptionPlanChooser',
    kind: 'fixture',
    fixture: 'low-credit-gate',
  },
  {
    target: 'components/playground/edge-paused-page-playground.tsx#EdgePausedPagePlayground',
    kind: 'fixture',
    fixture: 'edge-paused',
  },
  {
    target: 'components/playground/storage-surfaces-playground.tsx#StorageSurfacesPlayground',
    kind: 'fixture',
    fixture: 'storage-ordinary-en',
  },
  {
    target: 'spa/entitlements/storage-surfaces.tsx#StorageMeters',
    kind: 'fixture',
    fixture: 'storage-multi-workspace-en',
  },
  {
    target: 'spa/entitlements/storage-surfaces.tsx#StorageMeter',
    kind: 'fixture',
    fixture: 'storage-ordinary-en',
  },
  {
    target: 'spa/entitlements/storage-warning.tsx#StorageWarning',
    kind: 'nonvisual',
    reason:
      'root effect owner renders through the production ToastCard covered by storage warning fixtures',
  },
  {
    target: 'spa/entitlements/subscribe-wall.tsx#SubscribeWall',
    kind: 'fixture',
    fixture: 'entitlement-wall-lapsed',
  },
  {
    target: 'spa/entitlements/subscribe-wall.tsx#Meter',
    kind: 'fixture',
    fixture: 'entitlement-wall-lapsed',
  },
  {
    target: 'spa/entitlements/subscribe-wall.tsx#MomentumRecap',
    kind: 'fixture',
    fixture: 'entitlement-wall-lapsed',
  },
  {
    target: 'components/playground/drive-shell-playground.tsx#DriveShellPlayground',
    kind: 'fixture',
    fixture: 'drive-shell',
  },
  {
    target: 'components/playground/agent-detail-playground.tsx#AgentDetailPlayground',
    kind: 'fixture',
    fixture: 'agent-detail',
  },
  {
    target: 'components/playground/marketplace-playground.tsx#MarketplaceAgentsPlayground',
    kind: 'fixture',
    fixture: 'marketplace',
  },
  {
    target: 'components/playground/marketplace-playground.tsx#MarketplaceAgentsFixture',
    kind: 'owned-by',
    owner: 'fixture:marketplace',
  },
  {
    target: 'spa/marketplace/install-name-dialog.tsx#MarketplaceInstallNameDialog',
    kind: 'owned-by',
    owner: 'fixture:marketplace',
  },
  {
    target:
      'components/playground/marketplace-integration-playground.tsx#MarketplaceAgentsIntegrationPlayground',
    kind: 'fixture',
    fixture: 'marketplace-integration',
  },
  {
    target:
      'components/playground/marketplace-integration-playground.tsx#MarketplaceAgentsIntegrationFixture',
    kind: 'owned-by',
    owner: 'fixture:marketplace-integration',
  },
  {
    target: 'spa/onboarding/onboarding-route.tsx#WorkspaceOnboardingRoute',
    kind: 'nonvisual',
    reason:
      'workspace and cache controller delegates stable presentation to OnboardingExperience, captured by the onboarding fixture',
  },
  {
    target: 'spa/onboarding/onboarding-chain-orchestrator.tsx#OnboardingChainOrchestrator',
    kind: 'nonvisual',
    reason:
      'root-owned polling and navigation controller delegates stable wait presentation to OnboardingChainTransition',
  },
  {
    target: 'spa/onboarding/onboarding-chain-transition.tsx#OnboardingChainTransition',
    kind: 'fixture',
    fixture: 'onboarding-chain',
  },
  {
    target: 'spa/marketplace/gallery-card.tsx#MarketplaceAgentGalleryCard',
    kind: 'fixture',
    fixture: 'marketplace',
  },
  {
    target: 'spa/marketplace/detail-page.tsx#MarketplaceListingDetailPage',
    kind: 'fixture',
    fixture: 'marketplace',
  },
  {
    target: 'spa/routes/agents/agent-detail-canvas.tsx#AgentDetailCanvas',
    kind: 'fixture',
    fixture: 'agent-detail',
  },
  {
    target: 'spa/drive/agent-onboarding-cta.tsx#AgentOnboardingCta',
    kind: 'fixture',
    fixture: 'drive-shell',
  },
  {
    target: 'spa/routes/agents/agent-detail-canvas.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render test helper drives the production AgentDetailCanvas',
  },
  {
    target: 'components/playground/email/email-frame.tsx#EmailFrame',
    kind: 'fixture',
    fixture: 'email-auth-magic-link',
  },
  {
    target:
      'components/playground/email/transactional-email-playground.tsx#TransactionalEmailPlayground',
    kind: 'fixture',
    fixture: 'email-auth-magic-link',
  },
  {
    target: 'components/playground/internal-admin-playground.tsx#InternalAdminPlayground',
    kind: 'fixture',
    fixture: 'internal-admin',
  },
  {
    target: 'components/playground/session-projection-workbench.tsx#SessionProjectionWorkbench',
    kind: 'fixture',
    fixture: 'session-projection',
  },
  {
    target: 'components/playground/attachment-cards-playground.tsx#AttachmentCardsPlayground',
    kind: 'fixture',
    fixture: 'attachment-cards',
  },
  {
    target: 'spa/sessions/session-attachment-cards.tsx#AttachmentCards',
    kind: 'owned-by',
    owner: 'fixture:attachment-cards',
  },
  {
    target: 'spa/sessions/session-attachment-cards.tsx#AttachmentPreview',
    kind: 'owned-by',
    owner: 'fixture:attachment-cards',
  },
  {
    target:
      'components/playground/session-authored-messages-playground.tsx#SessionAuthoredMessagesPlayground',
    kind: 'fixture',
    fixture: 'session-authored-messages',
  },
  {
    target: 'components/playground/session-composer-playground.tsx#SessionComposerPlayground',
    kind: 'fixture',
    fixture: 'session-composer',
  },
  {
    target:
      'components/playground/session-inline-media-playground.tsx#SessionInlineMediaPlayground',
    kind: 'fixture',
    fixture: 'session-inline-media',
  },
  {
    target: 'components/playground/markdown-playground.tsx#MarkdownPlayground',
    kind: 'fixture',
    fixture: 'markdown',
  },
  {
    target: 'components/playground/markdown-playground.tsx#SessionMarkdownPlayground',
    kind: 'fixture',
    fixture: 'session-markdown',
  },
  {
    target: 'spa/sessions/session-markdown.tsx#SessionMarkdown',
    kind: 'fixture',
    fixture: 'session-inline-media',
  },
  {
    target: 'spa/sessions/session-markdown.tsx#SessionMedia',
    kind: 'fixture',
    fixture: 'session-inline-media',
  },
  {
    target: 'spa/sessions/session-markdown.tsx#SessionAnchor',
    kind: 'fixture',
    fixture: 'session-inline-media',
  },
  {
    target: 'spa/sessions/session-markdown.tsx#FileCard',
    kind: 'fixture',
    fixture: 'session-inline-media',
  },
  {
    target:
      'components/playground/session-ordered-parts-playground.tsx#SessionOrderedPartsPlayground',
    kind: 'fixture',
    fixture: 'session-ordered-parts',
  },
  {
    target: 'spa/sessions/session-composer.tsx#SessionComposer',
    kind: 'fixture',
    fixture: 'session-composer',
  },
  {
    target: 'spa/sessions/session-audience-picker.tsx#SessionAudiencePicker',
    kind: 'fixture',
    fixture: 'session-audience',
  },
  {
    /* Re-homed from `agent-jobs-dialog` when that dialog was deleted. The
       manager's one remaining mount is the Work conversation's header, so the
       Work chat scenario is where it is photographed. The dialog's fixture
       carried a switchboard of audience states (read-only, empty, long, both
       error shapes) that this scenario does not; re-staging them on Work is
       worth doing and is not this change. */
    target: 'spa/sessions/session-audience-manager.tsx#SessionAudienceManager',
    kind: 'fixture',
    fixture: 'team-space-chat',
  },
  {
    target: 'spa/sessions/session-audience-manager.tsx#SessionAudiencePreview',
    kind: 'owned-by',
    owner: 'fixture:team-space-chat',
  },
  {
    target: 'spa/team-space/work-job-row.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render helper for the Recent jobs row state and unread marks contract',
  },
  {
    target: 'spa/team-space/work-conversation-row.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render helper for the Work chat row state and unread marks contract',
  },
  {
    target: 'spa/sessions/session-audience-manager.test.tsx#render',
    kind: 'nonvisual',
    reason: 'server-render helper for the exact closed-header preview contract',
  },
  {
    target: 'spa/sessions/ordered-agent-parts.tsx#OrderedAgentParts',
    kind: 'fixture',
    fixture: 'session-ordered-parts',
  },
  {
    target:
      'components/playground/session-relay-compact-playground.tsx#SessionRelayCompactPlayground',
    kind: 'fixture',
    fixture: 'session-relay-compact',
  },
  {
    target:
      'components/playground/session-relay-disclosure-playground.tsx#SessionRelayDisclosurePlayground',
    kind: 'fixture',
    fixture: 'session-relay-disclosure',
  },
  {
    target: 'spa/relay/relay-status.tsx#RelayStatus',
    kind: 'fixture',
    fixture: 'session-relay-compact',
  },
  {
    target: 'spa/relay/relay-status.tsx#RelayPathDisclosure',
    kind: 'fixture',
    fixture: 'session-relay-disclosure',
  },
  {
    target: 'components/playground/share-dialog-playground.tsx#ShareDialogPlayground',
    kind: 'fixture',
    fixture: 'share-dialog',
  },
  {
    target: 'components/playground/spa-shell-playground.tsx#SpaShellPlayground',
    kind: 'fixture',
    fixture: 'spa-shell',
  },
  {
    target:
      'components/playground/ui-primitives/ui-primitives-playground.tsx#UiPrimitivesPlayground',
    kind: 'fixture',
    fixture: 'ui-primitives',
  },
  {
    target: 'app/publish/[workspaceSlug]/[publishSlug]/[[...path]]/page.tsx#PublishViewerPage',
    kind: 'nonvisual',
    reason:
      'slice 08 server page reads only route params + the edge viewer descriptor and delegates all rendered presentation to the PublishViewer client shell; its own output is a headless not-found fallback, and the real chrome/shots arrive in slice 09',
  },
  {
    target: 'spa/publish/publish-viewer.tsx#PublishViewer',
    kind: 'nonvisual',
    reason:
      'URL↔path controller mount; it wires window.history + the PublishViewerController and delegates every pixel to PublishViewerShell, which the publish-viewer-* fixtures shoot',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerBannerPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-banner',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerFolderRootPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-folder-root',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerDeepFolderPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-deep-folder',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerTextSourcePlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-text-source',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerSvgSourcePlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-svg-source',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerMediaPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-media',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerSingleFilePlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-single-file',
  },
  {
    target:
      'components/playground/publish-viewer-playground.tsx#PublishViewerEmptyFolderPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-empty-folder',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerLoadingPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-loading',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerNotFoundPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-not-found',
  },
  {
    target: 'components/playground/publish-viewer-playground.tsx#PublishViewerErrorPlayground',
    kind: 'fixture',
    fixture: 'publish-viewer-error',
  },
] as const satisfies readonly VisualCoverageEntry[]
