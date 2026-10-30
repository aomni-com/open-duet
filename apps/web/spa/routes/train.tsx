'use client'

import { Robot } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router'

import { ROOT_AGENT_SCOPE } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'

import { agentDisplayName } from '../agents/agent-display'
import { duetQueryOptions } from '../api/query-options'
import { ROOT_TRAIN_SCOPE } from '../api/train-scope'
import { useSpa } from '../context'
import { agentConfigQueryOptions } from '../drive/agent-config'
import { agentTrainSurface } from '../drive/agent-onboarding-projection'
import { agentMenuShape } from '../drive/agent-roster-types'
import { WorkspaceEmptyState, WorkspacePage } from '../drive/workspace-page'
import { TrainAgentLoadingSkeleton } from './train/train-agent-loading'
import { TrainRecordDetail } from './train/train-record-detail'
import { legacyTrainRecordRedirectPath, trainPath } from './train/train-routes'
import { TrainSurface } from './train/train-surface'

export default function TrainRoute() {
  const [searchParams] = useSearchParams()
  const { workspaceSlug, agentSlug: scopeSlug, memorySlug } = useParams()
  if (workspaceSlug === undefined) throw new Error('Train requires a workspace route')

  /* The path names a scope, and the drive's own is named `root` like everywhere
     else. Bare `train` names none, so it is sent to the row it used to
     mean rather than rendered as a fourth thing — that keeps the nav entry, and
     any bookmark, landing on a page whose URL says what it is showing.

     Below this line `undefined` goes back to meaning root, which is the
     vocabulary every child already speaks. Translating once here is what keeps
     `root` a fact about the URL rather than a token four components have to
     agree about. */
  if (scopeSlug === undefined) {
    return <Navigate replace to={trainPath(workspaceSlug, ROOT_TRAIN_SCOPE)} />
  }
  const agentSlug = scopeSlug === ROOT_AGENT_SCOPE ? undefined : scopeSlug

  const scope = agentSlug === undefined ? ROOT_TRAIN_SCOPE : ({ kind: 'agent', agentSlug } as const)
  const legacyRecordPath =
    memorySlug === undefined
      ? legacyTrainRecordRedirectPath(workspaceSlug, scope, searchParams)
      : undefined
  if (legacyRecordPath !== undefined) return <Navigate replace to={legacyRecordPath} />
  return memorySlug !== undefined && agentSlug === undefined ? (
    <RootTrainRecordRoute workspaceSlug={workspaceSlug} memorySlug={memorySlug} />
  ) : (
    <ScopedTrainRoute workspaceSlug={workspaceSlug} agentSlug={agentSlug} memorySlug={memorySlug} />
  )
}

function RootTrainRecordRoute({
  workspaceSlug,
  memorySlug,
}: {
  workspaceSlug: string
  memorySlug: string
}) {
  const navigate = useNavigate()
  return (
    <WorkspacePage>
      <TrainRecordDetail
        scope={ROOT_TRAIN_SCOPE}
        slug={memorySlug}
        readOnly={false}
        onBack={() => navigate(trainPath(workspaceSlug, ROOT_TRAIN_SCOPE), { replace: true })}
      />
    </WorkspacePage>
  )
}

function ScopedTrainRoute({
  workspaceSlug,
  agentSlug,
  memorySlug,
}: {
  workspaceSlug: string
  agentSlug?: string
  memorySlug?: string
}) {
  const t = useTranslations('duetApp.agentDetail')
  const navigate = useNavigate()
  const { api } = useSpa()
  const agentQuery = useQuery({
    ...duetQueryOptions.workspaces.agentLookup(api, workspaceSlug, { slug: agentSlug ?? '' }),
    enabled: agentSlug !== undefined,
  })
  const agent = agentQuery.data ?? undefined
  const config = useQuery({
    ...agentConfigQueryOptions(api, workspaceSlug, {
      id: agent?.id ?? '',
      anchorPath: agent?.anchorPath ?? '',
    }),
    enabled: agent !== undefined,
  })
  const scope = agentSlug === undefined ? ROOT_TRAIN_SCOPE : ({ kind: 'agent', agentSlug } as const)

  if (
    agentSlug !== undefined &&
    (agentQuery.isPending || (agent !== undefined && config.isPending))
  ) {
    return (
      <WorkspacePage className="h-full">
        <TrainAgentLoadingSkeleton label={t('loading')} />
      </WorkspacePage>
    )
  }

  if (agentSlug !== undefined && agentQuery.isError) {
    return (
      <WorkspacePage className="h-full">
        <div className="grid h-full place-items-center">
          <WorkspaceEmptyState
            tone="destructive"
            icon={<Robot />}
            title={t('loadErrorTitle')}
            body={t('loadErrorBody')}
            action={
              <button className={buttonVariants()} onClick={() => void agentQuery.refetch()}>
                {t('retry')}
              </button>
            }
          />
        </div>
      </WorkspacePage>
    )
  }

  if (agentSlug !== undefined && agent === undefined) {
    return (
      <WorkspacePage className="h-full">
        <div className="grid h-full place-items-center">
          <WorkspaceEmptyState
            tone="muted"
            icon={<Robot />}
            title={t('notFoundTitle')}
            body={t('notFoundBody')}
          />
        </div>
      </WorkspacePage>
    )
  }

  if (
    agent !== undefined &&
    config.data !== undefined &&
    agentTrainSurface(config.data) === 'disabled'
  ) {
    return (
      <WorkspacePage className="h-full">
        <div className="grid h-full place-items-center">
          <WorkspaceEmptyState
            tone="muted"
            icon={<Robot />}
            title={t('trainDisabledTitle')}
            body={t('trainDisabledBody')}
          />
        </div>
      </WorkspacePage>
    )
  }

  if (memorySlug !== undefined) {
    return (
      <WorkspacePage>
        <TrainRecordDetail
          scope={scope}
          slug={memorySlug}
          readOnly={agent === undefined ? false : agentMenuShape(agent) === 'replica'}
          onBack={() => navigate(trainPath(workspaceSlug, scope), { replace: true })}
        />
      </WorkspacePage>
    )
  }
  return (
    <TrainSurface
      key={agentSlug ?? 'root'}
      scope={scope}
      readOnly={agent === undefined ? false : agentMenuShape(agent) === 'replica'}
      agentName={agent === undefined ? undefined : agentDisplayName(agent)}
      agents={agent === undefined ? [] : [agent]}
    />
  )
}
