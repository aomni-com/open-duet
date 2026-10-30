import type { ReactElement } from 'react'

import { CampaignLanding } from '@/components/landing/campaign/campaign-landing'
import { type CampaignLander } from '@/components/landing/campaign/campaign-spec'
import { AgentCloudLanding } from '@/components/landing/landers/agent-cloud-landing'
import { FileSharingLanding } from '@/components/landing/landers/file-sharing-landing'
import { PlatformLanding } from '@/components/landing/landers/platform-landing'

/**
 * The only place a `/l/<slug>` maps to JSX. Metadata lives in
 * `campaign-spec.ts` so non-visual callers (the route's metadata, the public
 * route manifest) can read the lineup without importing a lander and dragging
 * its video, shader, and image dependencies into a text pipeline.
 *
 * A bespoke lander with no entry here throws rather than rendering a blank
 * page: `renderCampaignLander` has nothing to fall back to, so the registry
 * and this map cannot silently disagree.
 */
const BESPOKE: Record<string, () => ReactElement> = {
  platform: PlatformLanding,
  'agent-cloud': AgentCloudLanding,
  'file-sharing': FileSharingLanding,
}

export function renderCampaignLander(lander: CampaignLander): ReactElement {
  if (lander.variant) return <CampaignLanding variant={lander.variant} />
  const Bespoke = BESPOKE[lander.slug]
  if (!Bespoke) throw new Error(`campaign lander "${lander.slug}" has neither copy nor a component`)
  return <Bespoke />
}
