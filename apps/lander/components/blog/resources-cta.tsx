'use client'

import { Check, Package } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { primaryCtaClassName } from '@/components/landing/landing-cta'
import { Link } from '@/i18n/navigation'

import { EmailCaptureForm } from './email-capture-form'

type ResourcesCTAProps = {
  className?: string
  title?: string
  subtitle?: string
  buttonText?: string
  href: string
  imageSrc?: string
  imageAlt?: string
}

export function ResourcesCTA({
  className,
  title,
  subtitle,
  buttonText,
  href,
  imageSrc,
  imageAlt,
}: ResourcesCTAProps) {
  const t = useTranslations('blogUi')
  const resolvedTitle = title ?? t('followAlong')
  const resolvedSubtitle = subtitle ?? t('followAlongBody')
  const resolvedButtonText = buttonText ?? t('getResources')
  const resolvedImageAlt = imageAlt ?? t('resourcesPreviewAlt')
  const [isSubmitted, setIsSubmitted] = useState(false)

  return (
    <div
      className={cn(
        'bg-lv2-surface-alt my-12 overflow-hidden rounded-2xl border border-lv2-line',
        className,
      )}
    >
      <div className="flex flex-col md:flex-row">
        {/* Left side - Image or Placeholder */}
        <div className="md:w-2/5 relative min-h-[200px] md:min-h-[280px]">
          {imageSrc ? (
            // oxlint-disable-next-line eslint-plugin-next/no-img-element
            <img
              src={imageSrc}
              alt={resolvedImageAlt}
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            // Brand-blue tinted placeholder
            <div className="bg-lv2-surface absolute inset-0">
              <div className="absolute inset-0 flex items-center justify-center">
                <Package
                  className="h-20 w-20"
                  weight="duotone"
                  style={{ color: 'hsl(214 65% 50% / 0.4)' }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Right side - Content */}
        <div className="flex flex-1 flex-col justify-center p-8 md:p-10">
          <h3 className="text-lv2-fg mb-3 text-2xl font-bold [&]:m-0 [&]:mb-3 md:text-3xl">
            {resolvedTitle}
          </h3>
          <p className="text-lv2-muted mb-6 text-base [&]:m-0 [&]:mb-6 md:text-lg">
            {resolvedSubtitle}
          </p>

          {isSubmitted ? (
            <Link
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(primaryCtaClassName('md'), 'w-fit')}
            >
              <Check className="h-5 w-5" weight="bold" />
              {t('downloadResources')}
            </Link>
          ) : (
            <EmailCaptureForm
              variant="large"
              buttonText={resolvedButtonText}
              source="resources-cta"
              onSuccess={() => setIsSubmitted(true)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
