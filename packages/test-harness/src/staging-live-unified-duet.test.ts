import { expect, test } from 'bun:test'

import { runUnifiedDuetJourney } from './staging-live-unified-duet'
import {
  inspectUnifiedDuetEvidence,
  type UnifiedDuetEvidenceInput,
} from './staging-live-unified-duet-evidence'

test('missing cutover evidence refuses before the disposable fixture is allocated', async () => {
  const previous = process.env.DUET_E2E_UNIFIED_EVIDENCE
  delete process.env.DUET_E2E_UNIFIED_EVIDENCE
  try {
    await expect(runUnifiedDuetJourney()).rejects.toThrow('DUET_E2E_UNIFIED_EVIDENCE')
  } finally {
    if (previous !== undefined) process.env.DUET_E2E_UNIFIED_EVIDENCE = previous
  }
})

function input(): UnifiedDuetEvidenceInput {
  const sha = 'a'.repeat(64)
  const targetVersion = `0.0.0+${'b'.repeat(64)}`
  const transitionVersion = `0.0.0+${'c'.repeat(64)}`
  const drill = (
    kind: UnifiedDuetEvidenceInput['drills'][number]['kind'],
    observations: Record<string, unknown>,
  ) => ({
    kind,
    environment: 'staging' as const,
    disposable: true as const,
    fixtureId: 'staging-e2e-disposable',
    execution: 'provider-vm' as const,
    controlPlane: 'controlled-loopback' as const,
    vmName: 'disposable-vm',
    targetVersion: kind === 'interrupted-adoption' ? transitionVersion : targetVersion,
    status: 'pass' as const,
    observations,
  })
  return {
    environment: 'staging',
    targetVersion,
    transitionVersion,
    imageRef: 'registry/duet@sha256:strict-image',
    migrated: {
      workspaceId: 'existing',
      vmName: 'original-vm',
      sshDest: 'original-vm.exe.xyz',
      imageRef: 'registry/legacy@sha256:old-image',
      targetVersion: transitionVersion,
      bootIdBefore: 'original-boot',
      bootIdAfter: 'original-boot',
      stateBeforeSha256: sha,
      stateAfterSha256: sha,
      credentialBeforeSha256: sha,
      credentialAfterSha256: sha,
    },
    drills: [
      drill('agent-only-update', {
        changedArtifacts: ['duet'],
        fromVersion: transitionVersion,
        installedVersion: targetVersion,
        gatewayBeforeSha256: sha,
        gatewayAfterSha256: sha,
      }),
      drill('missing-asset-repair', {
        artifactName: 'duet',
        missingBefore: true,
        expectedSha256: sha,
        repairedSha256: sha,
        installedVersion: targetVersion,
      }),
      drill('interrupted-adoption', {
        interruptedPhase: 'switch',
        recoveredVersion: transitionVersion,
        stateBeforeSha256: sha,
        stateAfterSha256: sha,
        credentialBeforeSha256: sha,
        credentialAfterSha256: sha,
      }),
      drill('matched-rollback', {
        rollbackVersion: transitionVersion,
        installedVersion: transitionVersion,
        rollbackInventorySha256: sha,
        installedInventorySha256: sha,
      }),
      drill('live-work-deferral', {
        adoptionStatus: 'deferred',
        workContinued: true,
        sessionId: 'disposable-session',
      }),
    ],
  }
}

test('a preservation receipt cannot hide a migration reboot', () => {
  const receipt = input()
  expect(inspectUnifiedDuetEvidence(receipt).migrated.vmName).toBe('original-vm')
  receipt.migrated.bootIdAfter = 'replacement-boot'
  expect(() => inspectUnifiedDuetEvidence(receipt)).toThrow('Migration rebooted')
})

test('live drill receipts must name the frozen releases and disposable VM', () => {
  const wrongRelease = input()
  wrongRelease.drills[0]!.targetVersion = wrongRelease.transitionVersion
  expect(() => inspectUnifiedDuetEvidence(wrongRelease)).toThrow(
    'agent-only-update release mismatch',
  )
  const userVm = input()
  userVm.drills[2]!.vmName = userVm.migrated.vmName
  expect(() => inspectUnifiedDuetEvidence(userVm)).toThrow('cannot target the migrated user VM')
  const missing = input()
  missing.drills = missing.drills.filter(row => row.kind !== 'matched-rollback')
  expect(() => inspectUnifiedDuetEvidence(missing)).toThrow('matched-rollback receipt is required')
})

test('accepts provider drill receipts with controlled edges and explicit fixture ids', () => {
  const receipt = JSON.parse(JSON.stringify(input()))
  for (const drill of receipt.drills) {
    delete drill.workspaceId
    drill.fixtureId = `staging-e2e-fault-${drill.kind}`
    drill.execution = 'provider-vm'
    drill.controlPlane = 'controlled-loopback'
  }
  expect(inspectUnifiedDuetEvidence(receipt).drills.map(drill => drill.fixtureId)).toEqual([
    'staging-e2e-fault-agent-only-update',
    'staging-e2e-fault-missing-asset-repair',
    'staging-e2e-fault-interrupted-adoption',
    'staging-e2e-fault-matched-rollback',
    'staging-e2e-fault-live-work-deferral',
  ])
})

test('provider drills cannot claim backend workspace or real control-plane provenance', () => {
  const inventedWorkspace = JSON.parse(JSON.stringify(input()))
  inventedWorkspace.drills[0].workspaceId = 'invented-backend-workspace'
  expect(() => inspectUnifiedDuetEvidence(inventedWorkspace)).toThrow(
    'must not invent a workspaceId',
  )
  const mislabeledEdges = JSON.parse(JSON.stringify(input()))
  mislabeledEdges.drills[0].controlPlane = 'deployed-staging'
  expect(() => inspectUnifiedDuetEvidence(mislabeledEdges)).toThrow('controlled loopback edges')
  const localContainer = JSON.parse(JSON.stringify(input()))
  localContainer.drills[0].execution = 'docker'
  expect(() => inspectUnifiedDuetEvidence(localContainer)).toThrow('physical provider VM')
})
