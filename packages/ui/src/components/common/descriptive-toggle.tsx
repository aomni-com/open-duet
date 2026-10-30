'use client'

import { CaretDown, Check } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'framer-motion'
import { type ButtonHTMLAttributes, type ReactNode } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'
import { type PropsWithClassName } from '@repo/ui/types/index'

const containerVariants = {
  primary: {
    boxShadow: '0 0 10px -1px rgba(147,51,234,0.2)',
    transition: { duration: 0.5, ease: 'easeInOut' },
  },
  secondary: {
    boxShadow: '0 0 0px 0px rgba(147,51,234,0)',
    transition: { duration: 0.3, ease: 'easeInOut' },
  },
}

const iconVariants = {
  initial: {
    opacity: 0,
    scale: 0.8,
    y: 10,
  },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.2 },
  },
  exit: {
    opacity: 0,
    scale: 0.8,
    y: -10,
    transition: { duration: 0.2 },
  },
}

export type ToggleOption<T extends string> = {
  value: T
  label: string
  description: string
  icon: ReactNode
  primary?: boolean
}

type DescriptiveToggleProps<T extends string> = PropsWithClassName<
  {
    onSelectMode: (mode: T) => void
    currentMode: T
    options: ToggleOption<T>[]
  } & ButtonHTMLAttributes<HTMLButtonElement>
>

export function DescriptiveToggle<T extends string>({
  onSelectMode,
  currentMode,
  options,
  className,
  ...props
}: DescriptiveToggleProps<T>) {
  const currentOption = options.find(option => option.value === currentMode)
  const isPrimaryMode = currentOption?.primary === true

  const handleModeSelect = (mode: T) => {
    return onSelectMode(mode)
  }

  return (
    <motion.div
      className={cn(
        'relative rounded-full w-fit py-[1px] px-[1.5px] transition-all',
        isPrimaryMode
          ? 'bg-gradient-to-r from-purple-500/90 via-blue-500/90 to-teal-500/90'
          : 'bg-border',
      )}
      variants={containerVariants}
      animate={isPrimaryMode ? 'primary' : 'secondary'}
      initial={false}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div className="relative">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={cn(
                'h-9 rounded-full gap-2 text-sm transition-all duration-300 outline-none bg-background/95',
                isPrimaryMode
                  ? 'backdrop-blur-sm text-primary font-semibold shadow-inner hover:bg-background/90 border-transparent disabled:opacity-80'
                  : 'border-border border-none',
                className,
              )}
              aria-pressed={isPrimaryMode}
              onClick={(e: React.MouseEvent) => e.preventDefault()}
              {...props}
            >
              <motion.div className="flex items-center justify-center w-4 h-4">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={`icon-${currentMode}`}
                    variants={iconVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {currentOption?.icon}
                  </motion.div>
                </AnimatePresence>
              </motion.div>

              <AnimatePresence mode="wait">
                <motion.span
                  key={`text-${currentMode}`}
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 5 }}
                  transition={{ duration: 0.2 }}
                  className="text-primary whitespace-nowrap"
                >
                  {currentOption?.label}
                </motion.span>
              </AnimatePresence>

              <CaretDown className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          {options.map((option: ToggleOption<T>) => (
            <DropdownMenuItem
              key={option.value}
              className={cn(
                'gap-1 cursor-pointer font-medium flex flex-col items-start',
                option.value === currentMode && 'bg-accent',
                option.value !== options[0]?.value && 'mt-1',
              )}
              onClick={() => handleModeSelect(option.value)}
            >
              <div className="flex w-full items-center">
                <span className="size-4 shrink-0">{option.icon}</span>
                <span className="ml-2 text-sm">{option.label}</span>
                {option.value === currentMode && <Check className="h-4 w-4 ml-auto shrink-0" />}
              </div>

              <p className="text-sm font-normal text-muted-foreground ml-6">{option.description}</p>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </motion.div>
  )
}
