'use client'

import { Moon, Sun } from '@phosphor-icons/react'
import { useTheme } from 'next-themes'
import { useCallback } from 'react'

import { Button, type ButtonProps } from '@repo/ui/components/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'

type Props = {
  showLabel?: boolean
  onOpenChange?: (open: boolean) => void
} & ButtonProps

export function ThemeToggle({ className, showLabel = false, onOpenChange, ...props }: Props) {
  const { setTheme } = useTheme()

  const set = useCallback(
    (theme: string) => () => {
      setTheme(theme)
    },
    [setTheme],
  )

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Toggle theme"
          variant="outline"
          className={cn(
            'relative flex flex-row gap-2 focus-visible:ring-0',
            showLabel && 'w-full justify-start pl-2',
            className,
          )}
          size="icon"
          {...props}
        >
          <Sun className="size-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute size-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          {showLabel ? <span>Theme</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={set('light')}>Light</DropdownMenuItem>
        <DropdownMenuItem onClick={set('dark')}>Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={set('system')}>System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
