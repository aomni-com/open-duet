'use client'

import {
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  QuestionIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useId, useState } from 'react'

import { Button } from '@repo/ui/components/shadcn/button'
import { Checkbox } from '@repo/ui/components/shadcn/checkbox'
import { Label } from '@repo/ui/components/shadcn/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/components/shadcn/radio-group'
import { cn } from '@repo/ui/lib/utils'

import type { ComposeBarSessionQuestionSelection, ComposeBarSessionQuestions } from './types'

const transition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
}
const headerActionClassName = 'h-11 px-2 text-xs sm:h-7'
const headerSubmitClassName = 'h-11 px-2.5 text-xs sm:h-7'
const optionRowBaseClassName =
  'block scroll-mt-8 rounded-md bg-muted/30 px-2 py-1.5 transition-colors'
const optionRowGridClassName = 'grid grid-cols-[1rem_1fr] items-center gap-x-2 gap-y-1'
const optionControlClassName = 'row-span-2 scroll-mb-8 scroll-mt-12 shrink-0 self-center'
const optionLabelClassName = 'text-sm font-medium leading-tight'
const optionDescriptionClassName = 'text-xs text-muted-foreground'
/* The compose bar's session viewport is the one scroll owner. Keeping a second
   options scroller here strands the last answers behind two nested scroll
   positions when the conversation is short. */
const optionsListClassName = 'mt-1.5 space-y-1.5 pr-0.5'

const questionTransitionVariants = {
  enter: (direction: 1 | -1) => ({
    opacity: 0,
    x: direction * 18,
    scale: 0.98,
  }),
  center: {
    opacity: 1,
    x: 0,
    scale: 1,
  },
  exit: (direction: 1 | -1) => ({
    opacity: 0,
    x: direction * -18,
    scale: 0.98,
  }),
}

type SelectionMap = Record<number, number[]>

