import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  RuntimeReleaseDescriptorSchema,
  WorkspaceSlugSchema,
  type RuntimeReleaseDescriptor,
  type VmSyncResponse,
} from '@repo/contract'

import {
  defaultAtomicJsonOperations,
  writeAtomicJson,
  type AtomicJsonOperations,
} from './atomic-json'

export const DESIRED_STATE_FILE = 'desired-state.json'

export interface DesiredStateSnapshot {
  generation: string
  paused: boolean
  quiesced: boolean
  workspaceSlug?: string
  runtimeRelease?: RuntimeReleaseDescriptor
}

export interface DesiredStateStore {
  accept(payload: VmSyncResponse): Promise<DesiredStateSnapshot>
  acceptRuntimeRelease(descriptor: RuntimeReleaseDescriptor): Promise<DesiredStateSnapshot>
  current(): DesiredStateSnapshot
  /**
   * Run `activate` inside the store's critical section iff `version` is still
   * the desired runtime and updates are not paused.
   * Only the version matters: a candidate built for a still-desired version
   * is the right binary no matter what else changed while it installed.
   */
  activateIfCurrent(version: string, activate: () => Promise<void>): Promise<boolean>
}

export function createDesiredStateStore(
  stateDir: string,
  operations: AtomicJsonOperations = defaultAtomicJsonOperations,
): DesiredStateStore {
  let current = readPersisted(stateDir)
  let tail = Promise.resolve()

  return {
    accept: payload => serialized(() => accept(payload)),

    acceptRuntimeRelease: descriptor => serialized(() => acceptRuntimeRelease(descriptor)),

    current: () => snapshot(current),

    activateIfCurrent: (version, activate) =>
      serialized(async () => {
        if (!allowsActivation(version)) return false
        await activate()
        return true
      }),
  }

  function accept(payload: VmSyncResponse): DesiredStateSnapshot {
    const workspaceSlug = payload.workspaceSlug ?? current.workspaceSlug
    const next = {
      paused: payload.updates.paused,
      quiesced: payload.quiesce === true,
      ...(workspaceSlug === undefined ? {} : { workspaceSlug }),
      ...(payload.runtimeRelease === undefined
        ? {}
        : { runtimeRelease: structuredClone(payload.runtimeRelease) }),
    } satisfies Omit<DesiredStateSnapshot, 'generation'>
    // Compare canonical forms only: JSON.stringify is key-order sensitive, so
    // a literal checked against the normalizer's output differs on every poll
    // even when nothing changed. A generation that moves on identical input
    // cancels every in-flight install (the rail keys cancellation on it).
    if (sameDesire(current, { ...next, generation: current.generation })) {
      return snapshot(current)
    }
    const accepted = {
      generation: String(Number.parseInt(current.generation, 10) + 1),
      ...next,
    }
    persist(stateDir, accepted, operations)
    current = accepted
    return snapshot(current)
  }

  // A validated runtime envelope may rescue a client that cannot yet read
  // the full response; rollout pause and workspace servicing state stay intact.
  function acceptRuntimeRelease(descriptor: RuntimeReleaseDescriptor): DesiredStateSnapshot {
    if (
      current.runtimeRelease !== undefined &&
      JSON.stringify(current.runtimeRelease) === JSON.stringify(descriptor)
    ) {
      return snapshot(current)
    }
    const accepted = {
      ...current,
      generation: String(Number.parseInt(current.generation, 10) + 1),
      runtimeRelease: structuredClone(descriptor),
    }
    persist(stateDir, accepted, operations)
    current = accepted
    return snapshot(current)
  }

  function allowsActivation(version: string): boolean {
    if (current.paused) return false
    return current.runtimeRelease?.version === version
  }

  function serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function readPersisted(stateDir: string): DesiredStateSnapshot {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, DESIRED_STATE_FILE), 'utf8')) as unknown
    if (typeof value !== 'object' || value === null) return initialState()
    const candidate = value as Record<string, unknown>
    if (
      typeof candidate.generation !== 'string' ||
      !/^\d+$/.test(candidate.generation) ||
      typeof candidate.paused !== 'boolean' ||
      typeof candidate.quiesced !== 'boolean'
    ) {
      return initialState()
    }
    const release = RuntimeReleaseDescriptorSchema.safeParse(candidate.runtimeRelease)
    const workspace = WorkspaceSlugSchema.safeParse(candidate.workspaceSlug)
    return {
      generation: candidate.generation,
      paused: candidate.paused,
      quiesced: candidate.quiesced,
      ...(workspace.success ? { workspaceSlug: workspace.data } : {}),
      ...(release.success ? { runtimeRelease: release.data } : {}),
    }
  } catch {
    return initialState()
  }
}

function persist(
  stateDir: string,
  value: DesiredStateSnapshot,
  operations: AtomicJsonOperations,
): void {
  writeAtomicJson(join(stateDir, DESIRED_STATE_FILE), value, operations)
}

function snapshot(value: DesiredStateSnapshot): DesiredStateSnapshot {
  return structuredClone(value)
}

function initialState(): DesiredStateSnapshot {
  return { generation: '0', paused: true, quiesced: false }
}

function sameDesire(left: DesiredStateSnapshot, right: DesiredStateSnapshot): boolean {
  return JSON.stringify(withoutGeneration(left)) === JSON.stringify(withoutGeneration(right))
}

function withoutGeneration(value: DesiredStateSnapshot): Omit<DesiredStateSnapshot, 'generation'> {
  return {
    paused: value.paused,
    quiesced: value.quiesced,
    ...(value.runtimeRelease === undefined ? {} : { runtimeRelease: value.runtimeRelease }),
    ...(value.workspaceSlug === undefined ? {} : { workspaceSlug: value.workspaceSlug }),
  }
}
