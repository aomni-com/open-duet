import { describe, expect, it } from 'bun:test'

import { convexUrlsFromDeployment } from './index'

describe('convexUrlsFromDeployment', () => {
  it('derives cloud + site URLs from a bare deployment name', () => {
    expect(convexUrlsFromDeployment('elated-hippopotamus-235')).toEqual({
      cloudUrl: 'https://elated-hippopotamus-235.convex.cloud',
      siteUrl: 'https://elated-hippopotamus-235.convex.site',
    })
  })

  it('strips the "<type>:" prefix the Convex CLI writes', () => {
    expect(convexUrlsFromDeployment('dev:elated-hippopotamus-235')).toEqual({
      cloudUrl: 'https://elated-hippopotamus-235.convex.cloud',
      siteUrl: 'https://elated-hippopotamus-235.convex.site',
    })
  })

  it('throws when the deployment is empty', () => {
    expect(() => convexUrlsFromDeployment('')).toThrow('CONVEX_DEPLOYMENT is required')
    expect(() => convexUrlsFromDeployment('  ')).toThrow('CONVEX_DEPLOYMENT is required')
  })
})
