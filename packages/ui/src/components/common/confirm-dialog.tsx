'use client'

import { type Icon } from '@phosphor-icons/react'
import React, { createElement, useEffect, useRef, useState, type PropsWithChildren } from 'react'

import { PermissionDeniedBox } from '@repo/ui/components/common/permission-denied-box'
import { Button } from '@repo/ui/components/shadcn/button'
import { Checkbox } from '@repo/ui/components/shadcn/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '@repo/ui/components/shadcn/dialog'

type CheckboxElement = {
  id: string
  label: string
  defaultChecked?: boolean
}

type StatefulCheckboxElement = CheckboxElement & {
  checked: boolean
}

type WithCheckBoxes = {
  onConfirm: (checkboxes: StatefulCheckboxElement[]) => void
  checkboxes: CheckboxElement[]
}

type WithoutCheckBoxes = {
  onConfirm: () => void
  checkboxes?: never
}

type Props = PropsWithChildren<{
  title: string
  titleIcon?: Icon
  description: string

  variant?: 'default' | 'destructive'
  loading?: boolean
  controlledOpen?: boolean
  confirmLabel?: string
  cancelLabel?: string
  closeOnConfirm?: boolean
  onCancel?: () => void
  renderContent?: () => React.ReactNode
  isAllowPermission?: boolean
  permissionMessage?: string
}> &
  (WithCheckBoxes | WithoutCheckBoxes)

export function ConfirmDialog({
  variant,
  title,
  titleIcon,
  description,
  loading = false,
  confirmLabel,
  cancelLabel = 'Cancel',
  children,
  onConfirm,
  onCancel,
  checkboxes,
  renderContent,
  closeOnConfirm = false,
  controlledOpen,
  isAllowPermission = true,
  permissionMessage = 'You do not have permission to perform this action.',
}: Props) {
  const prevLoading = useRef(false)
  const isControlled = typeof controlledOpen === 'boolean'

  const [open, setOpen] = useState(false)
  const [checkboxesState, setCheckboxesState] = useState<StatefulCheckboxElement[]>(
    () =>
      checkboxes?.map(checkbox => ({
        ...checkbox,
        checked: !!checkbox.defaultChecked,
      })) ?? [],
  )

  const resolvedConfirmLabel = confirmLabel || (variant === 'destructive' ? 'Delete' : 'Confirm')

  useEffect(() => {
    if (!loading && prevLoading.current) {
      setOpen(false)

      if (isControlled) {
        onCancel?.()
      }
    }

    prevLoading.current = loading
  }, [loading, isControlled, onCancel])

  return (
    <Dialog
      open={isControlled ? controlledOpen : loading || open}
      onOpenChange={change => {
        setOpen(change)

        if (change === false) {
          onCancel?.()
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogPortal>
        <DialogContent
          className="max-w-md flex-col rounded-md bg-background p-4 shadow-lg"
          onOpenAutoFocus={() => {}}
        >
          <DialogHeader className="font-semibold">
            <DialogTitle className="flex items-center gap-1.5 leading-snug">
              {titleIcon ? (
                <div className="bg-secondary rounded-md p-1.5">
                  {createElement(titleIcon, {
                    className: 'size-4',
                  })}
                </div>
              ) : null}
              {title}
            </DialogTitle>
          </DialogHeader>

          <DialogDescription>{description}</DialogDescription>

          {checkboxes ? (
            <div className="flex flex-col gap-2">
              {checkboxesState.map(checkbox => (
                <div className="flex items-center gap-2" key={checkbox.id}>
                  <Checkbox
                    disabled={loading}
                    id={checkbox.id}
                    checked={checkboxesState.find(c => c.id === checkbox.id)!.checked}
                    onCheckedChange={() => {
                      const updatedCheckboxes = checkboxesState.map(c =>
                        c.id === checkbox.id ? { ...c, checked: !c.checked } : c,
                      )

                      setCheckboxesState(updatedCheckboxes)
                    }}
                  />
                  <label
                    htmlFor={checkbox.id}
                    className="cursor-pointer text-sm font-medium leading-none"
                  >
                    {checkbox.label}
                  </label>
                </div>
              ))}
            </div>
          ) : null}

          {renderContent ? renderContent() : null}

          <DialogFooter className="flex flex-col sm:flex-col">
            {!isAllowPermission && (
              <PermissionDeniedBox className="mb-2" message={permissionMessage} />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-0 sm:space-x-2">
              <DialogClose asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loading}
                  onClick={e => {
                    e.stopPropagation()
                    setOpen(false)
                    onCancel?.()
                  }}
                  className="min-w-20 whitespace-nowrap"
                >
                  {cancelLabel}
                </Button>
              </DialogClose>

              <Button
                variant={variant}
                size="sm"
                isLoading={loading}
                disabled={loading || !isAllowPermission}
                onClick={() => {
                  if (checkboxes) {
                    onConfirm(checkboxesState)
                  } else {
                    onConfirm()
                  }

                  if (closeOnConfirm) {
                    setOpen(false)
                  }
                }}
                className="w-full whitespace-nowrap sm:w-fit"
              >
                {resolvedConfirmLabel}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
