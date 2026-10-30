import { describe, expect, test } from 'bun:test'

import { acquireTrackedInvitedMember } from './staging-live-invited-member.ts'

describe('invited-member staging fixture', () => {
  test('records identity cleanup before the invitation can create the user', async () => {
    const events: string[] = []

    await acquireTrackedInvitedMember({
      recordIdentityCleanup: () => events.push('record:user'),
      createInvite: async () => {
        events.push('create:invite')
        return 'invite'
      },
      openContext: async () => ({
        close: async () => {
          events.push('close:context')
        },
      }),
      login: async () => 'member',
    })

    expect(events).toEqual(['record:user', 'create:invite'])
  })

  test('closes a partially acquired browser context when login fails', async () => {
    const events: string[] = []

    await expect(
      acquireTrackedInvitedMember({
        recordIdentityCleanup: () => events.push('record:user'),
        createInvite: async () => {
          events.push('create:invite')
          return 'invite'
        },
        openContext: async () => ({
          close: async () => {
            events.push('close:context')
          },
        }),
        login: async () => {
          events.push('login')
          throw new Error('login failed')
        },
      }),
    ).rejects.toThrow('login failed')

    expect(events).toEqual(['record:user', 'create:invite', 'login', 'close:context'])
  })

  test('does not retain a context when invitation acquisition fails first', async () => {
    let opened = false

    await expect(
      acquireTrackedInvitedMember({
        recordIdentityCleanup: () => undefined,
        createInvite: async () => {
          throw new Error('invite failed')
        },
        openContext: async () => {
          opened = true
          return { close: async () => undefined }
        },
        login: async () => 'member',
      }),
    ).rejects.toThrow('invite failed')

    expect(opened).toBe(false)
  })
})
