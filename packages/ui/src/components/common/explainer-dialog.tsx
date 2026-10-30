'use client'

import { Info } from '@phosphor-icons/react'
import { useState, type PropsWithChildren, type ReactNode } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/shadcn/dialog'
import { Separator } from '@repo/ui/components/shadcn/separator'
import { cn } from '@repo/ui/lib/utils'

type Props = {
  title: string
  description: string

  renderContent?: () => ReactNode
  isControlled?: boolean
  open?: boolean
  setOpen?: (open: boolean) => void
  className?: string
  iconClassName?: string
  dialogClassName?: string
}

export function ExplainerDialog({
  isControlled = false,
  open,
  setOpen,
  renderContent,
  title,
  description,
  className,
  iconClassName,
  dialogClassName,
  children,
}: PropsWithChildren<Props>) {
  const [_open, _setOpen] = useState(false)

  return (
    <Dialog
      open={isControlled ? open : _open}
      onOpenChange={open => {
        if (isControlled) {
          setOpen?.(open)
        } else {
          _setOpen(open)
        }
      }}
    >
      <DialogTrigger asChild>
        {children ? (
          children
        ) : (
          <Button variant="ghost" className={cn('size-auto shrink-0 p-1.5', className)}>
            <Info className={cn('size-4 text-blue-600 dark:text-blue-400', iconClassName)} />
          </Button>
        )}
      </DialogTrigger>

      <DialogContent
        className={cn(
          'max-w-md flex-col gap-2 rounded-md bg-background p-4 shadow-lg',
          dialogClassName,
        )}
      >
        {/* Hidden title is for screen readers */}
        <DialogTitle className="hidden">{title}</DialogTitle>

        <DialogHeader className="flex flex-row gap-2 font-semibold">
          <Info className="size-6 text-blue-600 dark:text-blue-400" />
          {title}
        </DialogHeader>

        <Separator className="my-2" />

        <DialogDescription className="max-h-[calc(100vh-200px)] overflow-y-auto whitespace-break-spaces text-sm">
          {description}
        </DialogDescription>

        {renderContent?.()}

        <DialogFooter className="mt-2">
          <Button
            variant="default"
            onClick={() => {
              if (isControlled) {
                setOpen?.(false)
              } else {
                _setOpen(false)
              }
            }}
            className="w-fit whitespace-nowrap"
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
