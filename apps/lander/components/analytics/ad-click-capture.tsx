'use client'

import { getCookie, setCookie } from 'cookies-next'
import { useEffect } from 'react'

import { AD_CLICK_PARAMS, UTM_PARAMS } from '@repo/contract'

const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * Root-layout attribution capture. Ad networks can land on any route; cookies
 * preserve click ids and first-touch UTMs through later internal navigation.
 */

export function AdClickCapture() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    for (const param of AD_CLICK_PARAMS) {
      const value = params.get(param)
      if (value) {
        setCookie(param, value, {
          maxAge: ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
          path: '/',
          secure: true,
        })
      }
    }

    for (const param of UTM_PARAMS) {
      const value = params.get(param)
      if (value && !getCookie(param)) {
        setCookie(param, value, {
          maxAge: ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
          path: '/',
          secure: true,
        })
      }
    }
  }, [])

  return null
}
