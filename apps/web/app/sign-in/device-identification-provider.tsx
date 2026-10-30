'use client'

import {
  FingerprintJSPro,
  FpjsProvider,
  useVisitorData,
} from '@fingerprintjs/fingerprintjs-pro-react'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { identifyDevice, type DeviceIdentification } from '../../src/auth/device-identification'

const API_KEY = process.env.NEXT_PUBLIC_FINGERPRINT_API_KEY

// A first-party subdomain, not Fingerprint's own origin, for BOTH the agent
// script and the identification calls. Ad blockers list Fingerprint's CDN, and
// a blocked loader fails the whole identification before the endpoint is ever
// asked — a third of real signups arrived with no device evidence while only
// the endpoint was proxied. The users behind blockers are also the ones most
// likely to be farming trials, so the gate would fail open for exactly the
// population it exists to catch. The CDN stays as the fallback the SDK tries
// next, so a broken subdomain degrades to the old behaviour, not to no agent.
const ENDPOINT = 'https://def.duet.so'
const SCRIPT_URL_PATTERNS = [
  `${ENDPOINT}/web/v<version>/<apiKey>/loader_v<loaderVersion>.js`,
  FingerprintJSPro.defaultScriptUrlPattern,
]

type Identify = () => Promise<DeviceIdentification | undefined>

// Defaults to "cannot identify", which the server treats as an allow. That is
// what makes an unkeyed environment — local dev, a preview without the secret —
// behave like a user with an ad blocker rather than a broken page.
const IdentifyContext = createContext<Identify>(async () => undefined)

export function useIdentifyDevice(): Identify {
  return useContext(IdentifyContext)
}

/**
 * Wraps only the sign-in surface, never the app shell: device identification is
 * a signup concern, and scoping it here keeps the SDK off every other page.
 *
 * The SDK lives entirely behind this boundary. `useVisitorData` throws outside
 * an `FpjsProvider`, so the consumer must never call it directly — otherwise the
 * unkeyed path would crash the sign-in page instead of failing open.
 */
export function DeviceIdentificationProvider({ children }: { children: ReactNode }) {
  if (API_KEY === undefined || API_KEY.length === 0) return <>{children}</>
  return (
    <FpjsProvider
      loadOptions={{ apiKey: API_KEY, endpoint: [ENDPOINT], scriptUrlPattern: SCRIPT_URL_PATTERNS }}
    >
      <IdentifyBridge>{children}</IdentifyBridge>
    </FpjsProvider>
  )
}

function IdentifyBridge({ children }: { children: ReactNode }) {
  // Lazy: nothing is identified until a signup actually completes.
  const { getData } = useVisitorData({}, { immediate: false })
  const identify = useMemo<Identify>(() => async () => await identifyDevice(getData), [getData])
  return <IdentifyContext.Provider value={identify}>{children}</IdentifyContext.Provider>
}
