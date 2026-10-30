'use client'

import { CaretDown } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from '@repo/ui/components/shadcn/command'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/shadcn/popover'

type AutocompleteProps = {
  selectedFieldId?: string
  list: { id: string; name: string; label?: string }[]
  onChange: (key?: string) => void
  className?: string
}

export function Autocomplete({ selectedFieldId, list, onChange, className }: AutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false)
  const selectedField = list.find(f => f.id === selectedFieldId)

  useEffect(() => {
    if (isOpen && selectedField?.id) {
      setTimeout(() => {
        const element = document.getElementById(`command-item-${selectedField?.id}`)
        if (element) {
          element.scrollIntoView({ behavior: 'instant', block: 'nearest' })
        }
      }, 100)
    }
  }, [isOpen, selectedField?.id])

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className={`h-[60px] w-full justify-between sm:w-[300px] ${className}`}
        >
          {selectedField ? (
            <div className="flex flex-col items-start">
              <div>{selectedField.name}</div>
              <div className="text-xs text-muted-foreground">{selectedField.label || ''}</div>
            </div>
          ) : (
            'Select field...'
          )}
          <CaretDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0 sm:w-[300px]">
        <Command
          filter={(value, search) => {
            if (value.includes(search.toLowerCase())) return 1
            const item = list.find(field => field.id === value)
            if (item && item.name.toLowerCase().includes(search.toLowerCase())) return 1
            return 0
          }}
        >
          <CommandInput placeholder="Search custom fields..." />
          <CommandEmpty>No custom field found.</CommandEmpty>
          <CommandGroup className="max-h-[200px] overflow-y-auto">
            <CommandItem
              key="none"
              onSelect={() => {
                onChange(undefined)
                setIsOpen(false)
              }}
            >
              None
            </CommandItem>
            {list.map(field => (
              <CommandItem
                value={field.id}
                key={field.id}
                className={field.id === selectedField?.id ? 'bg-accent' : ''}
                onSelect={() => {
                  onChange(field.id)
                  setIsOpen(false)
                }}
              >
                <div id={`command-item-${field.id}`} className="flex flex-col">
                  <div className="flex items-center">
                    {field.name}
                    {field.id === selectedField?.id && (
                      <span className="ml-2 text-sm text-muted-foreground">(Selected)</span>
                    )}
                  </div>
                  <span className="text-sm text-muted-foreground">{field.label || ''}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
