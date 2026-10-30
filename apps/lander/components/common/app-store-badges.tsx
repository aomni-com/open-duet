'use client'

import { useTranslations } from 'next-intl'
import Image from 'next/image'

import { cn } from '@repo/ui/lib/utils'

import { MOBILE_APP_LINKS } from '@/lib/mobile-app-links'

type BadgeSize = 'sm' | 'md' | 'lg'

// App Store badge is ~3:1 aspect ratio, Google Play is ~2.58:1
const appStoreSizes: Record<BadgeSize, { width: number; height: number }> = {
  sm: { width: 120, height: 40 },
  md: { width: 135, height: 45 },
  lg: { width: 162, height: 54 },
}

const googlePlaySizes: Record<BadgeSize, { width: number; height: number }> = {
  sm: { width: 135, height: 40 },
  md: { width: 152, height: 45 },
  lg: { width: 182, height: 54 },
}

type AppStoreBadgesProps = {
  size?: BadgeSize
  className?: string
  badgeClassName?: string
  showIos?: boolean
  showAndroid?: boolean
}

export function AppStoreBadges({
  size = 'md',
  className,
  badgeClassName,
  showIos = true,
  showAndroid = true,
}: AppStoreBadgesProps) {
  const appStore = appStoreSizes[size]
  const googlePlay = googlePlaySizes[size]
  const t = useTranslations('appStoreBadges')

  return (
    <div className={cn('flex items-center gap-3', className)}>
      {showIos && (
        <a
          href={MOBILE_APP_LINKS.ios}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('transition-opacity hover:opacity-80', badgeClassName)}
        >
          <Image
            src="/badges/app-store.svg"
            alt={t('appStoreAlt')}
            width={appStore.width}
            height={appStore.height}
            className="h-auto"
          />
        </a>
      )}
      {showAndroid && (
        <a
          href={MOBILE_APP_LINKS.android}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('transition-opacity hover:opacity-80', badgeClassName)}
        >
          <Image
            src="/badges/google-play.png"
            alt={t('googlePlayAlt')}
            width={googlePlay.width}
            height={googlePlay.height}
            className="h-auto"
          />
        </a>
      )}
    </div>
  )
}
