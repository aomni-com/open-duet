import { expect, test } from 'bun:test'

import appEn from '../messages/en/app.json'
import appEs from '../messages/es-419/app.json'
import { DuetApiError } from './api/client'
import { workspaceRefusalCopyKey } from './workspace-refusal'

test('workspace refusal codes select complete English and Spanish copy', () => {
  const keys = ['paused', 'provisioning', 'unhealthy', 'archived'] as const
  for (const key of keys) {
    expect(workspaceRefusalCopyKey(new DuetApiError(503, `workspace_${key}`))).toBe(key)
    expect(appEn.duetApp.desktop.refusals[key].title).not.toBe('')
    expect(appEn.duetApp.filesSurface.refusals[key].body).not.toBe('')
    expect(appEs.duetApp.desktop.refusals[key].title).not.toBe('')
    expect(appEs.duetApp.filesSurface.refusals[key].body).not.toBe('')
  }
  expect(workspaceRefusalCopyKey(new DuetApiError(503, 'future_value'))).toBeNull()
  expect(workspaceRefusalCopyKey(new Error('workspace_unhealthy'))).toBeNull()
})
