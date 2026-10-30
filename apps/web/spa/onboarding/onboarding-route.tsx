'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'

import type { WhoamiResponse } from '@repo/contract'

import { duetQueryOptions } from '../api/query-options'
import { useSpa } from '../context'
import { driveRoutes } from '../drive/drive-routes'
import { useSwitchLocale } from '../shell/use-switch-locale'
import {
  hasWorkspaceToSwitchTo,
  WorkspaceSwitchMenu,
  type WorkspaceSwitch,
} from '../shell/workspace-switch-menu'
import { workHomeUrl } from '../team-space/work-destination'
import { OnboardingExperience } from './onboarding-experience'
import { createWorkspaceOnboardingService } from './onboarding-service'

export function WorkspaceOnboardingRoute() {
  const { workspaceSlug = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { api, identity, logout } = useSpa()
  const switchLocale = useSwitchLocale()
  const workspace = identity.workspaces.find(candidate => candidate.slug === workspaceSlug)
  const destination = driveRoutes.agents(workspaceSlug)
  const identityOptions = duetQueryOptions.identity(api)
  const startedWorkspaceId = useRef<string | undefined>(undefined)
  const activeWorkspace = useRef<string | undefined>(workspaceSlug)
  const service = useMemo(
    () =>
      createWorkspaceOnboardingService({
        workspaceSlug,
        destination,
        api,
      }),
    [api, destination, workspaceSlug],
  )

  useEffect(() => {
    activeWorkspace.current = workspaceSlug
    return () => {
      activeWorkspace.current = undefined
    }
  }, [workspaceSlug])

  useEffect(() => {
    if (
      workspace === undefined ||
      workspace.role !== 'owner' ||
      workspace.onboardedAt !== undefined ||
      startedWorkspaceId.current === workspace.id
    ) {
      return
    }
    startedWorkspaceId.current = workspace.id
    void api
      .recordAnalyticsEvent({
        id: crypto.randomUUID(),
        name: 'onboarding.started',
        workspaceId: workspace.id,
        properties: {},
      })
      .catch(error => console.warn('Failed to record onboarding start', error))
  }, [api, workspace])

  if (
    workspace === undefined ||
    workspace.role !== 'owner' ||
    workspace.onboardedAt !== undefined
  ) {
    return <Navigate to={destination} replace />
  }

  const workspaceSwitch: WorkspaceSwitch = {
    workspaces: identity.workspaces,
    onSelect: candidate => navigate(workHomeUrl(candidate.slug)),
  }

  const finish = ({
    duetName,
    onboardedAt,
  }: {
    duetName: string
    destination: string
    onboardedAt: number
  }) => {
    queryClient.setQueryData<WhoamiResponse>(identityOptions.queryKey, current =>
      current === undefined
        ? current
        : {
            ...current,
            workspaces: current.workspaces.map(candidate => {
              if (candidate.slug !== workspaceSlug) return candidate
              return { ...candidate, duetName, onboardedAt }
            }),
          },
    )
    if (activeWorkspace.current === workspaceSlug) navigate(destination, { replace: true })
  }

  return (
    <OnboardingExperience
      service={service}
      catalogSource={api}
      recommendationsSource={api}
      paymentSource={api}
      billingEmail={identity.user.email}
      workspaceSlug={workspaceSlug}
      starterAgents={workspace.onboarding?.starterAgents}
      onComplete={finish}
      workspaceMenu={
        hasWorkspaceToSwitchTo(workspace, workspaceSwitch) ? (
          <WorkspaceSwitchMenu compact current={workspace} workspaceSwitch={workspaceSwitch} />
        ) : undefined
      }
      onLocale={switchLocale}
      onLogout={() => void logout()}
    />
  )
}
