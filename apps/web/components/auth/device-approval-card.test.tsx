import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { DeviceApprovalCard } from './device-approval-card'

test('pending device login names the human login without workspace or permission selection', () => {
  const html = renderToStaticMarkup(
    <DeviceApprovalCard
      userCode="XW3N-KR7T"
      inspection={{ userCode: 'XW3N-KR7T', status: 'pending', clientName: 'MacBook Pro' }}
    />,
  )
  expect(html).toContain('MacBook Pro')
  expect(html).toContain('Sign in')
  expect(html).toContain('current workspace membership')
  expect(html).not.toContain('<select')
  expect(html).not.toContain('files:read')
})

test('changing the entered code retires the inspected login action', () => {
  const html = renderToStaticMarkup(
    <DeviceApprovalCard
      userCode="ZZZZ-ZZZZ"
      inspection={{ userCode: 'XW3N-KR7T', status: 'pending', clientName: 'MacBook Pro' }}
    />,
  )
  expect(html).not.toContain('MacBook Pro')
  expect(html).not.toContain('<button')
})

test('a settled device login removes approval actions', () => {
  const html = renderToStaticMarkup(
    <DeviceApprovalCard
      userCode="DJ7K-MP4Q"
      inspection={{ userCode: 'DJ7K-MP4Q', status: 'approved' }}
      message="Signed in. Return to your terminal."
    />,
  )
  expect(html).toContain('Signed in. Return to your terminal.')
  expect(html).not.toContain('<button')
})
