import { z } from 'zod'

import type {
  AddMcpServerRequest,
  BrowserAnalyticsEventRequest,
  DesktopSessionResponse,
  DesktopStatusResponse,
  McpServer,
  McpServerList,
  McpServerProbe,
  McpServerProbeRequest,
  SessionInputResponse,
  SetMcpServerAgentPolicyRequest,
} from '@repo/contract'
import {
  currentMonthKey,
  BackupCreateRequestSchema,
  BackupResponseSchema,
  BackupListResponseSchema,
  BackupDownloadResponseSchema,
  BackupDeleteResponseSchema,
  IncomingWorkspaceInvitePageSchema,
  WorkspaceInviteAcceptedSchema,
  AgentListResponseSchema,
  OpenOnboardingSessionResponseSchema,
  AgentResponseSchema,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  RegisterAgentResponseSchema,
  DefaultAgentResponseSchema,
  DesktopSessionResponseSchema,
  DesktopStatusResponseSchema,
  FocusBrowserOwnerResultSchema,
  ROOT_AGENT_SCOPE,
  ConnectedProviderStatusSchema,
  ConnectPollResponseSchema,
  ConnectStartResponseSchema,
  DeleteAgentResponseSchema,
  MarketplaceCatalogResponseSchema,
  MarketplaceListingDetailSchema,
  MarketplaceAgentMutationErrorSchema,
  WorkspaceOnboardingResponseSchema,
  OnboardingPaymentIntentResponseSchema,
  OnboardingPaymentStatusSchema,
  OnboardingRecommendationsResponseSchema,
  MarketplaceAgentSubscriptionListSchema,
  MarketplaceAgentSubscriptionResponseSchema,
  MarketplaceAgentUninstallResponseSchema,
  AppListResponseSchema,
  AppDomainResponseSchema,
  AppDomainListResponseSchema,
  AttachAppDomainRequestSchema,
  AppResponseSchema,
  DeleteAppResponseSchema,
  DeviceApprovalResponseSchema,
  OAuthConsentApproveResponseSchema,
  OAuthConsentDenyResponseSchema,
  OAuthConsentInspectResponseSchema,
  OAuthGrantPageSchema,
  OAuthGrantRevokedSchema,
  IntegrationCatalogPageSchema,
  IntegrationAgentPolicyResponseSchema,
  IntegrationConnectResponseSchema,
  IntegrationConnectionListSchema,
  IntegrationDisconnectResponseSchema,
  McpServerAgentPolicyResponseSchema,
  McpServerListSchema,
  McpServerProbeSchema,
  McpServerSchema,
  RemoveMcpServerResponseSchema,
  SessionCreateResponseSchema,
  VmUploadGrantSchema,
  DefaultSessionMessageResponseSchema,
  SessionHistoryPageSchema,
  SessionAudiencePageSchema,
  SessionInputResponseSchema,
  SessionChildrenQuerySchema,
  SessionListQuerySchema,
  SessionListPageSchema,
  SessionInterruptResponseSchema,
  SessionNoteResponseSchema,
  SessionActivityResponseSchema,
  SessionReadResponseSchema,
  DefaultSessionResponseSchema,
  SessionSnapshotSchema,
  SessionSummarySchema,
  SubscriptionPlanChangeResponseSchema,
  BillingHistoryPageSchema,
  BillingHostedSessionResponseSchema,
  TrainMemoryCountsResponseSchema,
  TrainJobListResponseSchema,
  TrainJobResponseSchema,
  TrainRecordDeleteResponseSchema,
  TrainRecordListResponseSchema,
  TrainRecordResponseSchema,
  TrainRestageResponseSchema,
  TrainStartResponseSchema,
  WhoamiResponseSchema,
  FeedbackAcceptedResponseSchema,
  UsageReportResponseSchema,
  WorkspaceLedgerPageSchema,
  UserApiKeyIssuedSchema,
  SyncMachinePageSchema,
  SyncMachineRemovedSchema,
  UserApiKeyPageSchema,
  UserApiKeyRevokedSchema,
  UserBillingOverviewSchema,
  UserProfileSchema,
  WorkspaceAuditPageSchema,
  WorkspaceBillingUserResponseSchema,
  WorkspaceDefaultModelResponseSchema,
  WorkspaceInvitePageSchema,
  WorkspaceInviteRevokedSchema,
  WorkspaceInviteSchema,
  WorkspaceMemberRemovedSchema,
  WorkspaceMemberRoleResponseSchema,
  WorkspaceMembersPageSchema,
  VmTelemetryHistoryResponseSchema,
  InternalAdminCommandSchema,
  InternalAdminDirectorySchema,
  InternalAdminFeedbackListSchema,
  InternalAdminFileSchema,
  InternalAdminLogSchema,
  InternalAdminFreeCreditsSchema,
  InternalAdminListingTakedownResultSchema,
  InternalAdminOperationResultSchema,
  InternalAdminOfficialHubAccessSchema,
  InternalAdminFleetHealthSchema,
  InternalAdminInferenceMarginSchema,
  InternalAdminModelRouterPolicySchema,
  InternalAdminOfficialHubSyncSchema,
  InternalAdminCreateUserResultSchema,
  type InternalAdminCreateUserRequest,
  type InternalAdminCreateUserResult,
  InternalAdminSearchResponseSchema,
  InternalAdminVmStatusSchema,
  InternalAdminVmOperationResultSchema,
  type Backup,
  type InternalAdminVmOperationResult,
  InternalAdminVmUpdatesSchema,
  InternalAdminWorkspaceDetailSchema,
  InternalAdminCleanupPreviewSchema,
  InternalAdminCleanupOperationSchema,
  FILES_OPTIONAL_QUERY,
  FileListResponseSchema,
  FileOperationResponseSchema,
  FileStatResponseSchema,
  FileWriteResponseSchema,
  IncomingShareResponseSchema,
  PendingShareListResponseSchema,
  PublishListResponseSchema,
  PublishResponseSchema,
  ShareDeclinedResponseSchema,
  ShareRequestResponseSchema,
  ShareListResponseSchema,
  ShareRevokedResponseSchema,
  ShareResponseSchema,
  ShareUnlinkedResponseSchema,
  WorkspaceCreateResultSchema,
  type AppListResponse,
  type ConnectedProviderId,
  type ConnectedProviderStatus,
  type ConnectPollResponse,
  type ConnectStartResponse,
  type ListAppsQuery,
  type AppResponse,
  type AppVisibility,
  type DeleteAppResponse,
  type DeviceApprovalAction,
  type DeviceApprovalResponse,
  type OAuthConsentApproveResponse,
  type OAuthConsentDenyResponse,
  type OAuthConsentInspectResponse,
  type IntegrationCatalogPage,
  type IntegrationCatalogQuery,
  type IntegrationConnectRequest,
  type InternalAdminVmOperation,
  type IntegrationConnectResponse,
  type TrainMemoryCountsResponse,
  type RegisterAppRequest,
  type AgentAnswerRequest,
  type AgentMessageRequestInput,
  type DefaultSessionMessageRequestInput,
  type SetDefaultSessionRequestInput,
  type AgentNoteRequest,
  type AgentStartSessionRequestInput,
  type SessionCreateResponse,
  type VmUploadGrant,
  type SessionHistoryPage,
  type SessionHistoryView,
  type SessionAudiencePage,
  type SessionAudienceDeltaRequest,
  type SessionListPage,
  type SessionActivityResponse,
  type SessionReadResponse,
  type SessionSnapshot,
  type SessionSummary,
  type SubscriptionPlanChangeRequest,
  type SubscriptionPlanId,
  type TrainJobListResponse,
  type TrainJobResponse,
  type TrainRecordDeleteResponse,
  type TrainRecordListResponse,
  type TrainRecordResponse,
  type TrainRestageResponse,
  type TrainStartRequest,
  type TrainStartResponse,
  type UpdateAppRequest,
  type WhoamiResponse,
  type AgentListResponse,
  type AgentListQuery,
  type OpenOnboardingSessionResponse,
  type AgentResponse,
  type DeleteAgentResponse,
  type SetAgentOnboardedRequest,
  type UpdateAgentRequest,
  type DefaultAgentResponse,
  type UpdateDefaultAgentRequest,
  type MarketplaceCatalogResponse,
  type AgentTag,
  type MarketplaceListingDetail,
  type MarketplaceAgentCloneRequest,
  type MarketplaceAgentInstallRequest,
  type MarketplaceAgentMutationError,
  type WorkspaceOnboardingRequest,
  type WorkspaceOnboardingResponse,
  type OnboardingPaymentCompleteRequest,
  type OnboardingPaymentIntentRequest,
  type OnboardingPaymentIntentResponse,
  type OnboardingPaymentStatus,
  type OnboardingRecommendationsRequest,
  type OnboardingRecommendationsResponse,
  type MarketplaceAgentSubscriptionList,
  type MarketplaceAgentSubscriptionResponse,
  type BillingHistoryResponse,
  type UsageReportPeriod,
  type UsageReportResponse,
  type WorkspaceLedgerResponse,
  type UserBillingOverview,
  type UserProfile,
  type WorkspaceAuditPage,
  type WorkspaceInvite,
  type ModelSelectionId,
  type WorkspaceRole,
  type WorkspaceCreateResult,
  type VmTelemetryHistoryResponse,
  type InternalAdminCommand,
  type InternalAdminOfficialHubAccess,
  type InternalAdminOfficialHubSync,
  type InternalAdminDirectory,
  type InternalAdminFeedback,
  type InternalAdminFile,
  type InternalAdminLog,
  type InternalAdminFreeCredits,
  type InternalAdminListingTakedownResult,
  type InternalAdminOperationResult,
  type InternalAdminSearchResponse,
  type InternalAdminVmStatus,
  type InternalAdminFleetHealth,
  type InternalAdminInferenceMargin,
  type InternalAdminModelRouterPolicy,
  type InternalAdminModelRouterPolicyRequest,
  type InternalAdminVmUpdates,
  type InternalAdminWorkspaceDetail,
  type InternalAdminWorkspaceMutationRequest,
  type InternalAdminCleanupPreview,
  type InternalAdminCleanupOperation,
  type FileListResponse,
  type FileOperationRequest,
  type FileOperationResponse,
  type FileStatResponse,
  type FileWriteResponse,
  type IncomingShare,
  type ShareRequest,
  type CreateShareRequest,
  type ShareListResponse,
  type ShareResponse,
  type SetIntegrationAgentPolicyRequest,
  WorkspaceSkillsPageSchema,
  AgentRosterPageSchema,
  type AgentRosterPage,
  type WorkspaceSkillsPage,
} from '@repo/contract'

