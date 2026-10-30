import { afterAll, afterEach, beforeAll, describe } from 'bun:test'

// This is the only discoverable test entrypoint. The `.tests.ts` modules only
// register behavior groups here, so the whole domain shares one Convex fixture.
import { registerAgentScopedListTests } from './agent-sessions/agent-scoped-list.tests'
import { registerCreationTests } from './agent-sessions/creation.tests'
import { registerDefaultSessionTests } from './agent-sessions/default-sessions.tests'
import { registerDiscoveryTests } from './agent-sessions/discovery.tests'
import { registerInputDeliveryTests } from './agent-sessions/input-delivery.tests'
import { registerJobListTests } from './agent-sessions/job-list.tests'
import { registerMemberStateTests } from './agent-sessions/member-state.tests'
import { registerOnboardingSessionTests } from './agent-sessions/onboarding-sessions.tests'
import { registerProjectionTests } from './agent-sessions/projection.tests'
import { registerRelayPersistenceTests } from './agent-sessions/relay-persistence.tests'
import { registerServicingPolicyTests } from './agent-sessions/servicing-policy.tests'
import { registerSessionActivityTests } from './agent-sessions/session-activity.tests'
import { registerSessionLifecycleTests } from './agent-sessions/session-lifecycle.tests'
import { registerSessionListTests } from './agent-sessions/session-list.tests'
import { registerTerminalRecoveryTests } from './agent-sessions/terminal-recovery.tests'
import { startAgentSessionsFixture, stopAgentSessionsFixture } from './agent-sessions/test-support'

describe('agent session state machine', () => {
  beforeAll(startAgentSessionsFixture, 240_000)
  // This suite deliberately shares one real local Convex deployment. Leave
  // room between write-heavy cases for its rolling 4 MiB/s quota to advance.
  afterEach(() => Bun.sleep(250))
  afterAll(stopAgentSessionsFixture)

  registerCreationTests()
  registerServicingPolicyTests()
  registerInputDeliveryTests()
  registerRelayPersistenceTests()
  registerTerminalRecoveryTests()
  registerDefaultSessionTests()
  registerDiscoveryTests()
  registerOnboardingSessionTests()
  registerProjectionTests()
  registerSessionListTests()
  registerJobListTests()
  registerMemberStateTests()
  registerSessionLifecycleTests()
  registerSessionActivityTests()
  registerAgentScopedListTests()
})
