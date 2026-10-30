import { describe, expect, test } from 'bun:test'

import { loadingViewForPath } from './loading-route'

describe('product loading route contract', () => {
  test('keeps each destination on one loading owner through nested routes', () => {
    /* The workspace-level session shape is a redirect onto the agent that owns
       the session, so it waits in that page's clothes; a workspace-level app
       address does not exist at all. */
    expect(loadingViewForPath('/w/acme/sessions')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/sessions/session_1')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/apps')).toBe('generic')
    expect(loadingViewForPath('/w/acme/files')).toBe('files')
    expect(loadingViewForPath('/w/acme/files/reports/weekly')).toBe('files')
    /* `/agents` remains the root agent page inside Build; Work Home owns the
       workspace front door separately. */
    expect(loadingViewForPath('/w/acme/agents')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/agents/graph')).toBe('agents-map')
    expect(loadingViewForPath('/w/acme/agents/marketplace')).toBe('marketplace')
    // The real detail URL, from `product-destinations.ts`:
    // `agents/marketplace/:publisherSlug/:agentName`. Asserting the old
    // `agents/official/<name>` shape kept this test green against a path the
    // router had stopped producing, so detail silently fell through to the
    // generic frame.
    expect(loadingViewForPath('/w/acme/agents/marketplace/duet/research')).toBe(
      'marketplace-detail',
    )
    // Agent destinations wait in their own page shape; the graph waits in the map.
    expect(loadingViewForPath('/w/acme/agents/research')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/agents/research/files/agents/research')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/agents/research/files')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/agents/research/apps/invoices')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/agents/research/sessions')).toBe('agent-page')
    expect(loadingViewForPath('/w/acme/agents/research/sessions/session_1')).toBe('work-session')
    // The drive's own agent is an agent, and its page is a page.
    expect(loadingViewForPath('/w/acme/agents/root')).toBe('agent-page')
    // The agent's own document is not the canvas, and does not borrow its frame.
    expect(loadingViewForPath('/w/acme/agents/research/settings')).toBe('agent-detail')
    expect(loadingViewForPath('/w/acme/agents/research/train')).toBe('generic')
    // `marketplace` is a static segment, never an agent slug — the catalog's own
    // listing lives there, so it must not resolve as an agent named after it.
    expect(loadingViewForPath('/w/acme/agents/marketplace')).not.toBe('agents-map')
    expect(loadingViewForPath('/w/acme/train')).toBe('train')
    expect(loadingViewForPath('/w/acme/integrations')).toBe('integrations')
    expect(loadingViewForPath('/w/acme/settings/members')).toBe('settings')
    expect(loadingViewForPath('/settings/profile')).toBe('settings')
    // The root's destination is covered by its own case below, where the
    // reasoning for it lives.
  })
})

/* The front door, cold. All three addresses resolve to Work Home, so the
   streamed shell must reserve Work's sidebar and home composition before the
   workspace redirect or lazy route finishes. */
test('the paths on their way to the front door wear its clothes', () => {
  expect(loadingViewForPath('/')).toBe('work-home')
  expect(loadingViewForPath('/w/acme')).toBe('work-home')
  expect(loadingViewForPath('/w/acme/home')).toBe('work-home')
})

test('explicit Work entity links keep Work chrome while they resolve', () => {
  expect(loadingViewForPath('/w/acme/agents/root/sessions/session_1')).toBe('work-session')
  expect(loadingViewForPath('/w/acme/agents/research/sessions/job_1')).toBe('work-session')
  expect(loadingViewForPath('/w/acme/agents/research/apps/readiness?mode=work')).toBe('work-app')

  expect(loadingViewForPath('/w/acme/agents/root/sessions/session_1')).toBe('work-session')
  expect(loadingViewForPath('/w/acme/agents/research/apps/readiness')).toBe('agent-page')
})

test('a malformed workspace segment falls back instead of crashing the loading boundary', () => {
  expect(loadingViewForPath('/w/%E0%A4%A/home')).toBe('generic')
})
