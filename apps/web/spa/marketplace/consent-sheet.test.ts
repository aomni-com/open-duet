import { expect, test } from 'bun:test'

import { requiresInstallConsent } from './consent-sheet'

const app = { path: 'agents/x/apps/y', command: 'bun run start', apiScopes: ['files:write'] }

test('a verified publisher never sees the consent sheet', () => {
  // Consent is a decision about WHO is trusted; the verified badge already
  // answers it, and official installs keep the shipped zero-friction path.
  expect(requiresInstallConsent({ verifiedPublisher: true, apps: [app] })).toBe(false)
})

test('an unverified publisher shipping code always does', () => {
  expect(requiresInstallConsent({ verifiedPublisher: false, apps: [app] })).toBe(true)
})

test('an unverified listing with no apps runs nothing, so it asks nothing', () => {
  // Prompt and skills still install — but nothing auto-executes, so there is no
  // command or scope to disclose and a sheet would be ceremony without content.
  expect(requiresInstallConsent({ verifiedPublisher: false, apps: [] })).toBe(false)
})
