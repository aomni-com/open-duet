'use client'

import { InfoIcon, QuestionIcon, TrashIcon, WarningIcon } from '@phosphor-icons/react'
import React, { useState } from 'react'

import { ConfirmDialog } from '@repo/ui/components/common/confirm-dialog'
import { Button } from '@repo/ui/components/shadcn/button'

export function DialogsDemos() {
  const [isLoading, setIsLoading] = useState(false)
  const [lastAction, setLastAction] = useState<string>('')

  const handleConfirm = () => {
    setIsLoading(true)
    setLastAction('Confirmed')
    setTimeout(() => {
      setIsLoading(false)
    }, 2000)
  }

  const handleConfirmWithCheckboxes = (checkboxes: { checked: boolean; label: string }[]) => {
    setIsLoading(true)
    const checkedItems = checkboxes.filter(cb => cb.checked).map(cb => cb.label)
    setLastAction(`Confirmed with: ${checkedItems.join(', ') || 'none'}`)
    setTimeout(() => {
      setIsLoading(false)
    }, 2000)
  }

  const handleCancel = () => {
    setLastAction('Cancelled')
  }

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Confirm Dialog</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ConfirmDialog
            title="Delete Item"
            titleIcon={TrashIcon}
            description="Are you sure you want to delete this item? This action cannot be undone."
            variant="destructive"
            loading={isLoading}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          >
            <Button variant="destructive">Delete Item</Button>
          </ConfirmDialog>

          <ConfirmDialog
            title="Save Changes"
            titleIcon={InfoIcon}
            description="Do you want to save your changes before continuing?"
            confirmLabel="Save"
            cancelLabel="Discard"
            loading={isLoading}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          >
            <Button variant="outline">Save Changes</Button>
          </ConfirmDialog>

          <ConfirmDialog
            title="Export Data"
            titleIcon={QuestionIcon}
            description="Choose what data to include in your export."
            confirmLabel="Export"
            loading={isLoading}
            checkboxes={[
              { id: 'users', label: 'User Data', defaultChecked: true },
              { id: 'settings', label: 'Settings', defaultChecked: false },
              { id: 'logs', label: 'Activity Logs', defaultChecked: false },
            ]}
            onConfirm={handleConfirmWithCheckboxes}
            onCancel={handleCancel}
          >
            <Button>Export with Options</Button>
          </ConfirmDialog>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
          <ConfirmDialog
            title="Restricted Action"
            titleIcon={WarningIcon}
            description="This action requires special permissions."
            isAllowPermission={false}
            permissionMessage="You need admin privileges to perform this action."
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          >
            <Button variant="outline">Restricted Action</Button>
          </ConfirmDialog>

          <ConfirmDialog
            title="Custom Content"
            titleIcon={InfoIcon}
            description="This dialog includes custom content below."
            loading={isLoading}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
            renderContent={() => (
              <div className="p-4 bg-muted rounded-md">
                <h4 className="font-medium text-sm mb-2">Additional Information</h4>
                <p className="text-xs text-muted-foreground">
                  This is custom content that can be rendered inside the dialog. You can include any
                  React components here.
                </p>
              </div>
            )}
          >
            <Button variant="outline">Custom Content</Button>
          </ConfirmDialog>
        </div>

        {lastAction && (
          <div className="mt-6 p-4 bg-muted rounded-md">
            <h4 className="font-medium text-sm mb-1">Last Action:</h4>
            <p className="text-sm text-muted-foreground">{lastAction}</p>
          </div>
        )}
      </div>
    </div>
  )
}
