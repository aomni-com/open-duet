'use client'

import { ToggleLeftIcon, ToggleRightIcon } from '@phosphor-icons/react'
import React, { useState } from 'react'

import { DescriptiveToggle } from '@repo/ui/components/common/descriptive-toggle'
import { ExplainerDialog } from '@repo/ui/components/common/explainer-dialog'
import { InlineEditText } from '@repo/ui/components/common/inline-edit-text'
import { ThemeToggle } from '@repo/ui/components/common/theme-toggle'
import { Button } from '@repo/ui/components/shadcn/button'

export function UtilityDemos() {
  const [currentMode, setCurrentMode] = useState<'auto' | 'manual'>('auto')
  const [editableText, setEditableText] = useState('Click to edit this text')

  const toggleOptions = [
    {
      value: 'auto' as const,
      label: 'Auto Mode',
      description: 'Automatically handle tasks and decisions',
      icon: <ToggleRightIcon className="size-4" />,
      primary: true,
    },
    {
      value: 'manual' as const,
      label: 'Manual Mode',
      description: 'Take full control of all settings',
      icon: <ToggleLeftIcon className="size-4" />,
      primary: false,
    },
  ]

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Descriptive Toggle</h3>
        <div className="max-w-md">
          <DescriptiveToggle
            currentMode={currentMode}
            onSelectMode={setCurrentMode}
            options={toggleOptions}
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Current mode: <strong>{currentMode}</strong>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Theme Toggle</h3>
        <div className="flex items-center gap-4">
          <ThemeToggle />
          <span className="text-sm text-muted-foreground">
            Toggle between light and dark themes
          </span>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Inline Edit Text</h3>
        <div className="max-w-md">
          <InlineEditText
            value={editableText}
            onSave={setEditableText}
            placeholder="Enter text here..."
          />
        </div>
        <div className="text-sm text-muted-foreground">
          Click the text above to edit it inline. Press Enter to save or Escape to cancel.
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Explainer Dialog</h3>
        <ExplainerDialog
          title="How it Works"
          description="This is an explainer dialog that provides detailed information about a feature or process."
          renderContent={() => (
            <div className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">Step 1: Setup</h4>
                <p className="text-sm text-muted-foreground">
                  Configure your initial settings and preferences.
                </p>
              </div>
              <div>
                <h4 className="font-medium mb-2">Step 2: Integration</h4>
                <p className="text-sm text-muted-foreground">
                  Connect your external services and data sources.
                </p>
              </div>
              <div>
                <h4 className="font-medium mb-2">Step 3: Launch</h4>
                <p className="text-sm text-muted-foreground">
                  Start using the feature with your configured settings.
                </p>
              </div>
            </div>
          )}
        >
          <Button variant="outline">Learn How It Works</Button>
        </ExplainerDialog>
      </div>
    </div>
  )
}
