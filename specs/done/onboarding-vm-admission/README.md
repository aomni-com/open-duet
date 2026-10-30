# Onboarding-gated VM admission

## Overview

Duet keeps a newly signed-up workspace as metadata until its owner completes
onboarding. VM capacity is admitted only after the existing onboarding
completion transition records `workspaces.onboardedAt`.

This protects the provider fleet from disposable or abandoned signups: the
signup can create an account, membership, and workspace row without creating an
exe.dev VM. Invited users continue to join the invited workspace directly and
never receive a personal workspace as a side effect.

## Why this boundary exists

The workspace row must exist before onboarding so the product can store the
wizard's state and payment attempt, but provider capacity is the expensive side
effect. Putting the rule only in HTTP admission would leave background
entitlement and convergence paths able to schedule an attach. The attach
lifecycle therefore owns the final check immediately before provider work.

The change is a hard cutover for future incomplete workspaces. Existing VMs and
queued attach runs are intentionally left alone; no migration, cleanup sweep, or
compatibility state was added.

## Invariants

- `onboardedAt` is the only durable VM-admission fact for incomplete workspaces.
- A workspace with no `onboardedAt` schedules no new attach and cannot reach
  `exe.create()` through the attach action.
- The attach plan short-circuits before provider listing, while the preparation
  mutation repeats the check as the race boundary before provisioning state is
  written.
- Successful onboarding schedules the existing idempotent VM attach after the
  payment-readiness check and onboarding timestamp write.
- Invite bootstrap consumes a valid invite into its target workspace without
  creating a personal workspace.
- Historical incomplete-workspace resources are not modified by this feature.

## Code pointers

- Signup birth and invite handling: [`packages/backend/convex/domains/invitations/model.ts`](../../../packages/backend/convex/domains/invitations/model.ts)
- Onboarding completion and the admission transition: [`packages/backend/convex/domains/workspaces/birth.ts`](../../../packages/backend/convex/domains/workspaces/birth.ts)
- Attach plan and transactional preparation gate: [`packages/backend/convex/domains/workspaces/vmAttachModel.ts`](../../../packages/backend/convex/domains/workspaces/vmAttachModel.ts)
- Provider attach action: [`packages/backend/convex/domains/workspaces/vmAttach.ts`](../../../packages/backend/convex/domains/workspaces/vmAttach.ts)
- Signup and invite behavior tests: [`packages/backend/src/invitations.test.ts`](../../../packages/backend/src/invitations.test.ts)
- Provider-create regression harness: [`packages/backend/src/vm-attach.test.ts`](../../../packages/backend/src/vm-attach.test.ts)
- Completion scheduling tests: [`packages/backend/convex/domains/workspaces/birth.test.ts`](../../../packages/backend/convex/domains/workspaces/birth.test.ts)

## Rejected approaches

- Scheduling an attach at signup and relying on a later refusal was rejected
  because it creates durable background work for users who have not completed
  onboarding.
- A cleanup migration for recent incomplete users was rejected because the user
  explicitly chose to protect future signups while leaving existing resources
  untouched.
- A second boolean or compatibility flag was rejected because it would create a
  competing owner for the existing onboarding timestamp.

## Verification

Focused attach, birth, invitation, and authentication tests pass, as do the
backend type-check and lint checks. The broad backend package run reached the
changed areas and exposed unrelated existing Resend fixture failures plus
isolated Convex test-module resolution errors; those remain outside this
feature's scope.
