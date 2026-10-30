import { expect, test } from 'bun:test'

import { agentManagementDestinationForPath } from './agent-management-route'

test('agent Settings and canonical Train paths share one management destination shape', () => {
  expect(agentManagementDestinationForPath('/w/acme/agents/research/settings', 'acme')).toEqual({
    mode: 'settings',
    agentSlug: 'research',
  })
  expect(agentManagementDestinationForPath('/w/acme/train/research', 'acme')).toEqual({
    mode: 'train',
    agentSlug: 'research',
  })
  expect(agentManagementDestinationForPath('/w/acme/train/research/brief-format', 'acme')).toEqual({
    mode: 'train',
    agentSlug: 'research',
  })
  for (const path of ['/w/acme/train/root', '/w/acme/train/root/support-handbook']) {
    expect(agentManagementDestinationForPath(path, 'acme')).toEqual({
      mode: 'train',
      agentSlug: 'root',
    })
  }
  expect(agentManagementDestinationForPath('/w/acme/train/customer%20success', 'acme')).toEqual({
    mode: 'train',
    agentSlug: 'customer success',
  })
  expect(agentManagementDestinationForPath('/w/acme/train/research-child', 'acme')).toEqual({
    mode: 'train',
    agentSlug: 'research-child',
  })
})

test('agent management classification fails closed outside the selected workspace', () => {
  expect(agentManagementDestinationForPath('/w/other/agents/research/settings', 'acme')).toBeNull()
  expect(agentManagementDestinationForPath('/w/acme/agents/research', 'acme')).toBeNull()
  expect(agentManagementDestinationForPath('/w/acme/train', 'acme')).toBeNull()
  expect(agentManagementDestinationForPath('/w/acme/train/%2Fresearch', 'acme')).toBeNull()
  expect(agentManagementDestinationForPath('/w/acme/trainer', 'acme')).toBeNull()
  expect(agentManagementDestinationForPath('/w/other/train/root', 'acme')).toBeNull()
})
