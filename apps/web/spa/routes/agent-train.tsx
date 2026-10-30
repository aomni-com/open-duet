'use client'

import { Navigate, useParams, useSearchParams } from 'react-router'

import { legacyAgentTrainRedirectPath } from './train/train-routes'

export default function AgentTrainRoute() {
  const [searchParams] = useSearchParams()
  const { workspaceSlug, agentSlug, memorySlug } = useParams()
  if (workspaceSlug === undefined || agentSlug === undefined) {
    throw new Error('Legacy agent Train requires workspace and agent routes')
  }

  return (
    <Navigate
      replace
      to={legacyAgentTrainRedirectPath(workspaceSlug, agentSlug, memorySlug, searchParams)}
    />
  )
}
