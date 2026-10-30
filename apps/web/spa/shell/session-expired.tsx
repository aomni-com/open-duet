import { useTranslations } from 'next-intl'

import { buttonVariants } from '@repo/ui/components/shadcn/button'

import { safeReturnTo } from '../../src/auth/return-to'
import { StatePage } from './state-page'

/**
 * The identity behind the browser session is gone, so the product cannot
 * continue. A plain anchor, not a router link: sign-in is a full document
 * outside the SPA, and the trip back must land on the page the person was
 * looking at, not the product root.
 */
export function SessionExpired({ returnTo }: { returnTo: string | undefined }) {
  const t = useTranslations('duetApp')
  return (
    <StatePage
      title={t('unauthorizedTitle')}
      body={t('unauthorizedBody')}
      action={
        <a className={buttonVariants()} href={signInHref(returnTo)}>
          {t('signIn')}
        </a>
      }
    />
  )
}

function signInHref(returnTo: string | undefined): string {
  return `/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`
}
