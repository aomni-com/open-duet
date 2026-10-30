'use client'

import { EnvelopeSimple } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { getStorageItem, setStorageItem } from '@/lib/storage/safe-local-storage'

import { EmailCaptureForm } from './email-capture-form'

const LOCAL_STORAGE_KEY = 'duet-email-subscribed'

type FloatingEmailCaptureProps = {
  className?: string
  source?: string
  pageSlug?: string
  layout?: 'blog' | 'guide'
}

export function FloatingEmailCapture({
  className,
  source,
  pageSlug,
  layout = 'blog',
}: FloatingEmailCaptureProps) {
  const t = useTranslations('blogUi')
  const [isHidden, setIsHidden] = useState(true) // Start hidden to avoid flash

  const visibilityClass = layout === 'guide' ? 'hidden min-[1920px]:block' : 'hidden 2xl:block'
  const positionClass =
    layout === 'guide'
      ? 'right-[max(1.5rem,calc((100vw-80rem)/2-18rem))] top-1/2 -translate-y-1/2'
      : 'right-[max(1.5rem,calc((100vw-56rem)/2-18rem))] top-1/2 -translate-y-1/2'

  useEffect(() => {
    // Check localStorage to see if user already subscribed
    const hasSubscribed = getStorageItem(LOCAL_STORAGE_KEY)
    setIsHidden(hasSubscribed === 'true')
  }, [])

  const handleSuccess = () => {
    setStorageItem(LOCAL_STORAGE_KEY, 'true')
    // Small delay before hiding to show success state
    setTimeout(() => setIsHidden(true), 2000)
  }

  if (isHidden) return null

  return (
    <div
      data-nosnippet
      className={cn('fixed z-40', visibilityClass, positionClass, 'w-72', className)}
    >
      <div className="bg-lv2-surface shadow-lv2-card rounded-xl border border-lv2-line p-5">
        <div className="mb-3 flex items-center gap-2">
          <EnvelopeSimple className="text-lv2-accent h-5 w-5" weight="duotone" />
          <h3 className="text-lv2-fg text-lg font-semibold">{t('stayUpdated')}</h3>
        </div>
        <p className="text-lv2-muted mb-4 text-sm">{t('stayUpdatedBody')}</p>
        <EmailCaptureForm
          variant="compact"
          source={source}
          pageSlug={pageSlug}
          onSuccess={handleSuccess}
        />
      </div>
    </div>
  )
}
