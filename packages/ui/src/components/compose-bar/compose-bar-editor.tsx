'use client'

import './compose-bar-editor.css'

import { Extension } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ForwardedRef,
} from 'react'

import { cn } from '@repo/ui/lib/utils'

import { agentTrigger } from './compose-bar-agent-trigger'
import { createMentionExtensions, type ComposeBarSuggestion } from './compose-bar-mention-extension'
import { skillTrigger } from './compose-bar-skill-trigger'
import { createComposeOverflowFileName, shouldAttachPastedText } from './compose-text-overflow'
import type { ComposeBarAgents, ComposeBarSkills } from './types'

export type ComposeBarEditorHandle = {
  focus: () => void
}

type ComposeBarEditorProps = {
  id: string
  label: string
  value: string
  onValueChange: (value: string) => void
  skills?: ComposeBarSkills
  agents?: ComposeBarAgents
  onSuggestionChange?: (suggestion: ComposeBarSuggestion | null) => void
  onSubmit: () => void
  onFilesSelected?: (files: readonly File[]) => boolean | void
  onKeyDown?: (event: KeyboardEvent) => void
  placeholder?: string
  autoFocus?: boolean
  autoCapitalize?: string
  spellCheck?: boolean
  disabled: boolean
  readOnly: boolean
  submitOnEnter: boolean
  minHeight?: number
  /**
   * A pixel ceiling on the draft, for a host that has no height of its own to
   * measure a share against — a standalone demo, or a bar floating on a page.
   *
   * Absent is the ordinary case inside a conversation, and it means *the host
   * owns the ceiling*: the row this editor sits in is the compose surface's one
   * squeeze row, so a shell that caps its own footer caps the draft through it
   * and the draft scrolls. A number here would silently win that argument at
   * whichever height it was written for.
   */
  maxHeight?: number
  className?: string
}

