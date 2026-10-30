'use client'

import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  PlusIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
  XCircleIcon,
} from '@phosphor-icons/react'
import React, { useState } from 'react'

import { ButtonCard } from '@repo/ui/components/common/button-card'
import { EmptyStateCard } from '@repo/ui/components/common/empty-state-card'
import { ErrorStateCard } from '@repo/ui/components/common/error-state-card'
import { PermissionDeniedBox } from '@repo/ui/components/common/permission-denied-box'

export function CardsDemos() {
  const [selectedCard, setSelectedCard] = useState<string>('')
  const [retryCount, setRetryCount] = useState(0)

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Button Card</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ButtonCard
            isSelected={selectedCard === 'option1'}
            onCardClick={() => setSelectedCard(selectedCard === 'option1' ? '' : 'option1')}
            title="AI Assistance"
            icon={CheckCircleIcon}
            description="Let AI automatically decide the best approach for your task"
          />
          <ButtonCard
            isSelected={selectedCard === 'option2'}
            onCardClick={() => setSelectedCard(selectedCard === 'option2' ? '' : 'option2')}
            title="Manual Control"
            icon={WarningCircleIcon}
            description="Take full control and configure everything manually"
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Selected: <strong>{selectedCard || 'None'}</strong>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Empty State Card</h3>
        <div className="flex justify-center">
          <EmptyStateCard
            title="No Items Found"
            description="You haven't created any items yet. Get started by creating your first item."
            icon={PlusIcon}
            primaryButton={{
              label: 'Create Item',
              onClick: () => alert('Create item clicked'),
              icon: PlusIcon,
            }}
            secondaryButton={{
              label: 'Learn More',
              onClick: () => alert('Learn more clicked'),
              icon: WarningCircleIcon,
            }}
            features={[
              {
                icon: CheckCircleIcon,
                iconColorsClassName: 'text-green-500',
                title: 'Easy Setup',
                description: 'Get started in minutes',
              },
              {
                icon: ArrowsClockwiseIcon,
                iconColorsClassName: 'text-blue-500',
                title: 'Auto Sync',
                description: 'Always up to date',
              },
              {
                icon: ShieldCheckIcon,
                iconColorsClassName: 'text-green-500',
                title: 'Secure',
                description: 'Your data is protected',
              },
            ]}
          />
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Error State Card</h3>
        <div className="flex justify-center">
          <ErrorStateCard
            title="Something went wrong"
            description="We encountered an error while processing your request. Please try again."
            icon={XCircleIcon}
            error={new Error('Network connection failed')}
            showErrorDetails={true}
            retryButton={{
              label: 'Retry',
              onClick: () => {
                setRetryCount(prev => prev + 1)
                alert(`Retry clicked (${retryCount + 1} times)`)
              },
              icon: ArrowsClockwiseIcon,
            }}
            secondaryButton={{
              label: 'Contact Support',
              onClick: () => alert('Contact support clicked'),
              icon: WarningCircleIcon,
            }}
          />
        </div>
        <div className="text-sm text-muted-foreground text-center">
          Retry count: <strong>{retryCount}</strong>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Permission Denied Box</h3>
        <div className="max-w-md">
          <PermissionDeniedBox message="You do not have permission to perform this action. Please contact your administrator." />
        </div>
      </div>
    </div>
  )
}
