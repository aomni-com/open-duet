'use client'

import { Check, Gear, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../shadcn/button'
import { Input } from '../shadcn/input'
import { Textarea } from '../shadcn/textarea'

interface InlineEditTextProps {
  value: string
  onSave: (value: string) => void
  onCancel?: () => void
  placeholder?: string
  multiline?: boolean
  required?: boolean
  maxLength?: number
  className?: string
  editClassName?: string
  displayClassName?: string
  emptyText?: string
  validation?: (value: string) => string | null
  autoFocus?: boolean
}

export function InlineEditText({
  value,
  onSave,
  onCancel,
  placeholder = 'Enter text...',
  multiline = false,
  required = false,
  maxLength,
  className = '',
  editClassName = '',
  displayClassName = '',
  emptyText = 'Click to add',
  validation,
  autoFocus = true,
}: InlineEditTextProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  // Reset edit value when value prop changes
  useEffect(() => {
    setEditValue(value)
  }, [value])

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current && autoFocus) {
      inputRef.current.focus()
      if (!multiline) {
        inputRef.current.select()
      }
    }
  }, [isEditing, autoFocus, multiline])

  const validateValue = (val: string): boolean => {
    setError(null)

    if (required && !val.trim()) {
      setError('This field is required')
      return false
    }

    if (maxLength && val.length > maxLength) {
      setError(`Maximum ${maxLength} characters allowed`)
      return false
    }

    if (validation) {
      const validationError = validation(val)
      if (validationError) {
        setError(validationError)
        return false
      }
    }

    return true
  }

  const handleStartEdit = () => {
    setIsEditing(true)
    setEditValue(value)
    setError(null)
  }

  const handleSave = () => {
    const trimmedValue = editValue.trim()

    if (!validateValue(trimmedValue)) {
      return
    }

    onSave(trimmedValue)
    setIsEditing(false)
    setError(null)
  }

  const handleCancel = () => {
    setEditValue(value)
    setIsEditing(false)
    setError(null)
    onCancel?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Enter' && multiline && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const newValue = e.target.value
    setEditValue(newValue)

    // Clear error on change if value becomes valid
    if (error) {
      validateValue(newValue)
    }
  }

  if (isEditing) {
    const InputComponent = multiline ? Textarea : Input

    return (
      <div className={`space-y-2 ${className}`}>
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <InputComponent
              ref={inputRef as React.RefObject<HTMLInputElement & HTMLTextAreaElement>}
              value={editValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              maxLength={maxLength}
              className={`text-sm ${editClassName} ${error ? 'border-destructive focus-visible:ring-destructive' : ''}`}
              {...(multiline && {
                rows: 3,
                className: `text-sm resize-none ${editClassName} ${error ? 'border-destructive focus-visible:ring-destructive' : ''}`,
              })}
            />
            {error && <p className="text-xs text-destructive mt-1">{error}</p>}
            {maxLength && (
              <p className="text-xs text-muted-foreground mt-1">
                {editValue.length}/{maxLength}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSave}
              disabled={!!error}
              className="h-8 w-8 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
            >
              <Check className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCancel}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {multiline && (
          <p className="text-xs text-muted-foreground">
            Press Cmd/Ctrl + Enter to save, Escape to cancel
          </p>
        )}
      </div>
    )
  }

  const isEmpty = !value || value.trim() === ''
  const displayValue = isEmpty ? emptyText : value

  return (
    <div
      className={`group cursor-pointer hover:bg-muted/50 rounded-md transition-colors ${className}`}
      onClick={handleStartEdit}
    >
      <div className={`flex items-center justify-between p-2 ${displayClassName}`}>
        <div className="flex-1">
          <p
            className={`text-sm whitespace-break-spaces ${isEmpty ? 'text-muted-foreground italic' : ''}`}
          >
            {displayValue}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          /* Visible on touch, revealed on hover. A field whose only edit
             affordance is a hover state is a field a phone cannot discover. */
          className="h-9 w-9 md:h-6 md:w-6 p-0 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
          onClick={e => {
            e.stopPropagation()
            handleStartEdit()
          }}
        >
          <Gear className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
