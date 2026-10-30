'use client'

import { CircleNotch, LockSimple, Paperclip, PaperPlaneTilt } from '@phosphor-icons/react'
import { motion, useReducedMotion } from 'framer-motion'
import { useTheme } from 'next-themes'
import {
  forwardRef,
  useId,
  useCallback,
  useImperativeHandle,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ForwardedRef,
  type FormEvent,
  type ReactElement,
  type RefAttributes,
} from 'react'

import { SiriOrb } from '@repo/ui/components/21dev/siri-orb'
import { Button } from '@repo/ui/components/shadcn/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/components/shadcn/tooltip'
import { cn } from '@repo/ui/lib/utils'

import { QualitySelector } from '../quality-selector'
import { AGENT_TRIGGER_NODE } from './compose-bar-agent-trigger'
import { ComposeBarAttachmentCard } from './compose-bar-attachment'
import { ComposeBarEditor, type ComposeBarEditorHandle } from './compose-bar-editor'
import type { ComposeBarSuggestion } from './compose-bar-mention-extension'
import { ComposeBarMentionPicker } from './compose-bar-mention-picker'
import { ComposeBarPickerControl } from './compose-bar-picker'
import { ComposeBarSessionPanel } from './compose-bar-session'
import type { ComposeBarHandle, ComposeBarProps } from './types'

const AI_ORB_COLORS = {
  light: {
    c1: 'oklch(60% 0.19 245)',
    c2: 'oklch(70% 0.13 210)',
    c3: 'oklch(54% 0.16 278)',
  },
  dark: {
    c1: 'oklch(72% 0.19 245)',
    c2: 'oklch(80% 0.13 210)',
    c3: 'oklch(72% 0.15 280)',
  },
} as const

