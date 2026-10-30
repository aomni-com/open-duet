'use client'

import { ArrowRightIcon, ArrowsClockwiseIcon, PlayIcon } from '@phosphor-icons/react'
import React, { useState } from 'react'

import {
  AnimateDirection,
  type AnimationDirection,
} from '@repo/ui/components/common/animate-direction'
import { AnimatedEllipsis } from '@repo/ui/components/common/animate-ellipsis'
import { AnimateHeight } from '@repo/ui/components/common/animate-height'
import { AnimateIn } from '@repo/ui/components/common/animate-in'
import { AnimatedBlobs } from '@repo/ui/components/common/animated-blobs'
import { FullScreenConfetti } from '@repo/ui/components/common/full-screen-confetti'
import { Button } from '@repo/ui/components/shadcn/button'

export function AnimationsDemos() {
  const [directionKey, setDirectionKey] = useState(0)
  const [direction, setDirection] = useState<AnimationDirection>('forwards')
  const [showContent, setShowContent] = useState(true)
  const [showConfetti, setShowConfetti] = useState(false)
  const [animateInKey, setAnimateInKey] = useState(0)

  const toggleDirection = () => {
    setDirection((prev: AnimationDirection) => (prev === 'forwards' ? 'backwards' : 'forwards'))
    setDirectionKey(prev => prev + 1)
  }

  const toggleContent = () => {
    setShowContent(prev => !prev)
  }

  const triggerConfetti = () => {
    setShowConfetti(true)
    setTimeout(() => setShowConfetti(false), 3000)
  }

  const triggerAnimateIn = () => {
    setAnimateInKey(prev => prev + 1)
  }

  return (
    <div className="space-y-8">
      {showConfetti && <FullScreenConfetti recycle={false} numberOfPieces={200} gravity={0.3} />}

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Animate Direction</h3>
        <div className="flex items-center gap-4">
          <Button onClick={toggleDirection} variant="outline">
            Change Direction ({direction})
          </Button>
        </div>
        <div className="border rounded-md p-6 bg-muted/20 min-h-[100px] flex items-center justify-center">
          <AnimateDirection
            direction={direction}
            changeId={directionKey}
            displacementInPx={20}
            className="flex items-center gap-2"
          >
            <ArrowRightIcon className="size-4" />
            <span>This content animates {direction}</span>
          </AnimateDirection>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Animated Ellipsis</h3>
        <div className="border rounded-md p-6 bg-muted/20">
          <div className="flex items-center gap-2">
            <span>Loading</span>
            <AnimatedEllipsis />
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span>Processing your request</span>
            <AnimatedEllipsis className="text-blue-500" />
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Animate Height</h3>
        <div className="flex items-center gap-4">
          <Button onClick={toggleContent} variant="outline">
            {showContent ? 'Hide' : 'Show'} Content
          </Button>
        </div>
        <div className="border rounded-md bg-muted/20 overflow-hidden">
          <AnimateHeight>
            {showContent && (
              <div className="p-6">
                <h4 className="font-medium mb-2">Expandable Content</h4>
                <p className="text-sm text-muted-foreground mb-4">
                  This content animates its height when shown or hidden. The animation is smooth and
                  respects the actual content height.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-background rounded border">
                    <h5 className="font-medium text-sm">Feature 1</h5>
                    <p className="text-xs text-muted-foreground">Description here</p>
                  </div>
                  <div className="p-3 bg-background rounded border">
                    <h5 className="font-medium text-sm">Feature 2</h5>
                    <p className="text-xs text-muted-foreground">Description here</p>
                  </div>
                </div>
              </div>
            )}
          </AnimateHeight>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Animate In</h3>
        <div className="flex items-center gap-4">
          <Button onClick={triggerAnimateIn} variant="outline">
            <ArrowsClockwiseIcon className="size-4 mr-2" />
            Trigger Animation
          </Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AnimateIn
            key={`fade-${animateInKey}`}
            className="border rounded-md p-6 bg-muted/20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
          >
            <h4 className="font-medium mb-2">Fade In</h4>
            <p className="text-sm text-muted-foreground">This content fades in smoothly.</p>
          </AnimateIn>

          <AnimateIn
            key={`slide-${animateInKey}`}
            className="border rounded-md p-6 bg-muted/20"
            animateUp={true}
            transition={{ duration: 0.5, delay: 0.2 }}
          >
            <h4 className="font-medium mb-2">Slide Up</h4>
            <p className="text-sm text-muted-foreground">This content slides up from below.</p>
          </AnimateIn>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Animated Blobs</h3>
        <div className="relative border rounded-md h-32 bg-muted/20 overflow-hidden">
          <AnimatedBlobs opacity={0.6} />
          <div className="relative z-10 flex items-center justify-center h-full">
            <span className="text-sm font-medium">Content over animated background</span>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Full Screen Confetti</h3>
        <Button onClick={triggerConfetti} variant="outline">
          <PlayIcon className="size-4 mr-2" />
          Celebrate! 🎉
        </Button>
        <p className="text-sm text-muted-foreground">
          Click the button to trigger full-screen confetti animation.
        </p>
      </div>
    </div>
  )
}
