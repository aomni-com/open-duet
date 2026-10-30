'use client'

import { CaretDown } from '@phosphor-icons/react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { cn } from '@repo/ui/lib/utils'

import type { ComposeBarPicker } from './types'

function selectedOption<Id extends string>(picker: ComposeBarPicker<Id>) {
  return picker.options.find(option => option.id === picker.value)
}

export function ComposeBarPickerControl<Id extends string>({
  picker,
  disabled,
}: {
  picker: ComposeBarPicker<Id>
  disabled: boolean
}) {
  const selected = selectedOption(picker)
  const resolvedLabel = selected?.label ?? picker.value
  const resolvedIcon = selected?.icon ?? picker.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${picker.label}: ${resolvedLabel}`}
          disabled={disabled || picker.disabled}
          className={cn(
            'flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-colors',
            'hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {resolvedIcon ? (
            <span className="shrink-0 [&_svg]:size-3.5" aria-hidden>
              {resolvedIcon}
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {picker.label}: {resolvedLabel}
          </span>
          <CaretDown className="size-3 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={picker.value}
          onValueChange={value => {
            const option = picker.options.find(candidate => candidate.id === value)
            if (option) picker.onValueChange(option.id)
          }}
        >
          {picker.options.map(option => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              disabled={option.disabled}
              className="cursor-pointer"
            >
              {option.icon ? (
                <span className="mt-0.5 size-5 shrink-0 [&_svg]:size-4" aria-hidden>
                  {option.icon}
                </span>
              ) : null}
              <span className="flex min-w-0 w-full flex-col gap-0.5">
                <span className="block font-medium">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
