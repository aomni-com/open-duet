import { expect, test } from 'bun:test'

import { ROOT_TRAIN_SCOPE } from '../../api/train-scope'
import { legacyAgentTrainRedirectPath, trainPath, trainRecordPath } from './train-routes'

const RESEARCH = { kind: 'agent', agentSlug: 'research' } as const

/* Every scope in the rail is named in the URL, including the drive's own.

   Root used to be the *absence* of a scope — the bare `computer/train` path —
   which made it the one row in the picker whose selection a link could not
   express, and made a root memory (`train/support-handbook`) and an agent
   (`train/agents/research`) two shapes that needed a static `agents/` segment
   between them to stay apart. Naming root removes both problems at once: the
   grammar is a mirror of `/agents/:agentSlug`, and `root` is the same reserved
   token there, in the contract, and in the session alias. */
test('every scope is a slug, and the drive’s own is `root`', () => {
  expect(trainPath('acme', ROOT_TRAIN_SCOPE)).toBe('/w/acme/train/root')
  expect(trainPath('acme', RESEARCH)).toBe('/w/acme/train/research')
})

test('a memory hangs off the scope that owns it, whichever scope that is', () => {
  expect(trainRecordPath('acme', ROOT_TRAIN_SCOPE, 'support-handbook')).toBe(
    '/w/acme/train/root/support-handbook',
  )
  expect(trainRecordPath('acme', RESEARCH, 'brief-format')).toBe(
    '/w/acme/train/research/brief-format',
  )
})

test('encodes everything it interpolates', () => {
  expect(trainPath('acme space', { kind: 'agent', agentSlug: 'brief writer' })).toBe(
    '/w/acme%20space/train/brief%20writer',
  )
  expect(trainRecordPath('acme', RESEARCH, 'a/../b')).toBe('/w/acme/train/research/a%2F..%2Fb')
})

/* The agent's own `…/agents/:slug/train` URL still redirects into the control
   centre rather than becoming a second Train page — the shipped decision that
   Train is one surface with a scope picker. It follows the scope grammar
   wherever that grammar goes. */
test('the legacy agent Train link lands on that agent’s scope', () => {
  expect(legacyAgentTrainRedirectPath('acme', 'research', undefined, new URLSearchParams())).toBe(
    '/w/acme/train/research',
  )
  expect(
    legacyAgentTrainRedirectPath('acme', 'research', 'support handbook', new URLSearchParams()),
  ).toBe('/w/acme/train/research/support%20handbook')
  // the older `?record=` form names the same memory
  expect(
    legacyAgentTrainRedirectPath(
      'acme',
      'research',
      undefined,
      new URLSearchParams('record=support+handbook'),
    ),
  ).toBe('/w/acme/train/research/support%20handbook')
})
