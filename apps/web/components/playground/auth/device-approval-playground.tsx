'use client'

import { useState } from 'react'

import { DeviceApprovalScreen, type DeviceInspection } from '../../auth/device-approval-card'

export function DeviceApprovalPlayground() {
  return (
    <>
      <DeviceFixture
        fixtureId="device-approval-pending"
        userCode="KFRT-29XM"
        inspection={{ userCode: 'KFRT-29XM', status: 'pending', clientName: 'MacBook Pro' }}
      />
      <DeviceFixture
        fixtureId="device-approval-approved"
        userCode="QV4P-JM2K"
        inspection={{ userCode: 'QV4P-JM2K', status: 'approved', clientName: 'Mac Studio' }}
        message="Signed in. Return to your terminal."
      />
      <DeviceFixture
        fixtureId="device-approval-denied"
        userCode="H7CD-42PR"
        inspection={{ userCode: 'H7CD-42PR', status: 'denied' }}
        message="Device denied."
      />
      <DeviceFixture
        fixtureId="device-approval-expired"
        userCode="DJ7K-MP4Q"
        inspection={{ userCode: 'DJ7K-MP4Q', status: 'expired' }}
      />
    </>
  )
}

function DeviceFixture({
  fixtureId,
  userCode: initialCode,
  inspection,
  message,
}: {
  fixtureId: string
  userCode: string
  inspection: DeviceInspection
  message?: string
}) {
  const [userCode, setUserCode] = useState(initialCode)
  return (
    <div data-fixture-id={fixtureId}>
      <DeviceApprovalScreen
        userCode={userCode}
        inspection={inspection}
        message={message}
        onUserCodeChange={setUserCode}
      />
    </div>
  )
}
