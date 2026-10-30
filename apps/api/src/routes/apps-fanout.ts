import { type GatewayClient } from '../gateway/client'
import { fnQuery, type ApiRouteRuntime, type WorkspaceRef } from '../shared'

const RECIPIENT_PUSH_CONCURRENCY = 8
const RECIPIENT_PUSH_BUDGET_MS = 1_000

export async function pushAffectedRecipientApps(
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  ...mutationResults: unknown[]
): Promise<void> {
  const recipients = await affectedRecipientWorkspaces(runtime, mutationResults, 'app')
  await pushRecipientsWithinBudget(
    recipients,
    async recipient => {
      const pushed = await gatewayClient.pushAppsReconcile(recipient.slug, recipient.id)
      if (!pushed.ok) {
        console.error('recipient app reconcile push failed', { workspaceId: recipient.id })
      }
    },
    'app',
  )
}

export async function pushAffectedRecipientAnchors(
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
  ...mutationResults: unknown[]
): Promise<void> {
  const recipients = await affectedRecipientWorkspaces(runtime, mutationResults, 'anchor')
  await pushRecipientsWithinBudget(
    recipients,
    async recipient => {
      const pushed = await gatewayClient.pushAnchorsReconcile(recipient.slug)
      if (!pushed.ok) {
        console.error('recipient anchor reconcile push failed', { workspaceId: recipient.id })
      }
    },
    'anchor',
  )
}

async function affectedRecipientWorkspaces(
  runtime: ApiRouteRuntime,
  mutationResults: unknown[],
  resource: string,
): Promise<Array<Pick<WorkspaceRef, 'id' | 'slug'>>> {
  const workspaceIds = [
    ...new Set(mutationResults.flatMap(result => affectedRecipientWorkspaceIds(result))),
  ]
  if (workspaceIds.length === 0) return []
  try {
    return (await runtime.convex.query(fnQuery('domains/workspaces/queries:refsByIds'), {
      internalKey: runtime.internalKey,
      workspaceIds,
    })) as Array<Pick<WorkspaceRef, 'id' | 'slug'>>
  } catch (error) {
    console.error(`recipient ${resource} reconcile lookup failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

async function pushRecipientsWithinBudget(
  recipients: Array<Pick<WorkspaceRef, 'id' | 'slug'>>,
  push: (recipient: Pick<WorkspaceRef, 'id' | 'slug'>) => Promise<void>,
  resource: string,
): Promise<void> {
  let nextRecipientIndex = 0
  const deadline = Date.now() + RECIPIENT_PUSH_BUDGET_MS
  const pushNextRecipient = async (): Promise<void> => {
    while (Date.now() < deadline) {
      const recipient = recipients[nextRecipientIndex++]
      if (!recipient) return
      try {
        const completed = await completesWithin(push(recipient), deadline - Date.now())
        if (!completed) {
          console.error(`recipient ${resource} reconcile push timed out`, {
            workspaceId: recipient.id,
          })
          return
        }
      } catch (error) {
        console.error(`recipient ${resource} reconcile push failed`, {
          workspaceId: recipient.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(RECIPIENT_PUSH_CONCURRENCY, recipients.length) },
      pushNextRecipient,
    ),
  )
}

async function completesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>(resolve => {
        timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function affectedRecipientWorkspaceIds(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return []
  const value = (result as { affectedRecipientWorkspaceIds?: unknown })
    .affectedRecipientWorkspaceIds
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((workspaceId): workspaceId is string => typeof workspaceId === 'string'),
        ),
      ]
    : []
}
