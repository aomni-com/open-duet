/**
 * The checked ownership map for every session access seam.
 *
 * This is intentionally data, not prose: adding a registry endpoint without
 * assigning its admission and side-effect policy makes the contract test fail.
 * Gateway and internal seams remain explicit because they cannot be discovered
 * from the public endpoint registry.
 */
interface SessionAccessCensusRow {
  id: string
  surface: 'api-registry' | 'api-extra' | 'gateway-point' | 'gateway-bulk' | 'internal'
  principalVerdict: string
  malformedId: string
  sideEffectOrder: string
}

type RowSeed = Pick<SessionAccessCensusRow, 'id' | 'surface'> &
  Partial<Pick<SessionAccessCensusRow, 'principalVerdict' | 'malformedId' | 'sideEffectOrder'>>

function row(seed: RowSeed): SessionAccessCensusRow {
  return {
    principalVerdict:
      'Workspace principals use workspace trust; humans require current membership, audience admission, and an onboarded/root agent.',
    malformedId: 'Reject as typed not_found before revealing resource state.',
    sideEffectOrder:
      'Authorize before the first externally visible or durable side effect; recheck in the committing transaction.',
    ...seed,
  }
}

const registry = (id: string) => row({ id, surface: 'api-registry' })

export const SESSION_ACCESS_CENSUS = [
  registry('sessions.get'),
  registry('sessions.rename'),
  registry('sessions.cwd'),
  registry('sessions.interrupt'),
  registry('sessions.activity'),

  registry('sessions.image'),
  registry('sessions.message'),
  registry('sessions.message.wait'),
  registry('sessions.answer'),
  registry('sessions.answer.wait'),
  registry('sessions.note'),
  registry('sessions.read'),
  registry('sessions.history'),

  registry('sessions.createNested'),
  registry('sessions.createNested.wait'),
  registry('agents.defaultSession.get'),
  registry('agents.defaultSession.set'),
  registry('agents.defaultSession.message'),
  registry('agents.defaultSession.message.wait'),
  registry('agents.sessionOnboarded'),
  registry('agents.onboardingSession'),
  registry('agents.defaultSession.history'),

  registry('sessions.archive'),
  row({
    id: 'sessions.delete',
    surface: 'api-registry',
    principalVerdict:
      'The visible root requires global-lifecycle authority once; accepted descendants inherit that root decision and are never independently authorized.',
    sideEffectOrder:
      'Resolve an existing same-workspace deletion claim before point admission; otherwise authorize and seal the live root atomically before returning 204.',
  }),
  registry('sessions.events'),
  registry('sessions.list'),
  registry('sessions.children'),
  registry('sessions.create'),
  registry('sessions.create.wait'),
  registry('sessions.audience'),
  registry('sessions.audience.update'),

  row({ id: 'composio.mcp.post', surface: 'api-extra' }),
  row({ id: 'composio.mcp.get', surface: 'api-extra' }),
  row({ id: 'composio.mcp.delete', surface: 'api-extra' }),
  row({ id: 'vm.session.integrations', surface: 'api-extra' }),
  row({ id: 'vm.session.events', surface: 'api-extra' }),
  row({ id: 'gateway.session.input', surface: 'gateway-point' }),
  row({ id: 'gateway.session.events', surface: 'gateway-point' }),
  row({ id: 'gateway.session.interrupt', surface: 'gateway-point' }),
  row({ id: 'gateway.session.cwd', surface: 'gateway-point' }),
  row({ id: 'gateway.session.delete', surface: 'gateway-point' }),
  row({
    id: 'gateway.agent.sessions.delete',
    surface: 'gateway-bulk',
    principalVerdict:
      'The linked public agents.delete operation admits workspace principals and current owner/editor humans; viewers are forbidden.',
    malformedId: 'Agent slug/anchor misses are resolved before gateway teardown.',
    sideEffectOrder:
      'agents.delete preflights before bulk gateway teardown and rechecks authorization in the backend delete transaction.',
  }),

  row({ id: 'internal.session.source-parent', surface: 'internal' }),
  row({ id: 'internal.runner.drain-wait', surface: 'internal' }),
  row({ id: 'internal.session.list-discovery', surface: 'internal' }),
] as const satisfies readonly SessionAccessCensusRow[]

export const SESSION_ACCESS_REGISTRY_IDS = SESSION_ACCESS_CENSUS.filter(
  row => row.surface === 'api-registry',
).map(row => row.id)
