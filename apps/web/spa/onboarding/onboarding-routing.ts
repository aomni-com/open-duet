import type { WorkspaceSummary } from '@repo/contract'

export function onboardingGatePath(workspace: WorkspaceSummary): string | null {
  if (workspace.role !== 'owner' || workspace.onboardedAt !== undefined) {
    return null
  }
  return `/w/${encodeURIComponent(workspace.slug)}/onboarding`
}
