import { describe, expect, test } from 'bun:test'

import { EPHEMERAL_VM_TAG, PRODUCTION_VM_TAG, STAGING_VM_TAG } from '@repo/contract'

import { workspaceVmTags } from '../convex/domains/workspaces/vmTags'

// Every workspace VM on exe.dev is named `duet-ws-<sha256(workspaceId)[:24]>`
// and, before this tag existed, carried exactly one tag: `duet-workspace`. One
// shared account backs staging AND prod, so a paying user's VM, a staging VM,
// an e2e journey's throwaway, and an ad-hoc diagnostic probe were
// indistinguishable from the provider side — there was no way to sweep the
// disposable ones without reading Convex to decide what each hash was.
describe('workspaceVmTags', () => {
  test('tags an ordinary workspace as a workspace and nothing else', () => {
    expect(workspaceVmTags({ ephemeral: undefined }, {})).toEqual(['duet-workspace'])
  })

  test('marks an ephemeral workspace so a sweep can delete it without reading Convex', () => {
    expect(workspaceVmTags({ ephemeral: true }, {})).toEqual(['duet-workspace', EPHEMERAL_VM_TAG])
  })

  // `ephemeral: false` is a real user's workspace. It must be as safe as an
  // absent field — a sweep keyed on this tag deletes drives, so a falsy value
  // leaking through as "tagged" would destroy production data.
  test('never marks a workspace that is explicitly not ephemeral', () => {
    expect(workspaceVmTags({ ephemeral: false }, {})).toEqual(['duet-workspace'])
  })

  // The environment a VM belongs to is not a matter of configuration: it is
  // whichever control plane the VM was told to phone home to. Deriving the tag
  // from that URL means the tag cannot disagree with reality, which a
  // hand-set env var can.
  test('tags the environment by the control plane the VM reports to', () => {
    expect(workspaceVmTags({ ephemeral: undefined }, {}, 'https://ctl.duet.so')).toEqual([
      'duet-workspace',
      PRODUCTION_VM_TAG,
    ])
    expect(workspaceVmTags({ ephemeral: undefined }, {}, 'https://ctl-staging.duet.so')).toEqual([
      'duet-workspace',
      STAGING_VM_TAG,
    ])
    // Trailing slashes and paths are the same control plane.
    expect(workspaceVmTags({ ephemeral: undefined }, {}, 'https://ctl.duet.so/')).toEqual([
      'duet-workspace',
      PRODUCTION_VM_TAG,
    ])
  })

  // A sweep scoped to one environment must never see a VM it cannot place.
  // Untagged is the never-swept case, exactly as for `ephemeral`.
  test('leaves a VM unplaced when the control plane is not a known environment', () => {
    expect(workspaceVmTags({ ephemeral: undefined }, {}, 'http://localhost:3001')).toEqual([
      'duet-workspace',
    ])
    expect(workspaceVmTags({ ephemeral: undefined }, {})).toEqual(['duet-workspace'])
  })

  test('keeps the per-deployment tags from the environment', () => {
    expect(workspaceVmTags({ ephemeral: true }, { DUET_EXE_VM_TAGS: 'staging, canary' })).toEqual([
      'duet-workspace',
      EPHEMERAL_VM_TAG,
      'staging',
      'canary',
    ])
  })
})
