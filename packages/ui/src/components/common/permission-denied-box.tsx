'use client'

import { WarningCircle } from '@phosphor-icons/react'

import { cn } from '@repo/ui/lib/utils'

export function PermissionDeniedBox({
  message,
  className,
}: {
  message: string
  className?: string
}) {
  return (
    <div className={cn('flex items-center rounded-lg border px-3 py-2', className)}>
      <WarningCircle className="mr-2 size-4" />
      <p className="text-sm">{message}</p>
    </div>
  )
}
