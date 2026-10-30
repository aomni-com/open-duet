'use client'

import { type Icon } from '@phosphor-icons/react'
import { createElement } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/components/shadcn/card'
import { Checkbox } from '@repo/ui/components/shadcn/checkbox'
import { cn } from '@repo/ui/lib/utils'

type Props = {
  isSelected: boolean
  onCardClick: () => void
  title: string
  icon: Icon
  description: string
  className?: string
}

export function ButtonCard({
  isSelected,
  onCardClick,
  title,
  icon,
  description,
  className,
}: Props) {
  return (
    <Card
      className={cn(
        'relative flex-1 cursor-pointer overflow-hidden border-2 transition-all hover:shadow-lg',
        isSelected ? 'border-primary' : 'border-muted hover:border-primary/20',
        className,
      )}
      onClick={onCardClick}
    >
      {createElement(icon, {
        className:
          'absolute bottom-0 translate-x-1/4 translate-y-1/4 right-0 size-11/12 w-fit text-primary opacity-10',
      })}

      <CardHeader className="relative z-10 pb-2">
        <CardTitle className="flex items-center space-x-3">
          <Checkbox id="ai-decide" checked={isSelected} onCheckedChange={onCardClick} />
          <label htmlFor="ai-decide" className="cursor-pointer text-lg font-bold">
            {title}
          </label>
        </CardTitle>
      </CardHeader>
      <CardContent className="relative z-10">
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}