export function ComposeBarSessionQuestionsSection({
  questions,
  disabled,
}: {
  questions: ComposeBarSessionQuestions
  disabled: boolean
}) {
  const instanceId = useId()
  const prefersReducedMotion = useReducedMotion() ?? false
  const [selectedOptions, setSelectedOptions] = useState<SelectionMap>({})
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0)
  const [questionTransitionDirection, setQuestionTransitionDirection] = useState<1 | -1>(1)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(false)

  const items = questions.items
  const currentQuestion = items[currentQuestionIndex]
  const pending = questions.submitting === true || isSubmitting
  const isLastQuestion = currentQuestionIndex === items.length - 1
  const hasAnyAnswer = Object.values(selectedOptions).some(selected => selected.length > 0)
  const canSubmit =
    !disabled &&
    !pending &&
    items.length > 0 &&
    hasAnyAnswer &&
    currentQuestionIndex === items.length - 1
  const doneActionDisabled = disabled || pending || (isLastQuestion && !canSubmit)
  const isSingleSelectSingleQuestion =
    items.length === 1 && currentQuestion !== undefined && currentQuestion.multiSelect !== true
  const showSubmitInQuestionHeader =
    !isSingleSelectSingleQuestion &&
    items.length > 0 &&
    (items.length === 1 || currentQuestionIndex === items.length - 1)

  useEffect(() => {
    setSelectedOptions({})
    setCurrentQuestionIndex(0)
    setQuestionTransitionDirection(1)
    setIsCollapsed(false)
    setIsSubmitting(false)
    setSubmitError(false)
  }, [questions.key])

  useEffect(() => {
    if (items.length === 0 && currentQuestionIndex !== 0) {
      setCurrentQuestionIndex(0)
      return
    }
    if (currentQuestionIndex > items.length - 1) {
      setCurrentQuestionIndex(Math.max(items.length - 1, 0))
    }
  }, [currentQuestionIndex, items.length])

  if (items.length === 0 || currentQuestion === undefined) return null

  const selectionList = (selections: SelectionMap): ComposeBarSessionQuestionSelection[] =>
    items.flatMap((_, questionIndex) => {
      const optionIndexes = selections[questionIndex] ?? []
      return optionIndexes.length === 0 ? [] : [{ questionIndex, optionIndexes }]
    })

  const submit = async (
    selections: SelectionMap = selectedOptions,
    clearQuestionOnFailure?: number,
  ) => {
    const answers = selectionList(selections)
    if (answers.length === 0 || disabled || pending) return

    setIsSubmitting(true)
    setSubmitError(false)
    try {
      await questions.onSubmit(answers)
    } catch {
      if (clearQuestionOnFailure !== undefined) {
        setSelectedOptions(existing => {
          const next = { ...existing }
          delete next[clearQuestionOnFailure]
          return next
        })
      }
      setSubmitError(true)
    } finally {
      setIsSubmitting(false)
    }
  }

  const move = (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(nextIndex, items.length - 1))
    if (bounded === currentQuestionIndex) return
    setQuestionTransitionDirection(bounded > currentQuestionIndex ? 1 : -1)
    setCurrentQuestionIndex(bounded)
    setSubmitError(false)
  }

  const selectSingle = (optionIndex: number) => {
    const nextSelections = { ...selectedOptions, [currentQuestionIndex]: [optionIndex] }
    setSelectedOptions(nextSelections)

    if (items.length === 1) {
      void submit(nextSelections, currentQuestionIndex)
      return
    }
    if (!isLastQuestion) move(currentQuestionIndex + 1)
  }

  const toggleMulti = (optionIndex: number, checked: boolean) => {
    setSelectedOptions(existing => {
      const selected = existing[currentQuestionIndex] ?? []
      return {
        ...existing,
        [currentQuestionIndex]: checked
          ? [...selected, optionIndex]
          : selected.filter(index => index !== optionIndex),
      }
    })
  }

  const collapsedLabel =
    items.length > 1
      ? questions.labels.pendingWithCount(currentQuestionIndex + 1, items.length)
      : questions.labels.pending
  const optionRowClassName = cn(
    optionRowBaseClassName,
    disabled || pending ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-muted/45',
  )

  return (
    <AnimatePresence initial={false}>
      <motion.div
        key="session-questions"
        data-compose-bar-session-questions="true"
        className="px-1 py-1"
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
        transition={transition}
      >
        {isCollapsed ? (
          <button
            type="button"
            onClick={() => setIsCollapsed(false)}
            aria-label={`${questions.labels.expand}: ${collapsedLabel}`}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-1.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="flex min-w-0 items-center gap-2">
              <QuestionIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{collapsedLabel}</span>
            </span>
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/60"
              aria-hidden="true"
            >
              <CaretUpIcon className="h-3.5 w-3.5" />
            </span>
          </button>
        ) : (
          <>
            <div
              data-compose-question-header
              className="sticky top-0 z-20 flex items-center justify-between gap-2 bg-background pb-1 text-xs font-medium text-muted-foreground shadow-[0_6px_8px_-8px_hsl(var(--foreground)/0.35)]"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <QuestionIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 text-muted-foreground">{questions.labels.question}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                  {currentQuestion.header?.trim() ||
                    questions.labels.fallback(currentQuestionIndex + 1)}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setIsCollapsed(true)}
                  aria-label={questions.labels.collapse}
                  className="h-7 w-7 p-0 text-muted-foreground"
                >
                  <CaretDownIcon className="h-3.5 w-3.5" />
                </Button>

                {items.length > 1 ? (
                  <span className="hidden shrink-0 px-1 sm:inline-block">
                    {currentQuestionIndex + 1} / {items.length}
                  </span>
                ) : null}

                {items.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => move(currentQuestionIndex - 1)}
                    disabled={disabled || pending || currentQuestionIndex === 0}
                    className={headerActionClassName}
                    aria-label={questions.labels.previous}
                  >
                    <CaretLeftIcon className="h-3.5 w-3.5" />
                  </Button>
                ) : null}

                {items.length > 1 && !isLastQuestion ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => move(currentQuestionIndex + 1)}
                    disabled={disabled || pending}
                    className={headerActionClassName}
                    aria-label={questions.labels.next}
                  >
                    <CaretRightIcon className="h-3.5 w-3.5" />
                  </Button>
                ) : null}

                {showSubmitInQuestionHeader ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void submit()}
                    disabled={!canSubmit}
                    className={headerSubmitClassName}
                  >
                    {pending ? (
                      <CircleNotchIcon className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      questions.labels.submit
                    )}
                  </Button>
                ) : null}
              </div>
            </div>

            <AnimatePresence initial={false} mode="wait" custom={questionTransitionDirection}>
              <motion.div
                key={`${questions.key}-${currentQuestionIndex}`}
                className="relative z-0 mt-1 flex flex-col rounded-lg bg-background/80 p-2"
                custom={questionTransitionDirection}
                variants={questionTransitionVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: prefersReducedMotion ? 0 : 0.2, ease: 'easeOut' }}
              >
                <p className="shrink-0 text-sm text-foreground">{currentQuestion.question}</p>

                {currentQuestion.multiSelect ? (
                  <div className={optionsListClassName}>
                    {currentQuestion.options.map((option, optionIndex) => {
                      const optionId = `${instanceId}-session-question-${currentQuestionIndex}-option-${optionIndex}`
                      const selected = selectedOptions[currentQuestionIndex] ?? []
                      const checked = selected.includes(optionIndex)

                      return (
                        <Label key={optionId} htmlFor={optionId} className={optionRowClassName}>
                          <div className={optionRowGridClassName}>
                            <Checkbox
                              id={optionId}
                              checked={checked}
                              onCheckedChange={value => toggleMulti(optionIndex, value === true)}
                              disabled={disabled || pending}
                              className={optionControlClassName}
                            />
                            <span className={optionLabelClassName}>{option.label}</span>
                            {option.description?.trim() ? (
                              <p className={optionDescriptionClassName}>{option.description}</p>
                            ) : null}
                          </div>
                        </Label>
                      )
                    })}

                    <button
                      type="button"
                      onClick={() =>
                        isLastQuestion ? void submit() : move(currentQuestionIndex + 1)
                      }
                      disabled={doneActionDisabled}
                      className={cn(
                        optionRowBaseClassName,
                        'flex w-full items-center justify-between gap-2 text-left',
                        doneActionDisabled
                          ? 'cursor-not-allowed text-muted-foreground opacity-60'
                          : 'cursor-pointer text-primary hover:bg-primary/10',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <CheckCircleIcon
                          className="h-4 w-4"
                          weight={doneActionDisabled ? 'regular' : 'fill'}
                        />
                        <span className={optionLabelClassName}>
                          {isLastQuestion ? questions.labels.doneSubmit : questions.labels.doneNext}
                        </span>
                      </span>
                      <CaretRightIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <RadioGroup
                    value={selectedOptions[currentQuestionIndex]?.[0]?.toString() ?? ''}
                    onValueChange={value => {
                      selectSingle(Number(value))
                    }}
                    className={optionsListClassName}
                  >
                    {currentQuestion.options.map((option, optionIndex) => {
                      const optionId = `${instanceId}-session-question-${currentQuestionIndex}-option-${optionIndex}`

                      return (
                        <Label key={optionId} htmlFor={optionId} className={optionRowClassName}>
                          <div className={optionRowGridClassName}>
                            <RadioGroupItem
                              id={optionId}
                              value={optionIndex.toString()}
                              disabled={disabled || pending}
                              className={optionControlClassName}
                            />
                            <span className={optionLabelClassName}>{option.label}</span>
                            {option.description?.trim() ? (
                              <p className={optionDescriptionClassName}>{option.description}</p>
                            ) : null}
                          </div>
                        </Label>
                      )
                    })}
                  </RadioGroup>
                )}
              </motion.div>
            </AnimatePresence>

            {submitError ? (
              <div className="mt-2 flex items-center gap-1 text-xs text-destructive" role="alert">
                <WarningCircleIcon className="h-3.5 w-3.5" />
                <span>{questions.labels.submitError}</span>
              </div>
            ) : null}
          </>
        )}
      </motion.div>
    </AnimatePresence>
  )
}