import type { VersionedFile } from '../files/lib/types'
import { defaultSessionApiPath } from './default-session-route'
import { ROOT_TRAIN_SCOPE, trainPath, type TrainScope } from './train-scope'

export { ROOT_TRAIN_SCOPE, type TrainScope } from './train-scope'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const ConnectedProviderListItemSchema = ConnectedProviderStatusSchema.extend({
  canDisconnect: z.boolean(),
})
const ConnectedProviderListResponseSchema = z.array(ConnectedProviderListItemSchema)
const ConnectedProviderDisconnectResponseSchema = z.object({ ok: z.literal(true) }).strip()

export type ConnectedProviderListItem = ConnectedProviderStatus & { canDisconnect: boolean }

/**
 * The custom-server consent leg. Local rather than in `@repo/contract` for the
 * same reason the API keeps its request schema local: neither the connect route
 * nor the callback it leads to is a published endpoint — one answers a URL only
 * a browser can act on, the other is a redirect target for a third party.
 *
 * The HTTPS refusal is the same one the connected-app connect response carries.
 * A plaintext consent page would carry the authorization code back in the
 * clear, so a URL that fails it is a failed response, not one to navigate to.
 */
const McpServerConnectResponseSchema = z.object({
  authorizeUrl: z
    .string()
    .url()
    .refine(value => value.startsWith('https://'), 'authorizeUrl must use HTTPS'),
})
export type McpServerConnectResponse = z.infer<typeof McpServerConnectResponseSchema>
export type McpServerConnectRequest = { redirectTo?: string }
export type PageOptions = { cursor?: string; limit?: number; signal?: AbortSignal }
export type AgentListOptions = PageOptions & Partial<Pick<AgentListQuery, 'id' | 'slug'>>

export class DuetApiError extends Error {
  override readonly name = 'DuetApiError'

  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
    readonly data?: unknown,
  ) {
    super(message)
  }
}

