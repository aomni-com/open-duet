'use client'

import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { HUMAN_ENTRY_CODE_PATTERN } from '@repo/contract'

import {
  DeviceApprovalScreen,
  type DeviceInspection,
} from '../../components/auth/device-approval-card'
import { duetApi, DuetApiError } from '../../spa/api/client'

const COMPLETE_USER_CODE = HUMAN_ENTRY_CODE_PATTERN

export default function Page() {
  const searchParams = useSearchParams()
  const [userCode, setUserCode] = useState(searchParams.get('user_code')?.toUpperCase() ?? '')
  const [inspection, setInspection] = useState<DeviceInspection>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()

  const run = async (operation: 'inspect' | 'approve' | 'deny') => {
    setBusy(true)
    setMessage(undefined)
    const result = await duetApi.deviceApproval(operation, userCode).catch(error => {
      if (error instanceof DuetApiError && error.status === 401) return 'unauthorized' as const
      return null
    })
    if (result === 'unauthorized') {
      window.location.assign(
        `/sign-in?returnTo=${encodeURIComponent(`/device?user_code=${userCode}`)}`,
      )
      return
    }
    if (!result) {
      setMessage('That device code is unavailable. Check the code and try again.')
      setInspection(undefined)
    } else if (operation === 'inspect') {
      setInspection(result)
    } else {
      setInspection(result)
      setMessage(operation === 'approve' ? 'Signed in. Return to your terminal.' : 'Device denied.')
    }
    setBusy(false)
  }

  // No Inspect button exists (spec ledger #29): a complete code inspects
  // itself, once per distinct value — a failed lookup isn't retried until
  // the code changes.
  const lastInspectedCode = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!COMPLETE_USER_CODE.test(userCode)) return
    if (lastInspectedCode.current === userCode) return
    lastInspectedCode.current = userCode
    void run('inspect')
    // run is recreated per render; the ref guard makes this effect fire once
    // per distinct complete code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userCode])

  return (
    <DeviceApprovalScreen
      userCode={userCode}
      inspection={inspection}
      busy={busy}
      message={message}
      onUserCodeChange={code => {
        setUserCode(code)
        setInspection(undefined)
        setMessage(undefined)
      }}
      onApprove={() => void run('approve')}
      onDeny={() => void run('deny')}
    />
  )
}