function ComposeBarEditorImpl(
  {
    id,
    label,
    value,
    onValueChange,
    skills,
    agents,
    onSuggestionChange,
    onSubmit,
    onFilesSelected,
    onKeyDown,
    placeholder = '',
    autoFocus = false,
    autoCapitalize,
    spellCheck = true,
    disabled,
    readOnly,
    submitOnEnter,
    minHeight,
    maxHeight,
    className,
  }: ComposeBarEditorProps,
  forwardedRef: ForwardedRef<ComposeBarEditorHandle>,
) {
  const valueChangeRef = useRef(onValueChange)
  // The editor is built once; the lists load later. Reading them through refs
  // at suggestion time is what lets a list that arrives mid-draft still appear.
  const skillsRef = useRef(skills)
  const agentsRef = useRef(agents)
  const suggestionChangeRef = useRef(onSuggestionChange)
  const pickerHasRowsRef = useRef(false)
  const submitRef = useRef(onSubmit)
  const filesSelectedRef = useRef(onFilesSelected)
  const keyDownRef = useRef(onKeyDown)
  const placeholderRef = useRef(placeholder)
  const submitOnEnterRef = useRef(submitOnEnter)
  valueChangeRef.current = onValueChange
  skillsRef.current = skills
  agentsRef.current = agents
  suggestionChangeRef.current = onSuggestionChange
  submitRef.current = onSubmit
  filesSelectedRef.current = onFilesSelected
  keyDownRef.current = onKeyDown
  placeholderRef.current = placeholder
  submitOnEnterRef.current = submitOnEnter

  const shortcuts = useMemo(
    () =>
      Extension.create({
        name: 'composeBarShortcuts',
        priority: 1_000,
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              // A picker with rows to offer owns Enter: it means "insert the
              // highlighted item", never "send". Declining here lets the key
              // fall through to the suggestion plugin, which sits below these
              // shortcuts. A picker showing only a message — an empty roster,
              // or one it could not read — has nothing to insert, so it does
              // not take the key: standing down there would swallow Enter into
              // a line break and leave the message unsent.
              if (pickerHasRowsRef.current) return false
              if (!submitOnEnterRef.current || this.editor.view.composing) return false
              submitRef.current()
              return true
            },
            'Shift-Enter': () => this.editor.commands.splitBlock(),
          }
        },
      }),
    [],
  )

  // Built once, from refs: the triggers must outlive every re-render, because
  // rebuilding the editor to deliver a new item list would destroy the draft.
  const mentions = useMemo(
    () =>
      createMentionExtensions({
        triggers: [skillTrigger(() => skillsRef.current), agentTrigger(() => agentsRef.current)],
        onSuggestionChange: suggestion => {
          pickerHasRowsRef.current = suggestion !== null && suggestion.items.length > 0
          suggestionChangeRef.current?.(suggestion)
        },
      }),
    [],
  )

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    extensions: [
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: true,
        },
      }),
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          defaultProtocol: 'https',
        },
      }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      ...mentions,
      shortcuts,
    ],
    content: value,
    contentType: 'markdown',
    editable: !disabled && !readOnly,
    editorProps: {
      attributes: {
        id,
        'aria-label': label,
        'aria-disabled': disabled ? 'true' : 'false',
        'aria-readonly': readOnly ? 'true' : 'false',
        'data-compose-bar-editor': '',
        enterkeyhint: 'send',
        autocapitalize: autoCapitalize ?? 'sentences',
        spellcheck: spellCheck ? 'true' : 'false',
        class: cn(
          'min-h-12 w-full overflow-y-auto bg-transparent px-2 pb-0 pt-3 text-sm leading-5 outline-none sm:min-h-10 sm:px-1.5 sm:pt-2',
          className,
        ),
      },
      handleKeyDown: (_view, event) => {
        keyDownRef.current?.(event)
        return event.defaultPrevented
      },
      handlePaste: (view, event) => {
        if (filesSelectedRef.current === undefined) return false
        const pastedText = event.clipboardData?.getData('text/plain') ?? ''
        /* A screenshot or a batch of copied files takes the same path a picked
           or dropped one does — the clipboard is just a third way to choose
           them. Text alongside the files still pastes as text, so copying a
           rich document does not lose its words to its images. */
        const pastedFiles = Array.from(event.clipboardData?.files ?? [])
        if (pastedFiles.length > 0) {
          const acceptedFiles = filesSelectedRef.current(pastedFiles)
          if (acceptedFiles !== false && pastedText.length === 0) {
            event.preventDefault()
            return true
          }
        }
        if (
          !shouldAttachPastedText({
            currentTextLength: view.state.doc.textContent.length,
            pastedTextLength: pastedText.length,
          })
        )
          return false
        const accepted = filesSelectedRef.current([
          new File([pastedText], createComposeOverflowFileName(), { type: 'text/plain' }),
        ])
        if (accepted === false) return false
        event.preventDefault()
        return true
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      valueChangeRef.current(currentEditor.getMarkdown())
    },
  })

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => editor?.commands.focus('end'),
    }),
    [editor],
  )

  useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled && !readOnly)
  }, [disabled, editor, readOnly])

  useEffect(() => {
    if (!editor) return
    if (value.length === 0) {
      if (!editor.isEmpty) editor.commands.clearContent(false)
      return
    }
    if (editor.getMarkdown() === value) return
    editor.commands.setContent(value, { emitUpdate: false, contentType: 'markdown' })
  }, [editor, value])

  useEffect(() => {
    if (!autoFocus || !editor) return
    const frame = requestAnimationFrame(() => editor.commands.focus('end'))
    return () => cancelAnimationFrame(frame)
  }, [autoFocus, editor])

  return (
    <EditorContent
      editor={editor}
      className={cn('w-full', disabled && 'cursor-not-allowed opacity-60')}
      style={{ minHeight, maxHeight }}
    />
  )
}

export const ComposeBarEditor = forwardRef(ComposeBarEditorImpl)
ComposeBarEditor.displayName = 'ComposeBarEditor'