export class DuetApiClient {
  private readonly fetchImpl: FetchLike

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = (input, init) => fetchImpl(input, init)
  }

  async recordAnalyticsEvent(input: BrowserAnalyticsEventRequest): Promise<void> {
    await this.request('/api/duet/analytics/events', z.object({}), jsonRequest('POST', input))
  }

  async whoami(signal?: AbortSignal): Promise<WhoamiResponse> {
    return await this.request('/api/duet/whoami', WhoamiResponseSchema, { signal })
  }

  async mintDesktopSession(
    workspaceSlug: string,
    embedOrigin: string,
    signal?: AbortSignal,
  ): Promise<DesktopSessionResponse> {
    return await this.request(
      workspacePath(workspaceSlug, 'desktop/session'),
      DesktopSessionResponseSchema,
      jsonRequest('POST', { embedOrigin }, signal),
    )
  }

  async readDesktopStatus(
    workspaceSlug: string,
    signal?: AbortSignal,
  ): Promise<DesktopStatusResponse> {
    return await this.request(
      workspacePath(workspaceSlug, 'desktop/status'),
      DesktopStatusResponseSchema,
      { signal },
    )
  }

  async focusDesktopOwner(
    workspaceSlug: string,
    agentSlug: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<{ focused: boolean }> {
    return await this.request(
      workspacePath(workspaceSlug, `agents/${encodeURIComponent(agentSlug)}/desktop/focus`),
      FocusBrowserOwnerResultSchema,
      jsonRequest('POST', { requestId }, signal),
    )
  }

  async deviceApproval(
    action: DeviceApprovalAction,
    userCode: string,
    signal?: AbortSignal,
  ): Promise<DeviceApprovalResponse> {
    return await this.request(
      `/api/duet/device/${action}`,
      DeviceApprovalResponseSchema,
      jsonRequest('POST', { userCode }, signal),
    )
  }

  async inspectOAuthAuthorization(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<OAuthConsentInspectResponse> {
    return await this.request(
      `/api/duet/oauth/authorization/${encodeURIComponent(requestId)}`,
      OAuthConsentInspectResponseSchema,
      { signal },
    )
  }

  async approveOAuthAuthorization(
    requestId: string,
    workspaceSlug: string,
    signal?: AbortSignal,
  ): Promise<OAuthConsentApproveResponse> {
    return await this.request(
      `/api/duet/oauth/authorization/${encodeURIComponent(requestId)}/approve`,
      OAuthConsentApproveResponseSchema,
      jsonRequest('POST', { workspaceSlug }, signal),
    )
  }

  async denyOAuthAuthorization(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<OAuthConsentDenyResponse> {
    return await this.request(
      `/api/duet/oauth/authorization/${encodeURIComponent(requestId)}/deny`,
      OAuthConsentDenyResponseSchema,
      jsonRequest('POST', {}, signal),
    )
  }

  async createWorkspace(
    input: { name: string; slug: string },
    signal?: AbortSignal,
  ): Promise<WorkspaceCreateResult> {
    return await this.request('/api/duet/workspaces', WorkspaceCreateResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
  }

  async listShareRequests(options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `/api/duet/share-requests${params ? `?${params}` : ''}`,
      PendingShareListResponseSchema,
      { signal: options.signal },
    )
  }

  async consumePendingShare(signal?: AbortSignal): Promise<ShareRequest | 'unavailable' | null> {
    let response: Response
    try {
      response = await this.requestResponse('/api/duet/pending-share', { signal })
    } catch (error) {
      if (error instanceof DuetApiError && (error.status === 404 || error.status === 410)) {
        return 'unavailable'
      }
      throw error
    }
    if (response.status === 204) return null
    const payload = await response.json().catch(() => undefined)
    const parsed = ShareRequestResponseSchema.safeParse(payload)
    if (!parsed.success) {
      throw new DuetApiError(502, 'invalid_response', 'Duet API response failed validation')
    }
    return parsed.data.share
  }

  async resolveShareToken(token: string, signal?: AbortSignal): Promise<{ share: ShareRequest }> {
    return await this.request(
      `/api/duet/share-requests/${encodeURIComponent(token)}`,
      ShareRequestResponseSchema,
      { signal },
    )
  }

  async acceptShare(
    shareId: string,
    input: { toWorkspaceId: string; mountPath: string },
    signal?: AbortSignal,
  ): Promise<{ share: IncomingShare }> {
    return await this.request(
      `/api/duet/share-requests/${encodeURIComponent(shareId)}/accept`,
      IncomingShareResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async declineShare(shareId: string, signal?: AbortSignal): Promise<{ ok: true }> {
    return await this.request(
      `/api/duet/share-requests/${encodeURIComponent(shareId)}/decline`,
      ShareDeclinedResponseSchema,
      jsonRequest('POST', {}, signal),
    )
  }

  async readWorkspaceFile(
    workspaceSlug: string,
    path: string,
    options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
  ): Promise<VersionedFile> {
    const headers =
      options.range === undefined
        ? undefined
        : { range: `bytes=${options.range.start}-${options.range.end}` }
    const response = await this.requestResponse(workspaceFilePath(workspaceSlug, path), {
      headers,
      signal: options.signal,
    })
    return await versionedFileFrom(response)
  }

  /**
   * A read of a file that is allowed not to exist — an agent's `agent.json`,
   * say. `null` is the missing-file answer, and it arrives as an empty 204
   * rather than a 404, so the browser has no failed request to log for a file
   * whose absence is ordinary. Anything else that goes wrong still throws.
   */
  async readOptionalWorkspaceFile(
    workspaceSlug: string,
    path: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<VersionedFile | null> {
    const response = await this.requestResponse(
      `${workspaceFilePath(workspaceSlug, path)}?${queryString({ [FILES_OPTIONAL_QUERY]: 1 })}`,
      { signal: options.signal },
    )
    return response.status === 204 ? null : await versionedFileFrom(response)
  }

  async writeWorkspaceFile(
    workspaceSlug: string,
    path: string,
    data: Uint8Array,
    options: { ifMatch?: string; contentType?: string; signal?: AbortSignal } = {},
  ): Promise<FileWriteResponse> {
    const headers = new Headers({
      'content-type': options.contentType ?? 'application/octet-stream',
    })
    if (options.ifMatch !== undefined) headers.set('if-match', options.ifMatch)
    return await this.request(workspaceFilePath(workspaceSlug, path), FileWriteResponseSchema, {
      method: 'PUT',
      headers,
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      signal: options.signal,
    })
  }

  async listWorkspaceFiles(
    workspaceSlug: string,
    path = '',
    options: PageOptions = {},
  ): Promise<FileListResponse> {
    const filePath =
      path.length === 0 ? workspaceFilesPath(workspaceSlug) : workspaceFilePath(workspaceSlug, path)
    const query = queryString({ list: 1, cursor: options.cursor, limit: options.limit })
    return await this.request(`${filePath}?${query}`, FileListResponseSchema, {
      signal: options.signal,
    })
  }

  /**
   * A listing of a folder that is allowed not to exist — an agent's
   * `.agents/skills`, say. `null` is the missing-folder answer; an empty page
   * is a folder that exists and holds nothing. Same wire shape as
   * {@link readOptionalWorkspaceFile}: a 204 in place of the 404.
   */
  async listOptionalWorkspaceFiles(
    workspaceSlug: string,
    path: string,
    options: PageOptions = {},
  ): Promise<FileListResponse | null> {
    const query = queryString({
      list: 1,
      cursor: options.cursor,
      limit: options.limit,
      [FILES_OPTIONAL_QUERY]: 1,
    })
    const response = await this.requestResponse(
      `${workspaceFilePath(workspaceSlug, path)}?${query}`,
      { signal: options.signal },
    )
    return response.status === 204 ? null : FileListResponseSchema.parse(await response.json())
  }

  async statWorkspaceFile(
    workspaceSlug: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileStatResponse> {
    return await this.request(
      `${workspaceFilePath(workspaceSlug, path)}?stat=1`,
      FileStatResponseSchema,
      { signal },
    )
  }

  /**
   * An existence probe: the stat of a path the caller half expects not to be
   * there — the name an upload is about to claim. `null` is "not there", and
   * like the other optional reads it arrives as a 204 rather than a 404 the
   * browser would log on the ordinary path.
   */
  async statOptionalWorkspaceFile(
    workspaceSlug: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<FileStatResponse | null> {
    const query = queryString({ stat: 1, [FILES_OPTIONAL_QUERY]: 1 })
    const response = await this.requestResponse(
      `${workspaceFilePath(workspaceSlug, path)}?${query}`,
      { signal },
    )
    return response.status === 204 ? null : FileStatResponseSchema.parse(await response.json())
  }

  async operateOnWorkspaceFiles(
    workspaceSlug: string,
    operation: FileOperationRequest,
    signal?: AbortSignal,
  ): Promise<FileOperationResponse> {
    return await this.request(
      `${workspaceFilesPath(workspaceSlug)}/actions`,
      FileOperationResponseSchema,
      jsonRequest('POST', operation, signal),
    )
  }

  workspaceFileDownloadUrl(
    workspaceSlug: string,
    path: string,
    options: { version?: string | number } = {},
  ): string {
    const url = workspaceFilePath(workspaceSlug, path)
    return options.version === undefined
      ? url
      : `${url}?v=${encodeURIComponent(String(options.version))}`
  }

  async listApps(
    workspaceSlug: string,
    options: ListAppsQuery & { signal?: AbortSignal } = {},
  ): Promise<AppListResponse> {
    const params = new URLSearchParams(
      queryString({
        id: options.id,
        cwd: options.cwd,
        cursor: options.cursor,
        limit: typeof options.limit === 'number' ? options.limit : undefined,
        scope: options.scope,
      }),
    )
    // queryString() drops empty strings, but the drive root IS the empty
    // path, and the API refuses a scope without its path.
    if (options.path !== undefined) params.set('path', options.path)
    const query = params.toString()
    const suffix = query === '' ? '' : `?${query}`
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/apps${suffix}`,
      AppListResponseSchema,
      { signal: options.signal },
    )
  }

  async listShares(workspaceSlug: string, options: PageOptions = {}): Promise<ShareListResponse> {
    const params = pageQueryString(options)
    return await this.request(
      `${workspacePath(workspaceSlug, 'shares')}${params ? `?${params}` : ''}`,
      ShareListResponseSchema,
      { signal: options.signal },
    )
  }

  async listConnectedProviders(
    workspaceSlug: string,
    signal?: AbortSignal,
  ): Promise<ConnectedProviderListItem[]> {
    return await this.request(
      workspacePath(workspaceSlug, 'connected-providers'),
      ConnectedProviderListResponseSchema,
      { signal },
    )
  }

  /**
   * The skills an agent would see if it ran in `cwd` (drive-relative; omitted
   * for the drive root). Read live from the workspace VM, which owns the files.
   */
  async listWorkspaceSkills(
    workspaceSlug: string,
    cwd: string | undefined,
    options: PageOptions = {},
  ): Promise<WorkspaceSkillsPage> {
    const query = queryString({ cwd, cursor: options.cursor, limit: options.limit })
    return await this.request(
      `${workspacePath(workspaceSlug, 'skills')}${query ? `?${query}` : ''}`,
      WorkspaceSkillsPageSchema,
      { signal: options.signal },
    )
  }

  /**
   * The agents a session can reach — its parent and its direct children, the
   * same roster the agent has in its own prompt. `agentSlug` is `root` for the
   * drive root. Read live from the workspace VM, which owns the projection.
   */
  async readAgentRoster(
    workspaceSlug: string,
    agentSlug: string,
    options: PageOptions = {},
  ): Promise<AgentRosterPage> {
    const query = pageQueryString(options)
    return await this.request(
      `${workspacePath(workspaceSlug, 'agents')}/${encodeURIComponent(agentSlug)}/roster${query.length === 0 ? '' : `?${query}`}`,
      AgentRosterPageSchema,
      { signal: options.signal },
    )
  }

  async connectConnectedProvider(
    workspaceSlug: string,
    provider: ConnectedProviderId,
    signal?: AbortSignal,
  ): Promise<ConnectStartResponse> {
    return await this.request(
      `${workspacePath(workspaceSlug, 'connected-providers')}/${encodeURIComponent(provider)}/connect`,
      ConnectStartResponseSchema,
      { method: 'POST', signal },
    )
  }

  async pollConnectedProvider(
    workspaceSlug: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ConnectPollResponse> {
    return await this.request(
      `${workspacePath(workspaceSlug, 'connected-providers')}/connect/${encodeURIComponent(sessionId)}`,
      ConnectPollResponseSchema,
      { signal },
    )
  }

  async disconnectConnectedProvider(
    workspaceSlug: string,
    provider: ConnectedProviderId,
    signal?: AbortSignal,
  ): Promise<{ ok: true }> {
    return await this.request(
      `${workspacePath(workspaceSlug, 'connected-providers')}/${encodeURIComponent(provider)}`,
      ConnectedProviderDisconnectResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async listPublishes(
    workspaceSlug: string,
    options: PageOptions = {},
  ): Promise<z.output<typeof PublishListResponseSchema>> {
    const params = pageQueryString(options)
    return await this.request(
      `${workspacePath(workspaceSlug, 'publishes')}${params ? `?${params}` : ''}`,
      PublishListResponseSchema,
      {
        signal: options.signal,
      },
    )
  }

  async setPublishPaused(
    workspaceSlug: string,
    publishSlug: string,
    paused: boolean,
    signal?: AbortSignal,
  ): Promise<z.output<typeof PublishResponseSchema>> {
    return await this.request(
      `${workspacePath(workspaceSlug, 'publishes')}/${encodeURIComponent(publishSlug)}/pause`,
      PublishResponseSchema,
      jsonRequest('POST', { paused }, signal),
    )
  }

  async setSharePaused(
    workspaceSlug: string,
    shareId: string,
    paused: boolean,
    signal?: AbortSignal,
  ): Promise<ShareResponse> {
    return await this.request(
      `${workspacePath(workspaceSlug, 'shares')}/${encodeURIComponent(shareId)}/pause`,
      ShareResponseSchema,
      jsonRequest('POST', { paused }, signal),
    )
  }

  async createShare(
    workspaceSlug: string,
    input: CreateShareRequest,
    signal?: AbortSignal,
  ): Promise<ShareResponse> {
    return await this.request(
      workspacePath(workspaceSlug, 'shares'),
      ShareResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async unlinkShare(workspaceSlug: string, shareId: string, signal?: AbortSignal) {
    return await this.request(
      `${workspacePath(workspaceSlug, 'shares')}/${encodeURIComponent(shareId)}/unlink`,
      ShareUnlinkedResponseSchema,
      jsonRequest('POST', {}, signal),
    )
  }

  async revokeShare(workspaceSlug: string, shareId: string, signal?: AbortSignal) {
    return await this.request(
      `${workspacePath(workspaceSlug, 'shares')}/${encodeURIComponent(shareId)}`,
      ShareRevokedResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async listWorkspaceBackups(workspaceSlug: string, options: PageOptions = {}) {
    return this.request(
      `${workspacePath(workspaceSlug, 'backups')}?${pageQueryString(options)}`,
      BackupListResponseSchema,
      { signal: options.signal },
    )
  }

  async getWorkspaceBackup(workspaceSlug: string, backupId: string, signal?: AbortSignal) {
    return this.request(
      `${workspacePath(workspaceSlug, 'backups')}/${encodeURIComponent(backupId)}`,
      BackupResponseSchema,
      { signal },
    )
  }

  async createWorkspaceBackup(
    workspaceSlug: string,
    input: z.input<typeof BackupCreateRequestSchema>,
  ) {
    return this.request(
      workspacePath(workspaceSlug, 'backups'),
      BackupResponseSchema,
      jsonRequest('POST', input),
    )
  }

  async downloadWorkspaceBackup(workspaceSlug: string, backupId: string) {
    return this.request(
      `${workspacePath(workspaceSlug, 'backups')}/${encodeURIComponent(backupId)}/download`,
      BackupDownloadResponseSchema,
      jsonRequest('POST', {}),
    )
  }

  async deleteWorkspaceBackup(workspaceSlug: string, backupId: string) {
    return this.request(
      `${workspacePath(workspaceSlug, 'backups')}/${encodeURIComponent(backupId)}`,
      BackupDeleteResponseSchema,
      { method: 'DELETE' },
    )
  }

  async updateWorkspace(
    workspaceSlug: string,
    input: { slug: string; name: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      `/api/duet/workspaces/${encodeURIComponent(workspaceSlug)}`,
      z.object({ ok: z.literal(true), breaksPublicUrls: z.literal(true) }),
      jsonRequest('PATCH', { ...input, publicUrlBreakAcknowledged: true }, signal),
    )
  }

  async setWorkspaceDefaultTier(
    workspaceSlug: string,
    tier: ModelSelectionId,
    signal?: AbortSignal,
  ) {
    return await this.request(
      workspacePath(workspaceSlug, 'default-model'),
      WorkspaceDefaultModelResponseSchema,
      jsonRequest('PUT', { tier }, signal),
    )
  }

  async listWorkspaceMembers(
    workspaceSlug: string,
    options: { cursor?: string; limit?: number; search?: string; signal?: AbortSignal } = {},
  ) {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) })
    if (options.cursor !== undefined) params.set('cursor', options.cursor)
    if (options.search !== undefined) params.set('search', options.search)
    return await this.request(
      `${workspacePath(workspaceSlug, 'members')}?${params}`,
      WorkspaceMembersPageSchema,
      { signal: options.signal },
    )
  }

  async registerApp(
    workspaceSlug: string,
    input: RegisterAppRequest,
    signal?: AbortSignal,
  ): Promise<AppResponse> {
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/apps`,
      AppResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async getApp(workspaceSlug: string, appSlug: string, signal?: AbortSignal): Promise<AppResponse> {
    return await this.request(appPath(workspaceSlug, appSlug), AppResponseSchema, { signal })
  }

  async getAppDomain(workspaceSlug: string, appSlug: string, signal?: AbortSignal) {
    return await this.request(
      `${appPath(workspaceSlug, appSlug)}/domain`,
      AppDomainResponseSchema,
      { signal },
    )
  }

  async attachAppDomain(
    workspaceSlug: string,
    appSlug: string,
    input: z.input<typeof AttachAppDomainRequestSchema>,
    signal?: AbortSignal,
  ) {
    return await this.request(
      `${appPath(workspaceSlug, appSlug)}/domain`,
      AppDomainResponseSchema,
      jsonRequest('PUT', input, signal),
    )
  }

  async recheckAppDomain(workspaceSlug: string, appSlug: string, signal?: AbortSignal) {
    return await this.request(
      `${appPath(workspaceSlug, appSlug)}/domain/recheck`,
      AppDomainResponseSchema,
      { method: 'POST', signal },
    )
  }

  async removeAppDomain(workspaceSlug: string, appSlug: string, signal?: AbortSignal) {
    return await this.request(
      `${appPath(workspaceSlug, appSlug)}/domain`,
      AppDomainResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async listAppDomains(workspaceSlug: string, options: PageOptions = {}) {
    const query = pageQueryString(options)
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/app-domains${query === '' ? '' : `?${query}`}`,
      AppDomainListResponseSchema,
      { signal: options.signal },
    )
  }

  async updateApp(
    workspaceSlug: string,
    appSlug: string,
    input: UpdateAppRequest,
    signal?: AbortSignal,
  ): Promise<AppResponse> {
    return await this.request(
      appPath(workspaceSlug, appSlug),
      AppResponseSchema,
      jsonRequest('PATCH', input, signal),
    )
  }

  async setAppVisibility(
    workspaceSlug: string,
    appSlug: string,
    visibility: AppVisibility,
    signal?: AbortSignal,
  ): Promise<AppResponse> {
    return await this.request(
      `${appPath(workspaceSlug, appSlug)}/visibility`,
      AppResponseSchema,
      jsonRequest('POST', { visibility }, signal),
    )
  }

  async deleteApp(
    workspaceSlug: string,
    appSlug: string,
    signal?: AbortSignal,
  ): Promise<DeleteAppResponse> {
    return await this.request(appPath(workspaceSlug, appSlug), DeleteAppResponseSchema, {
      method: 'DELETE',
      signal,
    })
  }

  async listAgents(
    workspaceSlug: string,
    options: AgentListOptions = {},
  ): Promise<AgentListResponse> {
    const params = new URLSearchParams(pageQueryString(options))
    if (options.id !== undefined) params.set('id', options.id)
    if (options.slug !== undefined) params.set('slug', options.slug)
    return await this.request(
      `${agentsPath(workspaceSlug)}${params.size > 0 ? `?${params}` : ''}`,
      AgentListResponseSchema,
      { signal: options.signal },
    )
  }

  async openAgentOnboardingSession(
    workspaceSlug: string,
    agentSlug: string,
    signal?: AbortSignal,
  ): Promise<OpenOnboardingSessionResponse> {
    return await this.request(
      `${agentPath(workspaceSlug, agentSlug)}/onboarding-session`,
      OpenOnboardingSessionResponseSchema,
      { method: 'POST', signal },
    )
  }

  /**
   * Carries `canPublishListings` alongside the listings: the SPA renders the
   * publish control from a server-projected capability and never decides for
   * itself whether publishing is open.
   */
  async listMarketplaceCatalog(
    options: PageOptions & {
      q?: string
      tag?: AgentTag
      availability?: 'available' | 'unavailable'
      verifiedPublisher?: boolean
    } = {},
  ): Promise<MarketplaceCatalogResponse> {
    const params = queryString({
      cursor: options.cursor,
      limit: options.limit,
      q: options.q,
      tag: options.tag,
      availability: options.availability,
      verifiedPublisher:
        options.verifiedPublisher === undefined ? undefined : String(options.verifiedPublisher),
    })
    return await this.request(
      `/api/duet/marketplace${params ? `?${params}` : ''}`,
      MarketplaceCatalogResponseSchema,
      {
        signal: options.signal,
      },
    )
  }

  /** Addressed by publisher AND agent — two publishers may ship the same name. */
  async getMarketplaceListingDetail(
    publisherSlug: string,
    agentName: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceListingDetail> {
    return await this.request(
      `/api/duet/marketplace/${encodeURIComponent(publisherSlug)}/${encodeURIComponent(agentName)}`,
      MarketplaceListingDetailSchema,
      { signal },
    )
  }

  async listMarketplaceAgentSubscriptions(
    workspaceSlug: string,
    options: PageOptions = {},
  ): Promise<MarketplaceAgentSubscriptionList> {
    const params = pageQueryString(options)
    return await this.request(
      `${marketplaceSubscriptionsPath(workspaceSlug)}${params ? `?${params}` : ''}`,
      MarketplaceAgentSubscriptionListSchema,
      { signal: options.signal },
    )
  }

  async installMarketplaceAgent(
    workspaceSlug: string,
    input: MarketplaceAgentInstallRequest,
    signal?: AbortSignal,
  ): Promise<MarketplaceAgentSubscriptionResponse> {
    return await this.request(
      marketplaceSubscriptionsPath(workspaceSlug),
      MarketplaceAgentSubscriptionResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async completeWorkspaceOnboarding(
    workspaceSlug: string,
    input: WorkspaceOnboardingRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceOnboardingResponse> {
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/onboarding`,
      WorkspaceOnboardingResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async createOnboardingPaymentIntent(
    workspaceSlug: string,
    input: OnboardingPaymentIntentRequest,
    signal?: AbortSignal,
  ): Promise<OnboardingPaymentIntentResponse> {
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/onboarding/payment-method/intent`,
      OnboardingPaymentIntentResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async completeOnboardingPayment(
    workspaceSlug: string,
    input: OnboardingPaymentCompleteRequest,
    signal?: AbortSignal,
  ): Promise<OnboardingPaymentStatus> {
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/onboarding/payment-method/complete`,
      OnboardingPaymentStatusSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async onboardingPaymentStatus(
    workspaceSlug: string,
    signal?: AbortSignal,
  ): Promise<OnboardingPaymentStatus> {
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/onboarding/payment-method`,
      OnboardingPaymentStatusSchema,
      { signal },
    )
  }

  /**
   * The onboarding "picked for you" agents. Owner-only and 404 once the
   * workspace is onboarded; the response is always exactly 4 picks or empty
   * (empty means the team step renders the plain catalog).
   */
  async recommendOnboardingAgents(
    workspaceSlug: string,
    input: OnboardingRecommendationsRequest,
    signal?: AbortSignal,
  ): Promise<OnboardingRecommendationsResponse> {
    return await this.request(
      `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/onboarding/recommendations`,
      OnboardingRecommendationsResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async cloneMarketplaceAgent(
    workspaceSlug: string,
    input: MarketplaceAgentCloneRequest,
    signal?: AbortSignal,
  ): Promise<MarketplaceAgentSubscriptionResponse> {
    return await this.request(
      `${marketplaceSubscriptionsPath(workspaceSlug)}/clone`,
      MarketplaceAgentSubscriptionResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async acknowledgeMarketplaceAgent(
    workspaceSlug: string,
    subscriptionId: string,
    signal?: AbortSignal,
  ): Promise<MarketplaceAgentSubscriptionResponse> {
    return await this.request(
      `${marketplaceSubscriptionsPath(workspaceSlug)}/${encodeURIComponent(subscriptionId)}/acknowledge`,
      MarketplaceAgentSubscriptionResponseSchema,
      { method: 'POST', signal },
    )
  }

  async uninstallMarketplaceAgent(
    workspaceSlug: string,
    subscriptionId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof MarketplaceAgentUninstallResponseSchema>> {
    return await this.request(
      `${marketplaceSubscriptionsPath(workspaceSlug)}/${encodeURIComponent(subscriptionId)}`,
      MarketplaceAgentUninstallResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async registerAgent(
    workspaceSlug: string,
    input: RegisterAgentRequest,
    signal?: AbortSignal,
  ): Promise<RegisterAgentResponse> {
    return await this.request(
      agentsPath(workspaceSlug),
      RegisterAgentResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async updateAgent(
    workspaceSlug: string,
    agentSlug: string,
    input: UpdateAgentRequest,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    return await this.request(
      agentPath(workspaceSlug, agentSlug),
      AgentResponseSchema,
      jsonRequest('PATCH', input, signal),
    )
  }

  /**
   * Rename the default agent. Its own call rather than `updateAgent(ws, 'root')`
   * because the response is a bare `{name}`, not an `Agent` — the drive root has
   * no row to return, and parsing this as one would mean inventing it.
   */
  async updateDefaultAgent(
    workspaceSlug: string,
    input: UpdateDefaultAgentRequest,
    signal?: AbortSignal,
  ): Promise<DefaultAgentResponse> {
    return await this.request(
      agentPath(workspaceSlug, ROOT_AGENT_SCOPE),
      DefaultAgentResponseSchema,
      jsonRequest('PATCH', input, signal),
    )
  }

  async setAgentOnboarded(
    workspaceSlug: string,
    agentSlug: string,
    input: SetAgentOnboardedRequest,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    return await this.request(
      `${agentPath(workspaceSlug, agentSlug)}/onboarded`,
      AgentResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async deleteAgent(
    workspaceSlug: string,
    agentSlug: string,
    signal?: AbortSignal,
  ): Promise<DeleteAgentResponse> {
    return await this.request(agentPath(workspaceSlug, agentSlug), DeleteAgentResponseSchema, {
      method: 'DELETE',
      signal,
    })
  }

  async updateWorkspaceMember(
    workspaceSlug: string,
    userId: string,
    role: WorkspaceRole,
    signal?: AbortSignal,
  ) {
    return await this.request(
      `${workspacePath(workspaceSlug, 'members')}/${encodeURIComponent(userId)}`,
      WorkspaceMemberRoleResponseSchema,
      jsonRequest('PATCH', { role }, signal),
    )
  }

  async removeWorkspaceMember(workspaceSlug: string, userId: string, signal?: AbortSignal) {
    return await this.request(
      `${workspacePath(workspaceSlug, 'members')}/${encodeURIComponent(userId)}`,
      WorkspaceMemberRemovedSchema,
      { method: 'DELETE', signal },
    )
  }

  async setWorkspaceBillingUser(workspaceSlug: string, userId: string, signal?: AbortSignal) {
    return await this.request(
      workspacePath(workspaceSlug, 'billing-user'),
      WorkspaceBillingUserResponseSchema,
      jsonRequest('PUT', { userId }, signal),
    )
  }

  async listIncomingInvitations(options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `/api/duet/user/invitations${params ? `?${params}` : ''}`,
      IncomingWorkspaceInvitePageSchema,
      { signal: options.signal },
    )
  }

  async acceptInvitation(inviteId: string, signal?: AbortSignal) {
    return await this.request(
      `/api/duet/user/invitations/${encodeURIComponent(inviteId)}/accept`,
      WorkspaceInviteAcceptedSchema,
      { method: 'POST', signal },
    )
  }

  async listWorkspaceInvites(workspaceSlug: string, options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `${workspacePath(workspaceSlug, 'invites')}${params ? `?${params}` : ''}`,
      WorkspaceInvitePageSchema,
      { signal: options.signal },
    )
  }

  async createWorkspaceInvite(
    workspaceSlug: string,
    input: { email: string; role: 'editor' | 'viewer' },
    signal?: AbortSignal,
  ): Promise<WorkspaceInvite> {
    return await this.request(
      workspacePath(workspaceSlug, 'invites'),
      WorkspaceInviteSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async revokeWorkspaceInvite(workspaceSlug: string, inviteId: string, signal?: AbortSignal) {
    return await this.request(
      `${workspacePath(workspaceSlug, 'invites')}/${encodeURIComponent(inviteId)}`,
      WorkspaceInviteRevokedSchema,
      { method: 'DELETE', signal },
    )
  }

  async listWorkspaceAudit(
    workspaceSlug: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<WorkspaceAuditPage> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 50) })
    if (options.cursor !== undefined) params.set('cursor', options.cursor)
    return await this.request(
      `${workspacePath(workspaceSlug, 'audit')}?${params}`,
      WorkspaceAuditPageSchema,
      { signal: options.signal },
    )
  }

  async workspaceUsage(
    workspaceSlug: string,
    options: { period?: UsageReportPeriod; currentOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<UsageReportResponse> {
    const period = options.period ?? 'monthly'
    const month = currentMonthKey()
    const range = options.currentOnly === false ? '' : `&start=${month}&end=${month}`
    return await this.request(
      `${workspacePath(workspaceSlug, 'billing/usage')}?period=${period}&group=workspace${range}`,
      UsageReportResponseSchema,
      { signal: options.signal },
    )
  }

  async workspaceTelemetry(
    workspaceSlug: string,
    sinceAt?: number,
    signal?: AbortSignal,
  ): Promise<VmTelemetryHistoryResponse> {
    const params = new URLSearchParams()
    if (sinceAt !== undefined) params.set('sinceAt', String(sinceAt))
    const query = params.size === 0 ? '' : `?${params}`
    return await this.request(
      `${workspacePath(workspaceSlug, 'telemetry')}${query}`,
      VmTelemetryHistoryResponseSchema,
      { signal },
    )
  }

  async workspaceLedger(
    workspaceSlug: string,
    options: PageOptions = {},
  ): Promise<WorkspaceLedgerResponse> {
    const params = pageQueryString(options)
    return await this.request(
      `${workspacePath(workspaceSlug, 'billing/ledger')}${params ? `?${params}` : ''}`,
      WorkspaceLedgerPageSchema,
      { signal: options.signal },
    )
  }

  async sendFeedback(content: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      '/api/duet/feedback',
      FeedbackAcceptedResponseSchema,
      jsonRequest('POST', { content, source: 'web' }, signal),
    )
  }

  async userProfile(signal?: AbortSignal): Promise<UserProfile> {
    return await this.request('/api/duet/user/profile', UserProfileSchema, { signal })
  }

  async updateUserProfile(
    input: { firstName?: string; lastName?: string },
    signal?: AbortSignal,
  ): Promise<UserProfile> {
    return await this.request(
      '/api/duet/user/profile',
      UserProfileSchema,
      jsonRequest('PATCH', input, signal),
    )
  }

  async userBilling(signal?: AbortSignal): Promise<UserBillingOverview> {
    return await this.request('/api/duet/user/billing', UserBillingOverviewSchema, { signal })
  }

  async updateUserBilling(
    input: {
      workspaceSlug: string
      autoTopupEnabled?: boolean
      autoTopupThresholdMicroUsd?: number
      autoTopupAmountMicroUsd?: number
      maxMonthlySpendMicroUsd?: number | null
    },
    signal?: AbortSignal,
  ): Promise<UserBillingOverview> {
    return await this.request(
      '/api/duet/user/billing',
      UserBillingOverviewSchema,
      jsonRequest('PUT', input, signal),
    )
  }

  async billingHistory(options: PageOptions = {}): Promise<BillingHistoryResponse> {
    const params = pageQueryString(options)
    return await this.request(
      `/api/duet/user/billing/history${params ? `?${params}` : ''}`,
      BillingHistoryPageSchema,
      {
        signal: options.signal,
      },
    )
  }

  async createBillingCheckout(
    input: { workspaceSlug: string; amountMicroUsd?: number },
    signal?: AbortSignal,
  ) {
    return await this.request(
      '/api/duet/user/billing/checkout',
      BillingHostedSessionResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async createSubscriptionCheckout(
    input: { workspaceSlug: string; plan: SubscriptionPlanId },
    signal?: AbortSignal,
  ) {
    return await this.request(
      '/api/duet/user/billing/subscription/checkout',
      BillingHostedSessionResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async changeSubscriptionPlan(input: SubscriptionPlanChangeRequest, signal?: AbortSignal) {
    return await this.request(
      '/api/duet/user/billing/subscription/plan',
      SubscriptionPlanChangeResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async createBillingPortal(workspaceSlug: string, signal?: AbortSignal) {
    return await this.request(
      '/api/duet/user/billing/portal',
      BillingHostedSessionResponseSchema,
      jsonRequest('POST', { workspaceSlug }, signal),
    )
  }

  async listUserApiKeys(options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `/api/duet/user/api-keys${params ? `?${params}` : ''}`,
      UserApiKeyPageSchema,
      { signal: options.signal },
    )
  }

  async issueUserApiKey(
    input: {
      name: string
      expiresAt?: number
    },
    signal?: AbortSignal,
  ) {
    return await this.request(
      '/api/duet/user/api-keys',
      UserApiKeyIssuedSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async revokeUserApiKey(keyId: string, signal?: AbortSignal) {
    return await this.request(
      `/api/duet/user/api-keys/${encodeURIComponent(keyId)}`,
      UserApiKeyRevokedSchema,
      { method: 'DELETE', signal },
    )
  }

  async listOAuthGrants(options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `/api/duet/user/oauth-grants${params ? `?${params}` : ''}`,
      OAuthGrantPageSchema,
      { signal: options.signal },
    )
  }

  async revokeOAuthGrant(grantId: string, signal?: AbortSignal) {
    return await this.request(
      `/api/duet/user/oauth-grants/${encodeURIComponent(grantId)}`,
      OAuthGrantRevokedSchema,
      { method: 'DELETE', signal },
    )
  }

  async listSyncMachines(options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `/api/duet/user/sync-machines${params ? `?${params}` : ''}`,
      SyncMachinePageSchema,
      { signal: options.signal },
    )
  }

  async removeSyncMachine(machineId: string, signal?: AbortSignal) {
    return await this.request(
      `/api/duet/user/sync-machines/${encodeURIComponent(machineId)}`,
      SyncMachineRemovedSchema,
      { method: 'DELETE', signal },
    )
  }

  async listIntegrationCatalog(
    workspaceSlug: string,
    query: IntegrationCatalogQuery = {},
    signal?: AbortSignal,
  ): Promise<IntegrationCatalogPage> {
    const params = queryString({ ...query })
    return await this.request(
      `${integrationPath(workspaceSlug, 'catalog')}${params ? `?${params}` : ''}`,
      IntegrationCatalogPageSchema,
      { signal },
    )
  }

  async listIntegrationConnections(workspaceSlug: string, options: PageOptions = {}) {
    const params = pageQueryString(options)
    return await this.request(
      `${integrationPath(workspaceSlug, 'connections')}${params ? `?${params}` : ''}`,
      IntegrationConnectionListSchema,
      { signal: options.signal },
    )
  }

  async connectIntegration(
    workspaceSlug: string,
    input: IntegrationConnectRequest,
    signal?: AbortSignal,
  ): Promise<IntegrationConnectResponse> {
    return await this.request(
      integrationPath(workspaceSlug, 'connect'),
      IntegrationConnectResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async disconnectIntegration(workspaceSlug: string, connectionId: string, signal?: AbortSignal) {
    return await this.request(
      `${integrationPath(workspaceSlug, 'connections')}/${encodeURIComponent(connectionId)}`,
      IntegrationDisconnectResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async setIntegrationAgentPolicy(
    workspaceSlug: string,
    toolkitSlug: string,
    input: SetIntegrationAgentPolicyRequest,
    signal?: AbortSignal,
  ) {
    return await this.request(
      integrationPath(workspaceSlug, `${encodeURIComponent(toolkitSlug)}/agent-policy`),
      IntegrationAgentPolicyResponseSchema,
      jsonRequest('PUT', input, signal),
    )
  }

  /**
   * The custom MCP servers a workspace attaches for itself. A separate family
   * from `/integrations/*` all the way down: those routes call the connection
   * provider on every list, so serving these from there would hide a
   * workspace's own servers during someone else's outage.
   */
  async probeMcpServer(
    workspaceSlug: string,
    input: McpServerProbeRequest,
    signal?: AbortSignal,
  ): Promise<McpServerProbe> {
    return await this.request(
      `${mcpServerPath(workspaceSlug)}/probe`,
      McpServerProbeSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async addMcpServer(
    workspaceSlug: string,
    input: AddMcpServerRequest,
    signal?: AbortSignal,
  ): Promise<McpServer> {
    return await this.request(
      mcpServerPath(workspaceSlug),
      McpServerSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async listMcpServers(workspaceSlug: string, options: PageOptions = {}): Promise<McpServerList> {
    const params = pageQueryString(options)
    return await this.request(
      `${mcpServerPath(workspaceSlug)}${params ? `?${params}` : ''}`,
      McpServerListSchema,
      { signal: options.signal },
    )
  }

  /**
   * D2's OAuth branch. The answer is a URL the caller must reach by a
   * **top-level navigation**: a third party's consent page is theirs to
   * frame-protect and most refuse framing outright.
   */
  async connectMcpServer(
    workspaceSlug: string,
    name: string,
    input: McpServerConnectRequest = {},
    signal?: AbortSignal,
  ): Promise<McpServerConnectResponse> {
    return await this.request(
      `${mcpServerPath(workspaceSlug)}/${encodeURIComponent(name)}/connect`,
      McpServerConnectResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async removeMcpServer(workspaceSlug: string, name: string, signal?: AbortSignal) {
    return await this.request(
      `${mcpServerPath(workspaceSlug)}/${encodeURIComponent(name)}`,
      RemoveMcpServerResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  async setMcpServerAgentPolicy(
    workspaceSlug: string,
    name: string,
    input: SetMcpServerAgentPolicyRequest,
    signal?: AbortSignal,
  ) {
    return await this.request(
      `${mcpServerPath(workspaceSlug)}/${encodeURIComponent(name)}/agent-policy`,
      McpServerAgentPolicyResponseSchema,
      jsonRequest('PUT', input, signal),
    )
  }

  async internalAdminCreateUser(
    input: InternalAdminCreateUserRequest,
  ): Promise<InternalAdminCreateUserResult> {
    return await this.request(
      '/api/duet/internal-admin/users',
      InternalAdminCreateUserResultSchema,
      jsonRequest('POST', input),
    )
  }

  async internalAdminSearch(
    identifier: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminSearchResponse> {
    return await this.request(
      `/api/duet/internal-admin/search?q=${encodeURIComponent(identifier)}`,
      InternalAdminSearchResponseSchema,
      { signal },
    )
  }

  async internalAdminUserCleanupPreview(
    query: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminCleanupPreview> {
    return await this.request(
      `/api/duet/internal-admin/users?q=${encodeURIComponent(query)}`,
      InternalAdminCleanupPreviewSchema,
      { signal },
    )
  }

  async internalAdminStartUserCleanup(
    userId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminCleanupOperation> {
    return await this.request(
      `/api/duet/internal-admin/users/${encodeURIComponent(userId)}/cleanup`,
      InternalAdminCleanupOperationSchema,
      jsonRequest('POST', { reason }, signal),
    )
  }

  async internalAdminCleanupStatus(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminCleanupOperation> {
    return await this.request(
      `/api/duet/internal-admin/cleanup/${encodeURIComponent(operationId)}`,
      InternalAdminCleanupOperationSchema,
      { signal },
    )
  }

  async internalAdminRetryUserCleanup(
    operationId: string,
    reason: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminCleanupOperation> {
    return await this.request(
      `/api/duet/internal-admin/cleanup/${encodeURIComponent(operationId)}/retry`,
      InternalAdminCleanupOperationSchema,
      jsonRequest('POST', { reason }, signal),
    )
  }

  async internalAdminOpenOfficialHub(): Promise<InternalAdminOfficialHubAccess> {
    return await this.request(
      '/api/duet/internal-admin/official-hub/access',
      InternalAdminOfficialHubAccessSchema,
      { method: 'POST' },
    )
  }

  /**
   * Push the deployed repo's official agents onto the hub. Always converges,
   * so the interesting part of the answer is `written` — an empty list means
   * the hub already matched.
   */
  async internalAdminSyncOfficialHub(): Promise<InternalAdminOfficialHubSync> {
    return await this.request(
      '/api/duet/internal-admin/official-hub/sync',
      InternalAdminOfficialHubSyncSchema,
      { method: 'POST' },
    )
  }

  async internalAdminWorkspace(
    workspaceId: string,
    month?: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminWorkspaceDetail> {
    const params = month === undefined ? '' : `?month=${encodeURIComponent(month)}`
    return await this.request(
      `${adminWorkspacePath(workspaceId)}${params}`,
      InternalAdminWorkspaceDetailSchema,
      { signal },
    )
  }

  async internalAdminFeedback(
    archived: boolean,
    signal?: AbortSignal,
  ): Promise<{ feedback: InternalAdminFeedback[]; auditId: string }> {
    return await this.request(
      `/api/duet/internal-admin/feedback?archived=${archived ? '1' : '0'}`,
      InternalAdminFeedbackListSchema,
      { signal },
    )
  }

  async internalAdminMutateFeedback(
    feedbackId: string,
    operation: 'archive' | 'unarchive' | 'delete',
    reason: string,
  ): Promise<InternalAdminOperationResult> {
    return await this.request(
      `/api/duet/internal-admin/feedback/${encodeURIComponent(feedbackId)}`,
      InternalAdminOperationResultSchema,
      jsonRequest('POST', {
        operation,
        reason,
        ...(operation === 'delete' ? { confirmation: 'DELETE' } : {}),
      }),
    )
  }

  async internalAdminFreeCredits(signal?: AbortSignal): Promise<InternalAdminFreeCredits> {
    return await this.request(
      '/api/duet/internal-admin/free-credits',
      InternalAdminFreeCreditsSchema,
      { signal },
    )
  }

  async internalAdminResetFreeCredits(
    reason: string,
    confirmation: string,
  ): Promise<InternalAdminOperationResult> {
    return await this.request(
      '/api/duet/internal-admin/free-credits/reset',
      InternalAdminOperationResultSchema,
      jsonRequest('POST', { reason, confirmation }),
    )
  }

  async internalAdminVmUpdates(signal?: AbortSignal): Promise<InternalAdminVmUpdates> {
    return await this.request('/api/duet/internal-admin/vm-updates', InternalAdminVmUpdatesSchema, {
      signal,
    })
  }

  /** Whole-fleet control-plane snapshot: versions, heartbeats, and latest CPU. */
  async internalAdminFleetHealth(signal?: AbortSignal): Promise<InternalAdminFleetHealth> {
    return await this.request(
      '/api/duet/internal-admin/fleet-health',
      InternalAdminFleetHealthSchema,
      { signal },
    )
  }

  /** Fleet-wide model spend: upstream cost against billed, per period, tier, and model. */
  async internalAdminInferenceMargin(
    granularity: UsageReportPeriod,
    through: number | undefined,
    signal?: AbortSignal,
  ): Promise<InternalAdminInferenceMargin> {
    const query = new URLSearchParams({ granularity })
    if (through !== undefined) query.set('through', String(through))
    return await this.request(
      `/api/duet/internal-admin/inference-margin?${query}`,
      InternalAdminInferenceMarginSchema,
      { signal },
    )
  }

  async internalAdminModelRouterPolicy(
    signal?: AbortSignal,
  ): Promise<InternalAdminModelRouterPolicy> {
    return await this.request(
      '/api/duet/internal-admin/model-router',
      InternalAdminModelRouterPolicySchema,
      { signal },
    )
  }

  async internalAdminSetModelRouterPolicy(
    input: InternalAdminModelRouterPolicyRequest,
  ): Promise<InternalAdminModelRouterPolicy> {
    return await this.request(
      '/api/duet/internal-admin/model-router',
      InternalAdminModelRouterPolicySchema,
      jsonRequest('POST', input),
    )
  }

  /** The global fleet update brake: stops runtime activation. */
  async internalAdminSetVmUpdates(
    paused: boolean,
    reason: string,
  ): Promise<InternalAdminOperationResult> {
    return await this.request(
      '/api/duet/internal-admin/vm-updates',
      InternalAdminOperationResultSchema,
      jsonRequest('POST', { paused, reason }),
    )
  }

  /** Operator takedown. Irreversible for every installer at once. */
  async internalAdminTakedownListing(
    listingId: string,
    reason: string,
  ): Promise<InternalAdminListingTakedownResult> {
    return await this.request(
      `/api/duet/internal-admin/listings/${encodeURIComponent(listingId)}/takedown`,
      InternalAdminListingTakedownResultSchema,
      jsonRequest('POST', { reason, confirmation: 'TAKE DOWN LISTING' }),
    )
  }

  async internalAdminMutateWorkspace(
    workspaceId: string,
    input: InternalAdminWorkspaceMutationRequest,
  ): Promise<InternalAdminOperationResult> {
    return await this.request(
      adminWorkspacePath(workspaceId),
      InternalAdminOperationResultSchema,
      jsonRequest('POST', input),
    )
  }

  async internalAdminVmStatus(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminVmStatus> {
    return await this.request(
      `${adminWorkspacePath(workspaceId)}/vm`,
      InternalAdminVmStatusSchema,
      { signal },
    )
  }

  async internalAdminVmOperation(
    workspaceId: string,
    operation: InternalAdminVmOperation,
    reason: string,
    confirmation: string,
  ): Promise<InternalAdminVmOperationResult> {
    return await this.request(
      `${adminWorkspacePath(workspaceId)}/vm/${operation}`,
      InternalAdminVmOperationResultSchema,
      jsonRequest('POST', { reason, confirmation }),
    )
  }

  async internalAdminVmBackup(
    workspaceId: string,
    backupId: string,
    signal?: AbortSignal,
  ): Promise<Backup> {
    const result = await this.request(
      `${adminWorkspacePath(workspaceId)}/vm/backups/${encodeURIComponent(backupId)}`,
      BackupResponseSchema,
      { signal },
    )
    return result.backup
  }

  async internalAdminFiles(
    workspaceId: string,
    path = '',
    signal?: AbortSignal,
  ): Promise<InternalAdminDirectory> {
    return await this.request(
      `${adminWorkspacePath(workspaceId)}/files?path=${encodeURIComponent(path)}`,
      InternalAdminDirectorySchema,
      { signal },
    )
  }

  async internalAdminFile(
    workspaceId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminFile> {
    return await this.request(
      `${adminWorkspacePath(workspaceId)}/file?path=${encodeURIComponent(path)}`,
      InternalAdminFileSchema,
      { signal },
    )
  }

  async internalAdminLogs(
    workspaceId: string,
    source: 'gateway' | 'agent',
    anchorId?: string,
    signal?: AbortSignal,
  ): Promise<InternalAdminLog> {
    const query = new URLSearchParams({ source })
    if (anchorId !== undefined) query.set('anchorId', anchorId)
    return await this.request(
      `${adminWorkspacePath(workspaceId)}/logs?${query.toString()}`,
      InternalAdminLogSchema,
      { signal },
    )
  }

  async internalAdminCommand(
    workspaceId: string,
    command: string,
    reason: string,
  ): Promise<InternalAdminCommand> {
    return await this.request(
      `${adminWorkspacePath(workspaceId)}/command`,
      InternalAdminCommandSchema,
      jsonRequest('POST', { command, reason }),
    )
  }

  async startTraining(
    workspaceSlug: string,
    input: TrainStartRequest,
    scope: TrainScope,
    signal?: AbortSignal,
  ): Promise<TrainStartResponse> {
    return await this.request(
      trainPath(workspaceSlug, scope),
      TrainStartResponseSchema,
      jsonRequest('POST', input, signal),
    )
  }

  async listTrainJobs(
    workspaceSlug: string,
    scope: TrainScope,
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<TrainJobListResponse> {
    const suffix = queryString(query)
    return await this.request(
      `${trainPath(workspaceSlug, scope)}/jobs${suffix.length === 0 ? '' : `?${suffix}`}`,
      TrainJobListResponseSchema,
      { signal },
    )
  }

  async getTrainJob(
    workspaceSlug: string,
    jobId: string,
    scope: TrainScope,
    signal?: AbortSignal,
  ): Promise<TrainJobResponse> {
    return await this.request(
      `${trainPath(workspaceSlug, scope)}/${encodeURIComponent(jobId)}`,
      TrainJobResponseSchema,
      { signal },
    )
  }

  async listTrainRecords(
    workspaceSlug: string,
    scope: TrainScope,
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<TrainRecordListResponse> {
    const suffix = queryString(query)
    return await this.request(
      `${trainPath(workspaceSlug, scope)}/records${suffix.length === 0 ? '' : `?${suffix}`}`,
      TrainRecordListResponseSchema,
      { signal },
    )
  }

  async listTrainMemoryCounts(
    workspaceSlug: string,
    signal?: AbortSignal,
  ): Promise<TrainMemoryCountsResponse> {
    return await this.request(
      `${trainPath(workspaceSlug, ROOT_TRAIN_SCOPE)}/memory-counts`,
      TrainMemoryCountsResponseSchema,
      { signal },
    )
  }

  async getTrainRecord(
    workspaceSlug: string,
    slug: string,
    scope: TrainScope,
    signal?: AbortSignal,
  ): Promise<TrainRecordResponse> {
    return await this.request(
      trainRecordPath(workspaceSlug, scope, slug),
      TrainRecordResponseSchema,
      { signal },
    )
  }

  /**
   * Reload a memory's archived sources into the staging inbox.
   *
   * Destructive to whatever is staged, deliberately and without confirmation:
   * staged files are scratch. `fellBack` names the URLs whose re-scrape failed
   * and whose archived copy was kept instead.
   */
  async restageTrainRecord(
    workspaceSlug: string,
    slug: string,
    scope: TrainScope,
    signal?: AbortSignal,
  ): Promise<TrainRestageResponse> {
    return await this.request(
      `${trainRecordPath(workspaceSlug, scope, slug)}/restage`,
      TrainRestageResponseSchema,
      jsonRequest('POST', {}, signal),
    )
  }

  async updateTrainRecord(
    workspaceSlug: string,
    slug: string,
    content: string,
    scope: TrainScope,
    signal?: AbortSignal,
  ): Promise<TrainRecordResponse> {
    return await this.request(
      trainRecordPath(workspaceSlug, scope, slug),
      TrainRecordResponseSchema,
      jsonRequest('PATCH', { content }, signal),
    )
  }

  async deleteTrainRecord(
    workspaceSlug: string,
    slug: string,
    scope: TrainScope,
    signal?: AbortSignal,
  ): Promise<TrainRecordDeleteResponse> {
    return await this.request(
      trainRecordPath(workspaceSlug, scope, slug),
      TrainRecordDeleteResponseSchema,
      { method: 'DELETE', signal },
    )
  }

  // Derived from the contract rather than restated beside it. Restating it is
  // how this method came to advertise a `status` filter and an
  // `archived: 'include'` the server had stopped accepting: Zod strips unknown
  // keys, so the call would have succeeded and quietly returned every bucket.
  // A filter that appears to work and does not is worse than one that throws.
  async listSessions(
    workspaceSlug: string,
    // `limit` is narrowed back to a number: the contract coerces it from the
    // query string, so its *input* type is `unknown`, which a URL builder
    // cannot serialise. Everything else stays bound to the schema.
    query: Omit<z.input<typeof SessionListQuerySchema>, 'limit'> & { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<SessionListPage> {
    return await this.request(
      `${sessionCollectionPath(workspaceSlug)}?${queryString(query)}`,
      SessionListPageSchema,
      { signal },
    )
  }

  async listSessionChildren(
    workspaceSlug: string,
    sessionId: string,
    query: Omit<z.input<typeof SessionChildrenQuerySchema>, 'limit'> & { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<SessionListPage> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/sessions?${queryString(query)}`,
      SessionListPageSchema,
      { signal },
    )
  }

  async getSession(
    workspaceSlug: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    return await this.request(sessionPath(workspaceSlug, sessionId), SessionSnapshotSchema, {
      signal,
    })
  }

  async getDefaultSession(
    workspaceSlug: string,
    agentSlug: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot | null> {
    const response = await this.request(
      defaultSessionApiPath(workspaceSlug, agentSlug),
      DefaultSessionResponseSchema,
      { signal },
    )
    return response.session
  }

  /**
   * Point an owner's default-chat alias at a session, or at nothing.
   *
   * `null` is the direction the product uses: it demotes the current default
   * chat to an ordinary session — the thread stays whole and keeps running, it
   * simply stops being the one this owner's panel opens on. The answer is the
   * same body the read gives, so a caller learns what the pointer is now rather
   * than assuming the write landed the way it asked.
   */
  async setDefaultSession(
    workspaceSlug: string,
    agentSlug: string,
    sessionId: string | null,
  ): Promise<SessionSnapshot | null> {
    const body: SetDefaultSessionRequestInput = { sessionId }
    const response = await this.request(
      defaultSessionApiPath(workspaceSlug, agentSlug),
      DefaultSessionResponseSchema,
      jsonRequest('PUT', body),
    )
    return response.session
  }

  async getSessionHistory(
    workspaceSlug: string,
    sessionId: string,
    query: {
      cursor?: string
      limit?: number
      order?: 'asc' | 'desc'
      afterSeq?: number
      view?: SessionHistoryView
    } = {},
    signal?: AbortSignal,
  ): Promise<SessionHistoryPage> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/history?${queryString(query)}`,
      SessionHistoryPageSchema,
      { signal },
    )
  }

  async getSessionAudience(
    workspaceSlug: string,
    sessionId: string,
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<SessionAudiencePage> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/audience?${queryString(query)}`,
      SessionAudiencePageSchema,
      { signal },
    )
  }

  async updateSessionAudience(
    workspaceSlug: string,
    sessionId: string,
    input: SessionAudienceDeltaRequest,
  ): Promise<SessionSummary | null> {
    const response = await this.requestResponse(
      `${sessionPath(workspaceSlug, sessionId)}/audience`,
      jsonRequest('PATCH', input),
    )
    if (response.status === 204) return null
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new DuetApiError(502, 'invalid_response', 'Duet API returned invalid JSON')
    }
    const parsed = SessionSummarySchema.safeParse(payload)
    if (!parsed.success) {
      throw new DuetApiError(502, 'invalid_response', 'Duet API response failed validation')
    }
    return parsed.data
  }

  async createSession(
    workspaceSlug: string,
    input: AgentStartSessionRequestInput,
    signal?: AbortSignal,
  ): Promise<SessionCreateResponse> {
    return await this.request(sessionCollectionPath(workspaceSlug), SessionCreateResponseSchema, {
      ...jsonRequest('POST', input),
      signal,
    })
  }

  /**
   * Credentials for sending one folder's worth of files straight at the VM.
   *
   * `writeWorkspaceFile` carries its bytes through this API, which caps them
   * and asks the caller to hold the whole file in memory first. A file picked
   * off disk gets a grant instead and streams.
   */
  async mintDriveUploadSession(
    workspaceSlug: string,
    pathPrefix: string,
    signal?: AbortSignal,
  ): Promise<VmUploadGrant> {
    return await this.request(
      workspacePath(workspaceSlug, 'file-uploads'),
      VmUploadGrantSchema,
      jsonRequest('POST', { pathPrefix }, signal),
    )
  }

  async sendDefaultSessionMessage(
    workspaceSlug: string,
    agentSlug: string,
    input: DefaultSessionMessageRequestInput,
  ) {
    return await this.request(
      `${defaultSessionApiPath(workspaceSlug, agentSlug)}/messages`,
      DefaultSessionMessageResponseSchema,
      jsonRequest('POST', input),
    )
  }

  async sendSessionMessage(
    workspaceSlug: string,
    sessionId: string,
    input: AgentMessageRequestInput,
  ): Promise<SessionInputResponse> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/messages`,
      SessionInputResponseSchema,
      jsonRequest('POST', input),
    )
  }

  async addSessionNote(
    workspaceSlug: string,
    sessionId: string,
    input: AgentNoteRequest,
  ): Promise<{ seq: number }> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/note`,
      SessionNoteResponseSchema,
      jsonRequest('POST', input),
    )
  }

  async answerSession(
    workspaceSlug: string,
    sessionId: string,
    input: AgentAnswerRequest,
  ): Promise<SessionInputResponse> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/answer`,
      SessionInputResponseSchema,
      jsonRequest('POST', input),
    )
  }

  async interruptSession(workspaceSlug: string, sessionId: string): Promise<{ ok: true }> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/interrupt`,
      SessionInterruptResponseSchema,
      { method: 'POST' },
    )
  }

  async renameSession(
    workspaceSlug: string,
    sessionId: string,
    title: string,
  ): Promise<SessionSummary> {
    return await this.request(
      sessionPath(workspaceSlug, sessionId),
      SessionSummarySchema,
      jsonRequest('PATCH', { title }),
    )
  }

  async archiveSession(
    workspaceSlug: string,
    sessionId: string,
    kind: 'personal' | 'global',
    archived: boolean,
  ): Promise<SessionSummary> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/archive`,
      SessionSummarySchema,
      jsonRequest('PUT', { kind, archived }),
    )
  }

  /**
   * Every owner's prioritized recent sessions, bounded per owner.
   *
   * One request for the whole ring. The fan-out is the server's, which is why
   * this is not a filtered `listSessions`: `bucket` leads the index, so four
   * buckets per owner would otherwise be four requests per face.
   */
  async listSessionActivity(
    workspaceSlug: string,
    signal?: AbortSignal,
  ): Promise<SessionActivityResponse> {
    return await this.request(
      `${sessionCollectionPath(workspaceSlug)}/activity`,
      SessionActivityResponseSchema,
      signal === undefined ? {} : { signal },
    )
  }

  /**
   * Mark a session read up to `seq`.
   *
   * Fire-and-forget by design: the backend cursor is a maximum, so a request
   * that never lands costs one badge that clears on the next visit — cheaper
   * than a retry queue, and far cheaper than an error toast for a thing the
   * reader never asked for.
   */
  async markSessionRead(
    workspaceSlug: string,
    sessionId: string,
    seq: number,
  ): Promise<SessionReadResponse> {
    return await this.request(
      `${sessionPath(workspaceSlug, sessionId)}/read`,
      SessionReadResponseSchema,
      jsonRequest('PUT', { seq }),
    )
  }

  async deleteSession(workspaceSlug: string, sessionId: string): Promise<void> {
    await this.requestResponse(sessionPath(workspaceSlug, sessionId), {
      method: 'DELETE',
    })
  }

  sessionImageUrl(workspaceSlug: string, sessionId: string, storageId: string): string {
    return `${sessionPath(workspaceSlug, sessionId)}/images/${encodeURIComponent(storageId)}`
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const response = await this.requestResponse(path, init)
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new DuetApiError(502, 'invalid_response', 'Duet API returned invalid JSON')
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new DuetApiError(502, 'invalid_response', 'Duet API response failed validation')
    }
    return parsed.data
  }

  private async requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(path, { ...init, credentials: 'same-origin' })
    if (!response.ok) throw await apiError(response)
    return response
  }
}

export function marketplaceMutationErrorPayload(
  error: unknown,
): MarketplaceAgentMutationError | undefined {
  if (!(error instanceof DuetApiError)) return undefined
  const parsed = MarketplaceAgentMutationErrorSchema.safeParse(error.data)
  return parsed.success ? parsed.data : undefined
}

function sessionCollectionPath(workspaceSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/agent/sessions`
}

function sessionPath(workspaceSlug: string, sessionId: string): string {
  return `${sessionCollectionPath(workspaceSlug)}/${encodeURIComponent(sessionId)}`
}

function trainRecordPath(workspaceSlug: string, scope: TrainScope, slug: string): string {
  return `${trainPath(workspaceSlug, scope)}/records/${encodeURIComponent(slug)}`
}

function appPath(workspaceSlug: string, appSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/apps/${encodeURIComponent(appSlug)}`
}

function agentsPath(workspaceSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/agents`
}

function agentPath(workspaceSlug: string, agentSlug: string): string {
  return `${agentsPath(workspaceSlug)}/${encodeURIComponent(agentSlug)}`
}

function marketplaceSubscriptionsPath(workspaceSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/marketplace/subscriptions`
}

function workspacePath(workspaceSlug: string, resource: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/${resource}`
}

function workspaceFilesPath(workspaceSlug: string): string {
  return workspacePath(workspaceSlug, 'files')
}

function workspaceFilePath(workspaceSlug: string, filePath: string): string {
  const absolute = filePath.startsWith('/')
  const encodedSegments = filePath
    .replace(absolute ? /^\/|\/+$/g : /^\/+|\/+$/g, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  const encodedPath = absolute ? `%2F${encodedSegments}` : encodedSegments
  return `${workspaceFilesPath(workspaceSlug)}/${encodedPath}`
}

function adminWorkspacePath(workspaceId: string): string {
  return `/api/duet/internal-admin/workspaces/${encodeURIComponent(workspaceId)}`
}

function integrationPath(workspaceSlug: string, resource: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/integrations/${resource}`
}

function mcpServerPath(workspaceSlug: string): string {
  return `/api/duet/ws/${encodeURIComponent(workspaceSlug)}/mcp-servers`
}

function jsonRequest(method: string, input: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  }
}

async function versionedFileFrom(response: Response): Promise<VersionedFile> {
  const data = new Uint8Array(await response.arrayBuffer())
  const totalSize = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
  return {
    data,
    etag: response.headers.get('etag'),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    size: totalSize === undefined ? data.byteLength : Number(totalSize),
  }
}

/* `boolean` is here because a flag on the wire is spelled `?flag=true`, and the
   contract parses it back with `z.literal(true)` reading the string. Without it
   a schema-bound caller has to stringify at the call site, which is exactly the
   hand-conversion binding the query type to the schema exists to remove. */
function queryString(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  return params.toString()
}

function pageQueryString(options: PageOptions): string {
  return queryString({ cursor: options.cursor, limit: options.limit })
}

async function apiError(response: Response): Promise<DuetApiError> {
  let code =
    response.status === 401
      ? 'unauthorized'
      : response.status === 412
        ? 'precondition_failed'
        : 'request_failed'
  let data: unknown
  try {
    const payload = (await response.json()) as { error?: unknown }
    data = payload
    if (typeof payload.error === 'string') code = payload.error
  } catch {
    // HTTP status remains the stable fallback when an intermediary returns non-JSON.
  }
  return new DuetApiError(response.status, code, code, data)
}

export const duetApi = new DuetApiClient()
