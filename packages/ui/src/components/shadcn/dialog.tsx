'use client'

import { X } from '@phosphor-icons/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'

import {
  composeHapticEventHandler,
  triggerHapticFeedback,
  type HapticFeedbackProp,
} from '@repo/ui/lib/haptics'
import { OverlaySuspendedContext } from '@repo/ui/lib/overlay-scope'
import { cn } from '@repo/ui/lib/utils'

const Dialog = DialogPrimitive.Root

const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger> & {
    hapticFeedback?: HapticFeedbackProp
  }
>(({ hapticFeedback = 'light', onClick, ...props }, ref) => (
  <DialogPrimitive.Trigger
    ref={ref}
    onClick={composeHapticEventHandler(onClick, hapticFeedback)}
    {...props}
  />
))
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName

function DialogPortal(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>) {
  const suspended = React.useContext(OverlaySuspendedContext)
  return suspended ? null : <DialogPrimitive.Portal {...props} />
}

const DialogClose = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & {
    hapticFeedback?: HapticFeedbackProp
  }
>(({ hapticFeedback = 'light', onClick, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    onClick={composeHapticEventHandler(onClick, hapticFeedback)}
    {...props}
  />
))
DialogClose.displayName = DialogPrimitive.Close.displayName

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-[6000] bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideCloseButton?: boolean
  }
>(({ className, children, hideCloseButton = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // max-h + overflow-y-auto are baked in so any oversized dialog
        // body scrolls inside the modal instead of clipping above/below
        // the viewport on short screens (laptops, mobile landscape).
        // If a dialog needs internal sticky regions or its own scroll
        // container, opt out by overriding these classes via className.
        'fixed left-[50%] top-[50%] z-[6000] grid w-full max-w-lg max-h-[calc(100dvh-2rem)] translate-x-[-50%] translate-y-[-50%] gap-3 overflow-y-auto overscroll-contain border bg-background p-4 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
        className,
      )}
      {...props}
    >
      {children}
      {!hideCloseButton && (
        <DialogPrimitive.Close
          className="absolute right-3 top-3 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
          onClick={() => triggerHapticFeedback('light')}
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1 text-center sm:text-left', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-1.5 sm:flex-row sm:justify-end sm:gap-0 sm:space-x-1.5',
      className,
    )}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