function ComposeBarImpl<QualityId extends string, ReasoningId extends string>(
  {
    value,
    onValueChange,
    onSubmit,
    input,
    disabled = false,
    submitting = false,
    submit: submitConfig,
    quality,
    reasoning,
    session,
    skills,
    agents,
    aiToggle,
    attachments: attachmentConfig,
    actions = [],
    status,
    submitAccessory,
    banner,
    classNames,
  }: ComposeBarProps<QualityId, ReasoningId>,
  forwardedRef: ForwardedRef<ComposeBarHandle>,
) {
  const {
    label: inputLabel,
    id,
    variant: inputVariant = 'default',
    minHeight,
    maxHeight,
    onKeyDown,
    readOnly = false,
    ...editorInput
  } = input
  const attachments = attachmentConfig?.items ?? []
  const { resolvedTheme } = useTheme()
  const onFilesSelected = attachmentConfig?.onFilesSelected
  const fileInput = attachmentConfig?.fileInput
  const submitLabel = submitConfig?.label ?? 'Send message'
  const submittingLabel = submitConfig?.submittingLabel ?? 'Sending message'
  const generatedInputId = useId()
  const inputId = id ?? generatedInputId
  const fileInputRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const sessionViewportRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ComposeBarEditorHandle>(null)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [suggestion, setSuggestion] = useState<ComposeBarSuggestion | null>(null)
  const [chromeMinHeight, setChromeMinHeight] = useState(0)
  const [sessionOverflows, setSessionOverflows] = useState(false)
  const [sessionHasMoreBelow, setSessionHasMoreBelow] = useState(false)
  // Whichever trigger is open owns the picker's words and its loading and
  // unreachable states. Reading them off a single capability would show the
  // skills wording above a list of agents.
  const openCapability =
    suggestion === null ? undefined : suggestion.trigger === AGENT_TRIGGER_NODE ? agents : skills
  // A send in flight holds Send and nothing else. The draft, attachments and
  // pickers are where the next message is already being written; freezing
  // them while a request travels is the stall chat surfaces must not have.
  const interactionDisabled = disabled
  const reducedMotion = useReducedMotion() ?? false
  // Keep the last session through the collapse so the panel doesn't empty
  // before the hide animation finishes.
  const lastSessionRef = useRef<typeof session>(undefined)
  if (session) lastSessionRef.current = session
  const panelSession = session ?? lastSessionRef.current
  const hasSubmitContent = value.trim().length > 0 || attachments.length > 0
  const submitBlocked = submitConfig?.blocked === true
  const submitEnabled =
    !disabled && !submitting && !submitBlocked && (submitConfig?.enabled ?? hasSubmitContent)
  const submitTooltip = submitting
    ? (submitConfig?.submittingTooltip ?? submittingLabel)
    : submitBlocked
      ? (submitConfig?.blockedTooltip ?? submitLabel)
      : submitEnabled
        ? (submitConfig?.tooltip ?? submitLabel)
        : (submitConfig?.disabledTooltip ?? 'Write a message or attach a file first.')
  const hasQualityChrome = Boolean(quality)
  const hasBannerChrome = Boolean(banner)
  const hasAttachmentChrome = attachments.length > 0

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent) => {
      onKeyDown?.(event)
      if (
        event.defaultPrevented ||
        event.key !== 'Tab' ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.repeat ||
        interactionDisabled ||
        aiToggle === undefined ||
        aiToggle.disabled === true
      )
        return

      event.preventDefault()
      aiToggle.onEnabledChange(!aiToggle.enabled)
    },
    [aiToggle, interactionDisabled, onKeyDown],
  )

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: () => editorRef.current?.focus(),
    }),
    [],
  )

  const submit = () => {
    if (!submitEnabled) return
    onSubmit({
      value,
      qualityId: quality?.value,
      reasoningId: reasoning?.value,
      attachments,
    })
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submit()
  }

  const handleFiles = useCallback(
    (files: FileList | readonly File[]) => {
      if (!onFilesSelected || interactionDisabled) return false
      const selectedFiles = Array.from(files)
      return selectedFiles.length > 0 ? onFilesSelected(selectedFiles) : false
    },
    [interactionDisabled, onFilesSelected],
  )

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer !== null &&
      (Array.from(event.dataTransfer.types).includes('Files') ||
        Array.from(event.dataTransfer.items).some(item => item.kind === 'file'))
    const overFilesDropzone = (event: DragEvent) =>
      (event.target as Element | null)?.closest?.('[data-files-dropzone]') !== null
    const visible = () =>
      rootRef.current !== null &&
      rootRef.current.closest('[aria-hidden="true"]') === null &&
      rootRef.current.getClientRects().length > 0
    const dragEnter = (event: DragEvent) => {
      if (!hasFiles(event) || overFilesDropzone(event)) return
      event.preventDefault()
    }
    const dragOver = (event: DragEvent) => {
      if (!hasFiles(event) || overFilesDropzone(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const drop = (event: DragEvent) => {
      if (overFilesDropzone(event)) return
      if (!hasFiles(event)) return
      if (!visible() || interactionDisabled || onFilesSelected === undefined) return
      if (event.defaultPrevented) return
      event.preventDefault()
      handleFiles(event.dataTransfer?.files ?? [])
      editorRef.current?.focus()
    }
    document.addEventListener('dragenter', dragEnter)
    document.addEventListener('dragover', dragOver)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragenter', dragEnter)
      document.removeEventListener('dragover', dragOver)
      document.removeEventListener('drop', drop)
    }
  }, [handleFiles, interactionDisabled, onFilesSelected])

  /* Flexbox cannot derive "everything except the editor" as an automatic
     minimum. Measure the optional chrome rows and one editable line so banners,
     attachments, controls, and the caret can never overlap. The editor still
     owns every remaining pixel and scrolls long drafts inside that row. */
  useLayoutEffect(() => {
    const form = formRef.current
    if (!form) return
    const chrome = Array.from(form.querySelectorAll<HTMLElement>('[data-compose-chrome]'))
    const update = () => {
      const style = getComputedStyle(form)
      const borderHeight =
        Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
      const editor = form.querySelector<HTMLElement>('[data-compose-bar-editor]')
      const editorRow = editor?.closest<HTMLElement>('[data-compose-bar-editor-scroll]')
      const editorMinHeight =
        editor === null ? 0 : Number.parseFloat(getComputedStyle(editor).minHeight)
      const editorRowStyle =
        editorRow === null || editorRow === undefined ? undefined : getComputedStyle(editorRow)
      const editorRowPadding =
        editorRowStyle === undefined
          ? 0
          : Number.parseFloat(editorRowStyle.paddingTop) +
            Number.parseFloat(editorRowStyle.paddingBottom)
      setChromeMinHeight(
        Math.ceil(
          chrome.reduce((height, element) => height + element.offsetHeight, borderHeight) +
            editorMinHeight +
            editorRowPadding,
        ),
      )
    }
    const observer = new ResizeObserver(update)
    chrome.forEach(element => observer.observe(element))
    update()
    return () => observer.disconnect()
  }, [hasAttachmentChrome, hasBannerChrome, hasQualityChrome])

  useLayoutEffect(() => {
    const viewport = sessionViewportRef.current
    if (!viewport) return
    const update = () => {
      const overflows = viewport.scrollHeight - viewport.clientHeight > 1
      const moreBelow = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1
      setSessionOverflows(current => (current === overflows ? current : overflows))
      setSessionHasMoreBelow(current => (current === moreBelow ? current : moreBelow))
    }
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    if (viewport.firstElementChild instanceof HTMLElement) {
      observer.observe(viewport.firstElementChild)
    }
    viewport.addEventListener('scroll', update, { passive: true })
    update()
    return () => {
      observer.disconnect()
      viewport.removeEventListener('scroll', update)
    }
  }, [session?.key, session?.phase])

  return (
    <div
      ref={rootRef}
      data-compose-bar-root
      className={cn('relative flex min-h-0 w-full min-w-0 flex-col', classNames?.root)}
    >
      {/* Outside the form on purpose: the compose surface clips its overflow,
          so a picker rendered inside it would be cut off at the top edge. */}
      {openCapability && suggestion ? (
        <ComposeBarMentionPicker
          suggestion={suggestion}
          labels={openCapability.labels}
          loading={openCapability.loading === true}
          unavailable={openCapability.unavailable === true}
          continuation={openCapability.continuation}
        />
      ) : null}
      {/* Always mounted and driven to an expanded/collapsed target each
          render: a session lifecycle can flicker (turn completes, next turn
          starts) faster than a transition settles, and unmount-based presence
          animation strands the panel when an exit is interrupted mid-flight.
          Visibility drops after collapse so the hidden panel leaves the
          accessibility tree. */}
      <motion.div
        ref={sessionViewportRef}
        data-compose-session-viewport
        role={session ? 'region' : undefined}
        aria-label={session?.label}
        tabIndex={session && sessionOverflows ? 0 : undefined}
        initial={false}
        animate={
          session
            ? {
                height: 'auto',
                opacity: 1,
                visibility: 'visible',
                transitionEnd: { overflow: 'auto', overflowX: 'hidden' },
              }
            : {
                height: 0,
                opacity: 0,
                overflow: 'hidden',
                transitionEnd: { visibility: 'hidden' },
              }
        }
        transition={{ duration: reducedMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
        /* Session detail is useful, but it cannot outrank the controls that
           answer it. In a short host this panel takes the squeeze and scrolls;
           keeping it `shrink-0` collapses the compose form and paints Send
           outside the viewport. */
        className={cn(
          'relative z-10 max-h-[calc(clamp(180px,38vh,440px)+3.5rem)] min-h-0 overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:[mask-image:none] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5',
          sessionHasMoreBelow &&
            '[mask-image:linear-gradient(to_bottom,black_calc(100%-1.25rem),transparent)]',
        )}
      >
        {panelSession ? (
          <ComposeBarSessionPanel session={panelSession} disabled={interactionDisabled} />
        ) : null}
      </motion.div>
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        onDragEnter={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          if (!onFilesSelected || interactionDisabled) return
          setDraggingFiles(true)
        }}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          if (!onFilesSelected || interactionDisabled) return
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={event => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDraggingFiles(false)
        }}
        onDrop={event => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          setDraggingFiles(false)
          if (!onFilesSelected || interactionDisabled) return
          handleFiles(event.dataTransfer.files)
          editorRef.current?.focus()
        }}
        style={{ minHeight: chromeMinHeight }}
        className={cn(
          'relative z-20 flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background',
          interactionDisabled && 'opacity-70',
          classNames?.surface,
        )}
      >
        {quality ? (
          <div
            data-compose-chrome
            className="relative flex min-w-0 shrink-0 items-center overflow-hidden"
          >
            <div className="absolute inset-0 overflow-hidden">
              <div
                className="h-full w-full"
                style={{ transform: 'scale(2)', transformOrigin: 'center' }}
              >
                <SiriOrb
                  size="100%"
                  animationDuration={16}
                  colors={resolvedTheme === 'dark' ? AI_ORB_COLORS.dark : AI_ORB_COLORS.light}
                />
              </div>
            </div>
            <div className="absolute inset-0 bg-black/25 dark:bg-black/45" />
            <QualitySelector
              {...quality}
              disabled={interactionDisabled || quality.disabled === true}
              appearance="compose"
              onAfterSelect={() => editorRef.current?.focus()}
            />
          </div>
        ) : null}

        {banner ? (
          <div data-compose-chrome className="shrink-0 border-b bg-muted/25 px-3 py-2 text-sm">
            {banner}
          </div>
        ) : null}

        {/* The one row that gives way when the host is short: the measured
            chrome keeps its height while this row shrinks and scrolls. */}
        <div
          data-compose-bar-editor-scroll
          className={cn(
            'min-h-0 overflow-y-auto px-2 pb-3',
            inputVariant === 'prominent' && 'pt-2',
          )}
        >
          <ComposeBarEditor
            {...editorInput}
            ref={editorRef}
            id={inputId}
            label={inputLabel}
            value={value}
            onValueChange={onValueChange}
            skills={skills}
            agents={agents}
            onSuggestionChange={setSuggestion}
            onSubmit={() => formRef.current?.requestSubmit()}
            onFilesSelected={onFilesSelected === undefined ? undefined : handleFiles}
            onKeyDown={handleEditorKeyDown}
            disabled={disabled}
            readOnly={readOnly}
            submitOnEnter={submitConfig?.onEnter ?? true}
            minHeight={minHeight ?? (inputVariant === 'prominent' ? 80 : undefined)}
            maxHeight={maxHeight}
            className={classNames?.input}
          />
        </div>

        {attachments.length > 0 ? (
          <div data-compose-chrome className="relative shrink-0">
            <div
              data-compose-attachments
              className="flex snap-x gap-2 overflow-x-auto px-2 pb-2 pr-8"
            >
              {attachments.map(attachment => (
                <div key={attachment.id} className="snap-start">
                  <ComposeBarAttachmentCard
                    attachment={attachment}
                    disabled={interactionDisabled}
                    onRemove={attachmentConfig?.onRemove}
                    onRetry={attachmentConfig?.onRetry}
                    retryLabel={attachmentConfig?.retryLabel ?? 'Retry'}
                    removeLabel={
                      attachmentConfig?.getRemoveLabel ?? (item => `Remove ${item.name}`)
                    }
                    renderPreview={attachmentConfig?.renderPreview}
                  />
                </div>
              ))}
            </div>
            {attachments.length > 1 ? (
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-3 right-2 rounded-full border border-border bg-background/95 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-foreground shadow-sm"
              >
                {attachments.length}
              </span>
            ) : null}
          </div>
        ) : null}

        <div
          data-compose-chrome
          className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-1 gap-y-1 px-1.5 pb-1.5"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {reasoning ? (
              <ComposeBarPickerControl picker={reasoning} disabled={interactionDisabled} />
            ) : null}

            {aiToggle ? (
              <button
                type="button"
                aria-label={aiToggle.label}
                title={aiToggle.label}
                aria-pressed={aiToggle.enabled}
                disabled={interactionDisabled || aiToggle.disabled}
                onClick={() => aiToggle.onEnabledChange(!aiToggle.enabled)}
                className={cn(
                  'group relative flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-200',
                  'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'relative flex size-6 overflow-hidden rounded-full bg-brand-subtle transition-[filter,opacity] duration-300',
                    aiToggle.enabled ? 'opacity-90 saturate-[0.7]' : 'opacity-50 grayscale',
                  )}
                >
                  {aiToggle.icon}
                </span>
              </button>
            ) : null}

            {attachmentConfig?.onFilesSelected ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  tabIndex={-1}
                  className="sr-only"
                  aria-hidden="true"
                  disabled={interactionDisabled}
                  accept={fileInput?.accept}
                  multiple
                  onChange={event => {
                    if (event.target.files) handleFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
                <button
                  type="button"
                  aria-label={fileInput?.label ?? 'Attach files'}
                  title={fileInput?.label ?? 'Attach files'}
                  disabled={interactionDisabled}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <Paperclip className="size-4" aria-hidden />
                </button>
              </>
            ) : null}

            {actions.map(action => (
              <button
                key={action.id}
                type="button"
                aria-label={action.label}
                title={action.label}
                aria-pressed={action.active}
                disabled={interactionDisabled || action.disabled}
                onClick={action.onSelect}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors',
                  'hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
                  action.active && 'bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand',
                )}
              >
                {action.icon}
              </button>
            ))}

            {status ? (
              <div className="min-w-0 truncate px-1 text-xs text-muted-foreground">{status}</div>
            ) : null}
          </div>

          <div data-compose-submit-cluster className="flex shrink-0 items-center gap-1">
            {submitAccessory}
            <Tooltip delayDuration={500}>
              <TooltipTrigger asChild>
                <span className="inline-flex rounded-md">
                  <Button
                    type="submit"
                    size="icon"
                    variant={submitEnabled ? 'brand' : 'ghost'}
                    disabled={!submitEnabled}
                    aria-label={submitting ? submittingLabel : submitLabel}
                    data-compose-submit-state={
                      submitting
                        ? 'submitting'
                        : submitBlocked
                          ? 'blocked'
                          : submitEnabled
                            ? 'enabled'
                            : 'disabled'
                    }
                    className={cn(
                      'size-11 shrink-0 rounded-md md:size-8',
                      submitBlocked &&
                        'border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground/50 disabled:opacity-100',
                      !submitEnabled &&
                        !submitBlocked &&
                        'border border-border bg-muted/40 text-muted-foreground disabled:opacity-100',
                    )}
                  >
                    {submitting ? (
                      <CircleNotch className="size-4 animate-spin" aria-hidden />
                    ) : submitBlocked ? (
                      <LockSimple className="size-4" aria-hidden />
                    ) : (
                      <PaperPlaneTilt
                        className="size-4"
                        weight={submitEnabled ? 'fill' : 'regular'}
                        aria-hidden
                      />
                    )}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                collisionPadding={12}
                className="max-w-56 rounded-lg border border-border/70 bg-popover px-2.5 py-1.5 text-[11px] leading-snug text-popover-foreground shadow-lg"
              >
                {submitTooltip}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {draggingFiles ? (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand/60 bg-background/90 text-sm font-medium text-brand backdrop-blur-sm">
            {attachmentConfig?.dropLabel ?? 'Drop files to attach'}
          </div>
        ) : null}
      </form>
    </div>
  )
}

type ComposeBarComponent = <QualityId extends string = string, ReasoningId extends string = string>(
  props: ComposeBarProps<QualityId, ReasoningId> & RefAttributes<ComposeBarHandle>,
) => ReactElement | null

const ForwardedComposeBar = forwardRef(ComposeBarImpl)
ForwardedComposeBar.displayName = 'ComposeBar'

export const ComposeBar = ForwardedComposeBar as ComposeBarComponent
