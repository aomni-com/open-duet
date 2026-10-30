import { expect, test } from 'bun:test'

import { createFilesRouteNavigator, createShareAcceptedHandler } from './files'

test('Files navigation writes encoded paths and reserves replace for explicit repairs', () => {
  const calls: Array<{ route: string; replace: boolean }> = []
  const navigate = createFilesRouteNavigator('acme', (route, options) => {
    calls.push({ route, replace: options.replace })
  })

  navigate('/Q3 Reports/Drafts')
  navigate('/100%.pdf', { replace: true })

  expect(calls).toEqual([
    { route: '/w/acme/files/Q3%20Reports/Drafts', replace: false },
    { route: '/w/acme/files/100%25.pdf', replace: true },
  ])
})

test('same-workspace acceptance calls the refresh callback before navigation to the encoded mount', () => {
  const events: unknown[] = []
  const onAccepted = createShareAcceptedHandler(
    'acme',
    path => events.push(`refresh:${path}`),
    (route, options) => events.push({ route, options }),
  )

  onAccepted('acme', 'Shared/Q3 Plans/100%')

  expect(events).toEqual([
    'refresh:/Shared/Q3 Plans/100%',
    {
      route: '/w/acme/files/Shared/Q3%20Plans/100%25',
      options: {
        replace: true,
        state: { acceptedMountPath: '/Shared/Q3 Plans/100%' },
      },
    },
  ])
})

test('accepting into another workspace replaces directly without refreshing the current drive', () => {
  const events: unknown[] = []
  const onAccepted = createShareAcceptedHandler(
    'acme',
    path => events.push(`refresh:${path}`),
    (route, options) => events.push({ route, options }),
  )

  onAccepted('labs space', 'Shared/a%2Fb')

  expect(events).toEqual([
    {
      route: '/w/labs%20space/files/Shared/a%252Fb',
      options: {
        replace: true,
        state: { acceptedMountPath: '/Shared/a%2Fb' },
      },
    },
  ])
})
