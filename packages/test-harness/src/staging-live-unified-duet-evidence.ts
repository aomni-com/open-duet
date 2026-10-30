import assert from 'node:assert/strict'

export interface UnifiedDuetEvidenceInput {
  environment: 'staging'
  targetVersion: string
  transitionVersion: string
  imageRef: string
  migrated: {
    workspaceId: string
    vmName: string
    sshDest: string
    imageRef: string
    targetVersion: string
    bootIdBefore: string
    bootIdAfter: string
    stateBeforeSha256: string
    stateAfterSha256: string
    credentialBeforeSha256: string
    credentialAfterSha256: string
  }
  drills: Array<{
    kind:
      | 'agent-only-update'
      | 'missing-asset-repair'
      | 'interrupted-adoption'
      | 'matched-rollback'
      | 'live-work-deferral'
    environment: 'staging'
    disposable: true
    fixtureId: string
    execution: 'provider-vm'
    controlPlane: 'controlled-loopback'
    vmName: string
    targetVersion: string
    status: 'pass'
    observations: Record<string, unknown>
  }>
}

function nonempty(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && value.length > 0, `${label} is required`)
}

function digest(value: unknown, label: string): asserts value is string {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label} must be a SHA-256`)
}

function sameDigest(before: unknown, after: unknown, label: string) {
  digest(before, `${label} before`)
  digest(after, `${label} after`)
  assert.equal(after, before, `${label} changed`)
}

/** External live receipts are required inputs, never inferred from a local test. */
export function inspectUnifiedDuetEvidence(value: unknown): UnifiedDuetEvidenceInput {
  assert(value !== null && typeof value === 'object', 'Unified duet evidence must be an object')
  const input = value as UnifiedDuetEvidenceInput
  assert.equal(input.environment, 'staging', 'Evidence must belong to staging')
  for (const name of ['targetVersion', 'transitionVersion', 'imageRef'] as const)
    nonempty(input[name], name)
  const migrated = input.migrated
  assert(migrated && typeof migrated === 'object', 'Migrated VM receipt is required')
  for (const name of [
    'workspaceId',
    'vmName',
    'sshDest',
    'imageRef',
    'bootIdBefore',
    'bootIdAfter',
  ] as const)
    nonempty(migrated[name], `migrated.${name}`)
  // A migrated VM retains its original image provenance; the strict image is for fresh births.
  assert.equal(
    migrated.targetVersion,
    input.transitionVersion,
    'Migrated adoption has the wrong frozen transition release',
  )
  assert.equal(migrated.bootIdBefore, migrated.bootIdAfter, 'Migration rebooted the VM')
  sameDigest(migrated.stateBeforeSha256, migrated.stateAfterSha256, 'Migrated state inventory')
  sameDigest(
    migrated.credentialBeforeSha256,
    migrated.credentialAfterSha256,
    'Migrated credential inventory',
  )
  assert(Array.isArray(input.drills), 'Disposable live drill receipts are required')
  for (const kind of [
    'agent-only-update',
    'missing-asset-repair',
    'interrupted-adoption',
    'matched-rollback',
    'live-work-deferral',
  ] as const) {
    const matching = input.drills.filter(row => row.kind === kind)
    assert.equal(matching.length, 1, `Exactly one ${kind} receipt is required`)
    const drill = matching[0]!
    assert.equal(drill.environment, 'staging', `${kind} environment mismatch`)
    assert.equal(drill.disposable, true, `${kind} must use a disposable VM`)
    assert.equal(drill.status, 'pass', `${kind} did not pass`)
    nonempty(drill.fixtureId, `${kind} fixtureId`)
    assert.equal(drill.execution, 'provider-vm', `${kind} must execute on a physical provider VM`)
    assert.equal(
      drill.controlPlane,
      'controlled-loopback',
      `${kind} must identify its controlled loopback edges`,
    )
    assert(!('workspaceId' in drill), `${kind} provider fixture must not invent a workspaceId`)
    nonempty(drill.vmName, `${kind} vmName`)
    assert.notEqual(drill.vmName, migrated.vmName, `${kind} cannot target the migrated user VM`)
    assert.equal(
      drill.targetVersion,
      kind === 'interrupted-adoption' ? input.transitionVersion : input.targetVersion,
      `${kind} release mismatch`,
    )
    const observation = drill.observations
    assert(observation && typeof observation === 'object', `${kind} observations are required`)
    switch (kind) {
      case 'agent-only-update':
        assert.deepEqual(
          observation.changedArtifacts,
          ['duet'],
          'Agent-only update changed other assets',
        )
        sameDigest(
          observation.gatewayBeforeSha256,
          observation.gatewayAfterSha256,
          'Agent-only gateway',
        )
        nonempty(observation.fromVersion, 'Agent-only prior release')
        assert.notEqual(
          observation.fromVersion,
          input.targetVersion,
          'Agent-only update did not change releases',
        )
        assert.equal(observation.installedVersion, input.targetVersion)
        break
      case 'missing-asset-repair':
        nonempty(observation.artifactName, 'Missing asset name')
        assert.equal(observation.missingBefore, true, 'Repair did not start with a missing asset')
        sameDigest(observation.expectedSha256, observation.repairedSha256, 'Repaired asset')
        assert.equal(observation.installedVersion, input.targetVersion)
        break
      case 'interrupted-adoption':
        nonempty(observation.interruptedPhase, 'Interrupted adoption phase')
        assert.equal(observation.recoveredVersion, input.transitionVersion)
        sameDigest(
          observation.stateBeforeSha256,
          observation.stateAfterSha256,
          'Interrupted adoption state',
        )
        sameDigest(
          observation.credentialBeforeSha256,
          observation.credentialAfterSha256,
          'Interrupted adoption credentials',
        )
        break
      case 'matched-rollback':
        nonempty(observation.rollbackVersion, 'Rollback release')
        assert.notEqual(
          observation.rollbackVersion,
          input.targetVersion,
          'Rollback did not select a different release',
        )
        assert.equal(observation.installedVersion, observation.rollbackVersion)
        digest(observation.rollbackInventorySha256, 'Rollback expected inventory')
        sameDigest(
          observation.rollbackInventorySha256,
          observation.installedInventorySha256,
          'Rollback complete inventory',
        )
        break
      case 'live-work-deferral':
        assert.equal(observation.adoptionStatus, 'deferred')
        assert.equal(observation.workContinued, true, 'Live turn did not continue during deferral')
        nonempty(observation.sessionId, 'Live deferral session')
        break
    }
  }
  return input
}
