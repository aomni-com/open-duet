'use client'

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { cn } from '@repo/ui/lib/utils'

interface UseTextareaAutosizeProps {
  textAreaRef: HTMLTextAreaElement | null
  minHeight?: number
  maxHeight?: number
  triggerAutoSize: string
}

const useTextareaAutosize = ({
  textAreaRef,
  triggerAutoSize,
  maxHeight = Number.MAX_SAFE_INTEGER,
  minHeight = 0,
}: UseTextareaAutosizeProps) => {
  const [init, setInit] = useState(true)

  useLayoutEffect(() => {
    if (!textAreaRef) {
      return
    }

    // We need to reset the height momentarily to get the correct scrollHeight for the textarea
    const offsetBorder = 2

    if (init) {
      textAreaRef.style.minHeight = `${minHeight + offsetBorder}px`
      if (maxHeight > minHeight) {
        textAreaRef.style.maxHeight = `${maxHeight}px`
      }
      setInit(false)
    }
    textAreaRef.style.height = `${minHeight + offsetBorder}px`
    const scrollHeight = textAreaRef.scrollHeight
    // We then set the height directly, outside of the render loop
    // Trying to set this with state or a ref will product an incorrect value.
    if (scrollHeight > maxHeight) {
      textAreaRef.style.height = `${maxHeight}px`
    } else {
      textAreaRef.style.height = `${scrollHeight + offsetBorder}px`
    }
  }, [textAreaRef, triggerAutoSize, init, maxHeight, minHeight])
}

export type TextareaAutosizeRef = {
  focus: () => void
  resetHeight: () => void
  textArea: HTMLTextAreaElement
  maxHeight: number
  minHeight: number
}

type TextareaAutosizeProps = {
  maxHeight?: number
  minHeight?: number
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>

export const TextareaAutosize = forwardRef<TextareaAutosizeRef, TextareaAutosizeProps>(
  (
    {
      maxHeight = Number.MAX_SAFE_INTEGER,
      minHeight = 40,
      className,
      onChange,
      value,
      ...props
    }: TextareaAutosizeProps,
    ref: React.Ref<TextareaAutosizeRef>,
  ) => {
    const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
    const [triggerAutoSize, setTriggerAutoSize] = useState('')

    useTextareaAutosize({
      textAreaRef: textAreaRef.current,
      triggerAutoSize: triggerAutoSize,
      maxHeight,
      minHeight,
    })

    useImperativeHandle(ref, () => ({
      textArea: textAreaRef.current as HTMLTextAreaElement,
      maxHeight,
      minHeight,
      focus: () => {
        textAreaRef.current?.focus()
      },
      resetHeight: () => {
        setTriggerAutoSize('')
      },
      set value(newValue: string) {
        if (textAreaRef.current) {
          textAreaRef.current.value = newValue
          setTriggerAutoSize(newValue)
        }
      },
      get value() {
        return textAreaRef.current?.value || ''
      },
    }))

    useEffect(() => {
      if (value !== undefined) {
        setTriggerAutoSize(String(value))
      }
    }, [value])

    return (
      <textarea
        {...props}
        value={value}
        ref={textAreaRef}
        className={cn(
          'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0  disabled:cursor-not-allowed disabled:opacity-50',
          // set the height directly so the textarea renders correctly on first render
          // useAutosizeTextArea will then handle UI updates via the textarea ref.
          `min-h-[${minHeight}px] max-h-[${maxHeight}px] h-[${minHeight}px]`,
          className,
        )}
        onChange={e => {
          setTriggerAutoSize(e.target.value)
          onChange?.(e)
        }}
      />
    )
  },
)

TextareaAutosize.displayName = 'TextareaAutosize'
