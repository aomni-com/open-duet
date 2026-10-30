'use client'

import { CaretDown, CircleNotch } from '@phosphor-icons/react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Command as CommandPrimitive } from 'cmdk'
import { useRef, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@repo/ui/components/shadcn/command'
import { Input } from '@repo/ui/components/shadcn/input'
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from '@repo/ui/components/shadcn/popover'
import { cn } from '@repo/ui/lib/utils'

type Props<T> = {
  /** This function return selected option as form of one item inside options like options[0]
   */
  onSelectedValueChange: (value: T) => void

  /** This is the value that is typed in the input field. It is used to filter the options.
   */

  searchValue?: string

  /**
   * This function is called when the user types in the input field. It is used to filter the options.
   * It is useful when you want to fetch the options from the server based on the search query.
   */
  onSearchValueChange?: (value: string) => void
  /**
   * Any array is acceptable but make sure to provide getOptionLabel for retuning label from array item
   * and getOptionValue for equality check of two option getOptionValue should return unique string across array
   */
  options: T[]

  /**
   * This function is called to get the label of the option. It is used to display the options in the dropdown.
   */
  getOptionLabel: (value: T) => string

  /**
   * This function is called to get the value of the option. It is used to compare the selected value with the options.
   * Make sure that the value is unique for each option. "id" is a good candidate for this.
   */
  getOptionValue: (value: T) => string
  isLoading?: boolean
  loadingMessage?: string
  emptySearchValueMessage?: string
  noMatchesMessage?: string
  placeholder?: string

  /**
   * This function is called when the user scrolls to the bottom of the list.
   */
  loadMore?: () => void

  /**
   * If you set it to true, it will show the loading spinner at the bottom of the list. it is usefull for paginated lists.
   */
  isLoadingMore?: boolean

  /**
   * If you set it to false, you must conditionally render valid options based on the search query yourself.
   */
  shouldFilter?: boolean
  filterFunction?: (value: T, searchValue: string) => boolean
}

export function AutoCompleteInput<T>({
  onSelectedValueChange,
  searchValue = '',
  onSearchValueChange,
  options,
  isLoading,
  loadingMessage = 'Loading',
  emptySearchValueMessage = 'No items.',
  noMatchesMessage = 'No items matched your search.',
  placeholder = 'Search...',
  loadMore,
  isLoadingMore,
  getOptionLabel,
  getOptionValue,
  shouldFilter = true,
  filterFunction,
}: Props<T>) {
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Filter options manually if shouldFilter is true
  const filteredOptions = shouldFilter
    ? options.filter(option =>
        getOptionLabel(option).toLowerCase().includes(searchValue.toLowerCase()),
      )
    : options

  function reset() {
    onSearchValueChange?.('')
    onSelectedValueChange('' as T)
  }

  const onSelectItem = (inputValue: string) => {
    const newSelectedValue = options.find(option => getOptionValue(option) === inputValue)

    if (!newSelectedValue) {
      console.error('Item was not found in options')
      return
    }

    onSelectedValueChange(newSelectedValue)
    reset()
    setOpen(false)
  }

  // loadMore function is called when the user scrolls to the bottom of the list
  function onScroll(event: React.SyntheticEvent) {
    const listboxNode = event.currentTarget as HTMLElement
    if (Math.round(listboxNode.scrollTop + listboxNode.clientHeight) === listboxNode.scrollHeight) {
      loadMore?.()
    }
  }

  function handleOpenChange(open: boolean) {
    setOpen(open)
  }

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={handleOpenChange} modal>
        <Command
          shouldFilter={false}
          onKeyDown={onScroll}
          {...(filterFunction && { filterFunction })}
        >
          <PopoverPrimitive.Anchor>
            <div className="relative">
              <PopoverTrigger asChild onClick={() => setOpen(true)}>
                <CommandPrimitive.Input
                  asChild
                  value={searchValue}
                  onKeyDown={e => setOpen(e.key !== 'Escape')}
                  onValueChange={value => onSearchValueChange?.(value)}
                >
                  <Input placeholder={placeholder} className="pr-20" ref={inputRef} />
                </CommandPrimitive.Input>
              </PopoverTrigger>
              <div className="absolute right-2 top-0 bottom-0 max-w-20 flex gap-2 overflow-hidden items-center h-full">
                <PopoverTrigger asChild>
                  <Button
                    className="rounded-full h-6 w-6"
                    variant={'ghost'}
                    size={'icon'}
                    onClick={() => inputRef.current?.focus()}
                    onKeyDown={e => {
                      inputRef.current?.focus()
                      setOpen(e.key !== 'Escape')
                    }}
                  >
                    <CaretDown className={cn('h-4 w-4', open ? 'transform rotate-180' : '')} />
                  </Button>
                </PopoverTrigger>
              </div>
            </div>
          </PopoverPrimitive.Anchor>
          {!open && <CommandList aria-hidden="true" className="hidden" />}
          <PopoverPortal>
            <PopoverContent
              asChild
              onOpenAutoFocus={e => e.preventDefault()}
              onInteractOutside={e => {
                if (e.target instanceof Element && e.target.hasAttribute('cmdk-input')) {
                  e.preventDefault()
                }
              }}
              className="w-[--radix-popover-trigger-width] p-0"
            >
              {open && (
                <CommandList onScroll={onScroll}>
                  {isLoading ? (
                    <CommandPrimitive.Loading>
                      <div className="flex justify-center items-center p-4 gap-2">
                        <CircleNotch className="size-4 animate-spin" />
                        <span>{loadingMessage}...</span>
                      </div>
                    </CommandPrimitive.Loading>
                  ) : null}

                  {filteredOptions.length === 0 && !isLoading ? (
                    <CommandEmpty>
                      {searchValue.length > 0 ? noMatchesMessage : emptySearchValueMessage}
                    </CommandEmpty>
                  ) : null}

                  <CommandGroup>
                    {filteredOptions.map(option => (
                      <CommandItem
                        key={getOptionValue(option)}
                        value={getOptionValue(option)}
                        onMouseDown={e => e.preventDefault()}
                        onSelect={onSelectItem}
                        className="flex items-center justify-between"
                      >
                        <span>{getOptionLabel(option)}</span>
                      </CommandItem>
                    ))}

                    {isLoadingMore ? (
                      <CommandItem className="flex justify-center" disabled>
                        <CircleNotch className="size-4 animate-spin" />
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                </CommandList>
              )}
            </PopoverContent>
          </PopoverPortal>
        </Command>
      </Popover>
    </div>
  )
}
