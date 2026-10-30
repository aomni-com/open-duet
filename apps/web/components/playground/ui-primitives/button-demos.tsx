'use client'

import { useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'

export function ButtonDemos() {
  const [loadingStates, setLoadingStates] = useState({
    default: false,
    destructive: false,
    outline: false,
    secondary: false,
    ghost: false,
    link: false,
    cta: false,
  })

  const toggleLoading = (variant: keyof typeof loadingStates) => {
    setLoadingStates(prev => ({
      ...prev,
      [variant]: !prev[variant],
    }))
  }

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold mb-4">Button Variants</h3>
        <div className="flex flex-wrap gap-4">
          <Button variant="default">Default</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="cta">CTA</Button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Button Sizes</h3>
        <div className="flex items-center gap-4">
          <Button variant="default" size="sm">
            Small
          </Button>
          <Button variant="default" size="default">
            Default
          </Button>
          <Button variant="default" size="lg">
            Large
          </Button>
          <Button variant="default" size="icon">
            <span>🔥</span>
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Disabled States</h3>
        <div className="flex flex-wrap gap-4">
          <Button variant="default" disabled>
            Default Disabled
          </Button>
          <Button variant="destructive" disabled>
            Destructive Disabled
          </Button>
          <Button variant="outline" disabled>
            Outline Disabled
          </Button>
          <Button variant="secondary" disabled>
            Secondary Disabled
          </Button>
          <Button variant="ghost" disabled>
            Ghost Disabled
          </Button>
          <Button variant="link" disabled>
            Link Disabled
          </Button>
          <Button variant="cta" disabled>
            CTA Disabled
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Loading States</h3>
        <div className="flex flex-wrap gap-4">
          <Button
            variant="default"
            isLoading={loadingStates.default}
            onClick={() => toggleLoading('default')}
          >
            Default Loading
          </Button>
          <Button
            variant="destructive"
            isLoading={loadingStates.destructive}
            onClick={() => toggleLoading('destructive')}
          >
            Destructive Loading
          </Button>
          <Button
            variant="outline"
            isLoading={loadingStates.outline}
            onClick={() => toggleLoading('outline')}
          >
            Outline Loading
          </Button>
          <Button
            variant="secondary"
            isLoading={loadingStates.secondary}
            onClick={() => toggleLoading('secondary')}
          >
            Secondary Loading
          </Button>
          <Button
            variant="ghost"
            isLoading={loadingStates.ghost}
            onClick={() => toggleLoading('ghost')}
          >
            Ghost Loading
          </Button>
          <Button
            variant="link"
            isLoading={loadingStates.link}
            onClick={() => toggleLoading('link')}
          >
            Link Loading
          </Button>
          <Button variant="cta" isLoading={loadingStates.cta} onClick={() => toggleLoading('cta')}>
            CTA Loading
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Combined States (Disabled + Loading)</h3>
        <div className="flex flex-wrap gap-4">
          <Button variant="default" disabled isLoading>
            Default Disabled Loading
          </Button>
          <Button variant="destructive" disabled isLoading>
            Destructive Disabled Loading
          </Button>
          <Button variant="outline" disabled isLoading>
            Outline Disabled Loading
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold mb-4">Dev Mode (isDev prop)</h3>
        <div className="flex flex-wrap gap-4">
          <Button variant="default" isDev>
            Default Dev
          </Button>
          <Button variant="outline" isDev>
            Outline Dev
          </Button>
          <Button variant="cta" isDev isLoading>
            CTA Dev Loading
          </Button>
        </div>
      </div>
    </div>
  )
}
