import type { BuildActivity } from './build-activity'

export type BuildingFallbackInput = {
  method: string
  path: string
  acceptsHtml: boolean
  upstream: 'unavailable' | { status: number }
  activity: BuildActivity
}

export function decideBuildingFallback(
  input: BuildingFallbackInput,
): { kind: 'building' } | { kind: 'passthrough' } {
  if (
    (input.method === 'GET' || input.method === 'HEAD') &&
    input.acceptsHtml &&
    input.activity.hot &&
    (input.upstream === 'unavailable' || (input.path === '/' && input.upstream.status === 404))
  ) {
    return { kind: 'building' }
  }
  return { kind: 'passthrough' }
}
