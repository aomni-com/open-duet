'use client'

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleNotch,
  DotsThree,
  Sparkle,
} from '@phosphor-icons/react'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { MarketplaceListingSummary } from '@repo/contract'
import { WORKSPACE_DUET_NAME_MAX_LENGTH, WORKSPACE_PURPOSE_MAX_LENGTH } from '@repo/contract'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'
import { cn } from '@repo/ui/lib/utils'
import type { DuetLocale } from '@repo/web-locale'

import { DuetApiClient } from '../api/client'
import {
  MarketplaceAgentGalleryCard,
  MarketplaceAgentMark,
  marketplaceSlugLabel,
} from '../marketplace/gallery-card'
import { PreferenceMenuItems } from '../shell/preference-menu-items'
import { goalAvatar, resolveDuetAvatar } from './onboarding-avatars'
import { ONBOARDING_LAYOUT } from './onboarding-config'
import { partitionCatalog } from './onboarding-catalog'
import {
  createInitialOnboardingState,
  effectiveOnboardingGraph,
  hasNextQuestion,
  onboardingReducer,
  recommendationsRequestNeeded,
  requiredTeamSelections,
  SELECTION_ADVANCE_MS,
  shouldAdvanceAfterAnswer,
  type CatalogState,
  type GoalMode,
  type OnboardingState,
  type OnboardingStep,
  type RecommendationsState,
} from './onboarding-flow'
import {
  chipLabelKey,
  getOnboardingGoal,
  goalDescriptionKey,
  goalLabelKey,
  ONBOARDING_GOALS,
  questionTitleKey,
  type OnboardingChipId,
  type OnboardingGoalId,
  type OnboardingQuestionId,
} from './onboarding-goals'
import { OnboardingPaymentStep } from './onboarding-payment-step'
import { composePurpose, customPurpose } from './onboarding-purpose'
import {
  createMockOnboardingService,
  type MarketplaceAgentCatalogSource,
  type OnboardingPaymentSource,
  type OnboardingRecommendationsSource,
  type OnboardingService,
} from './onboarding-service'

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const
const DEFAULT_SERVICE = createMockOnboardingService({ delayMs: 1_650 })
const DEFAULT_API_SOURCE = new DuetApiClient()
/**
 * The client-side guard atop the server's own 10s LLM abort: if the request
 * has not settled by then, abort it and settle for the plain catalog. The
 * margin covers transport overhead without ever leaving a stuck skeleton.
 */
const RECOMMENDATIONS_CLIENT_TIMEOUT_MS = 12_000
/**
 * Duet arriving in a goal tile.
 *
 * A spring, not a curve, but a short one: he arrives slightly small, a
 * little low and barely tilted, then settles with one small sway — measured
 * at roughly a 1% overshoot, at rest inside 200ms. The tilt springing through
 * zero is what makes it read as a character catching its balance rather than
 * an image scaling up, and the amount of tilt needed for that is far less
 * than it first appears. `MotionConfig reducedMotion="user"` upstream turns
 * the whole thing into a plain cut for anyone who asked.
 */
const GOAL_MARK_REVEAL = {
  away: { opacity: 0, scale: 0.86, rotate: -7, y: 5 },
  out: {
    opacity: 1,
    scale: 1,
    rotate: 0,
    y: 0,
    // Loosening the damping is what turns this from a character landing into
    // a toy — an earlier pass at stiffness 600 / damping 12 overshot to 1.21
    // and rocked for half a second.
    transition: { type: 'spring', stiffness: 520, damping: 22, mass: 0.5 },
  },
} as const

/** Rise-and-fade for the recommendation rail; staggered by its parent. */
const RAIL_ENTRANCE = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE_OUT_EXPO } },
} as const

export function OnboardingExperience({
  service = DEFAULT_SERVICE,
  catalogSource = DEFAULT_API_SOURCE,
  recommendationsSource = DEFAULT_API_SOURCE,
  paymentSource = DEFAULT_API_SOURCE,
  billingEmail,
  workspaceSlug = '',
  initialState,
  starterAgents = [],
  onComplete,
  onLocale = () => {},
  onLogout = () => {},
  workspaceMenu,
}: {
  service?: OnboardingService
  catalogSource?: MarketplaceAgentCatalogSource
  recommendationsSource?: OnboardingRecommendationsSource
  paymentSource?: OnboardingPaymentSource
  billingEmail?: string
  workspaceSlug?: string
  initialState?: Partial<OnboardingState>
  starterAgents?: readonly string[]
  onComplete?: (completion: { duetName: string; destination: string; onboardedAt: number }) => void
  onLocale?: (locale: DuetLocale) => void
  onLogout?: () => void
  workspaceMenu?: ReactNode
}) {
  const t = useTranslations('duetOnboarding')
  const [state, dispatch] = useReducer(onboardingReducer, undefined, () => ({
    ...createInitialOnboardingState(),
    ...initialState,
  }))
  const [direction, setDirection] = useState(1)
  const [nameTouched, setNameTouched] = useState(false)
  const [goalTouched, setGoalTouched] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [completionError, setCompletionError] = useState<string>()
  const [completionWarning, setCompletionWarning] = useState<string>()
  const [paymentReady, setPaymentReady] = useState(false)
  const [completed, setCompleted] = useState<{
    duetName: string
    destination: string
    onboardedAt: number
  }>()
  const contentRef = useRef<HTMLDivElement>(null)
  /**
   * A tapped answer carries you forward by itself after a beat. The pending
   * move is always cancellable: pressing Back, or answering again, must not
   * leave a queued jump that fires a step later than the user expects.
   */
  const advanceTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cancelAdvance = useCallback(() => {
    if (advanceTimer.current === undefined) return
    clearTimeout(advanceTimer.current)
    advanceTimer.current = undefined
  }, [])
  useEffect(() => cancelAdvance, [cancelAdvance])
  const advanceAfterSelection = useCallback(
    (run: () => void) => {
      cancelAdvance()
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = undefined
        run()
      }, SELECTION_ADVANCE_MS)
    },
    [cancelAdvance],
  )

  const loadAgents = useCallback(
    async (signal?: AbortSignal, cursor?: string) => {
      dispatch({ type: cursor === undefined ? 'catalog-loading' : 'catalog-more-loading' })
      try {
        const { items, nextCursor } = await catalogSource.listMarketplaceCatalog({
          signal,
          cursor,
          verifiedPublisher: true,
        })
        // Onboarding offers OFFICIAL agents only: the starters gallery is a
        // curated first-run surface, not the marketplace. It keeps the LISTINGS
        // themselves — there is one agent shape now, and adapting to a second
        // one here is what let the two surfaces drift.
        if (!signal?.aborted) dispatch({ type: 'catalog-page-ready', agents: items, nextCursor })
      } catch {
        if (!signal?.aborted)
          dispatch({ type: cursor === undefined ? 'catalog-error' : 'catalog-more-error' })
      }
    },
    [catalogSource],
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadAgents(controller.signal)
    return () => controller.abort()
  }, [loadAgents])

  // What-you-tapped-is-what-you-stored: composition resolves the RAW localized
  // templates (placeholders intact) and splices them itself. One memo feeds
  // both the recommendations request and the completion payload, so the two
  // can never disagree about what the user's purpose says.
  const composedPurpose = useMemo(() => {
    if (state.goal.kind === 'preset') {
      return composePurpose(
        { goalId: state.goal.goalId, answers: state.answers, details: state.answerDetails },
        key => String(t.raw(key)),
      )
    }
    if (state.goal.kind === 'custom') return customPurpose(state.customPurpose)
    return ''
  }, [state.goal, state.answers, state.answerDetails, state.customPurpose, t])

  /**
   * Fire-and-forget recommendations, at most one in flight: entering `team`
   * (from follow-ups, or straight from goal on the custom path) fires one
   * request for the current composed purpose. `recommendationsRequestNeeded`
   * memoizes by exact purpose string — back/forward reuses the settled
   * result, changed answers refetch — and every failure settles as empty
   * (`ready`), so onboarding never blocks on this request by construction.
   */
  const recommendationsAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    if (state.step !== 'team') return
    if (!recommendationsRequestNeeded(state.recommendations, composedPurpose)) return
    const purpose = composedPurpose
    const tagHints =
      state.goal.kind === 'preset' ? getOnboardingGoal(state.goal.goalId).tagHints : undefined
    recommendationsAbort.current?.abort()
    const controller = new AbortController()
    recommendationsAbort.current = controller
    // The timeout settles the state itself: aborting only asks the source to
    // reject, and a source that ignores the signal would leave the skeleton up
    // forever. The reducer's purpose guard makes the later settle a no-op.
    const timeout = setTimeout(() => {
      controller.abort()
      dispatch({ type: 'recommendations-settle', purpose, items: [] })
    }, RECOMMENDATIONS_CLIENT_TIMEOUT_MS)
    dispatch({ type: 'recommendations-pending', purpose })
    void recommendationsSource
      .recommendOnboardingAgents(
        workspaceSlug,
        { purpose, ...(tagHints === undefined ? {} : { tagHints: [...tagHints] }) },
        controller.signal,
      )
      .then(({ recommendations }) =>
        dispatch({ type: 'recommendations-settle', purpose, items: recommendations }),
      )
      .catch(() => dispatch({ type: 'recommendations-settle', purpose, items: [] }))
      .finally(() => clearTimeout(timeout))
    return () => {
      controller.abort()
      clearTimeout(timeout)
    }
    /* `state.recommendations` is read above but is deliberately NOT a
       dependency: the effect itself moves it to `pending`, and listing it
       re-ran the effect on that very change — whose cleanup aborted the request
       it had just sent, so the rail always settled empty against a real
       network. Each run is a fresh closure, so the guard still reads the
       current state whenever the step or the purpose actually changes. */
  }, [state.step, state.goal, composedPurpose, recommendationsSource, workspaceSlug])

  // The mark follows the CHOICE, not the pointer: hovering previews inside
  // the tile itself, and the header only changes once a goal is actually
  // picked — then keeps it through the follow-ups that goal asks.
  const duetAvatar = resolveDuetAvatar({
    selected: state.goal.kind === 'preset' ? state.goal.goalId : undefined,
  })

  const graph = effectiveOnboardingGraph({ campaignAgents: starterAgents, goalMode: state.goal })
  const stepConfig = graph.at(state.step)
  const currentIndex = stepConfig.index
  const catalog = state.catalog
  const nameIsValid = state.duetName.trim().length > 0
  const displayName = state.duetName.trim() || t('brand')
  // Who the celebration is about. A campaign arrival never reached the team
  // step, so its picks are empty by construction and the agents arriving are the
  // ones the campaign named — read straight off the names, so the two-step flow
  // never waits on the catalog to say it is ready. Everyone else is celebrating
  // what they chose, still in the order the team step listed them rather than
  // the order they happened to tap.
  const readyAgentNames = useMemo(
    () =>
      starterAgents.length > 0
        ? starterAgents
        : catalog.agents
            .filter(agent => state.selectedAgentNames.includes(agent.agentName))
            .map(agent => agent.agentName),
    [catalog.agents, starterAgents, state.selectedAgentNames],
  )
  const goalSummary =
    state.goal.kind === 'preset'
      ? t(goalLabelKey(state.goal.goalId))
      : state.goal.kind === 'custom' && state.customPurpose.trim().length > 0
        ? state.customPurpose.trim()
        : undefined

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [state.step])

  function goTo(step: OnboardingStep) {
    cancelAdvance()
    setCompletionError(undefined)
    setCompletionWarning(undefined)
    setDirection(graph.at(step).index >= currentIndex ? 1 : -1)
    dispatch({ type: 'go-to', step })
  }

  function goBack() {
    cancelAdvance()
    if (state.step === 'follow-ups' && state.followUpIndex > 0) {
      dispatch({ type: 'previous-question' })
      return
    }
    if (stepConfig.previous) goTo(stepConfig.previous)
  }

  function goToNext() {
    if (!stepConfig.next) {
      throw new Error(`Onboarding step has no forward destination: ${state.step}`)
    }
    goTo(stepConfig.next)
  }

  /**
   * A goal tile advances on tap. The pick and the step change land in one
   * dispatch batch because `goTo` reads the CURRENT graph — which excludes
   * `follow-ups` until the pick has reduced. Re-picking the already-selected
   * goal must not re-seed: the smart defaults would wipe answers the user
   * changed before coming Back.
   */
  function pickGoal(goalId: OnboardingGoalId) {
    cancelAdvance()
    setCompletionError(undefined)
    setCompletionWarning(undefined)
    setDirection(1)
    if (state.goal.kind !== 'preset' || state.goal.goalId !== goalId) {
      dispatch({ type: 'pick-goal', goalId })
    }
    // The pick lands now — check, mark, and all — and the step changes a beat
    // later, so the tap is visibly answered before the page moves.
    advanceAfterSelection(() => dispatch({ type: 'go-to', step: 'follow-ups' }))
  }

  function goForward() {
    cancelAdvance()
    if (stepConfig.primaryAction === 'advance') {
      if (stepConfig.validation === 'duet-name') {
        setNameTouched(true)
        if (!nameIsValid) return
      }
      if (stepConfig.validation === 'goal-choice') {
        setGoalTouched(true)
        if (state.goal.kind === 'none') return
        if (state.goal.kind === 'custom' && state.customPurpose.trim().length === 0) return
      }
      goToNext()
      return
    }
    if (stepConfig.primaryAction === 'advance-question') {
      if (hasNextQuestion(state)) {
        dispatch({ type: 'next-question' })
        return
      }
      goToNext()
      return
    }

    if (completing) return
    if (completed !== undefined) {
      if (onComplete) onComplete(completed)
      else window.location.assign(completed.destination)
      return
    }
    setCompletionError(undefined)
    setCompletionWarning(undefined)
    setCompleting(true)
    const purpose = composedPurpose
    const goal =
      state.goal.kind === 'preset'
        ? state.goal.goalId
        : state.goal.kind === 'custom'
          ? 'custom'
          : undefined
    void service
      .completeOnboarding({
        duetName: state.duetName.trim(),
        selectedAgentNames: state.selectedAgentNames,
        ...(purpose.length > 0 ? { purpose } : {}),
        ...(goal === undefined ? {} : { goal }),
      })
      .then(({ duetName, destination, onboardedAt, warning }) => {
        if (warning !== undefined) {
          setCompleted({ duetName, destination, onboardedAt })
          setCompletionWarning(t('agentInstallWarning'))
          setCompleting(false)
          return
        }
        if (onComplete) onComplete({ duetName, destination, onboardedAt })
        else window.location.assign(destination)
      })
      .catch(() => {
        setCompletionError(t('completionError'))
        setCompleting(false)
      })
  }

  // The minimum-3 floor (fail-open: `requiredTeamSelections` is 0 unless the
  // catalog is healthy). The gate is a count, so the button states the count
  // — a separate hint line would cost fixed footer height on every scroll of
  // a catalog the user is meant to browse.
  const missingSelections =
    stepConfig.validation === 'team-minimum'
      ? Math.max(0, requiredTeamSelections(catalog) - state.selectedAgentNames.length)
      : 0
  const primaryDisabled =
    completing || missingSelections > 0 || (state.step === 'payment' && !paymentReady)
  const primaryLabel =
    missingSelections > 0
      ? t('teamMinimumAction', { count: missingSelections })
      : stepConfig.primaryAction === 'complete'
        ? completing
          ? t('enteringWorkspace')
          : completionWarning
            ? t('continueToWorkspace')
            : completionError
              ? t('retryOpening')
              : t('enterWorkspace')
        : t('continue')

  return (
    <MotionConfig reducedMotion="user">
      <main
        data-onboarding-step={state.step}
        data-followup-index={state.step === 'follow-ups' ? state.followUpIndex : undefined}
        className="absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground selection:bg-foreground selection:text-background"
      >
        <div className={cn(ONBOARDING_LAYOUT.gutter, 'shrink-0')}>
          <OnboardingHeader
            assistantName={displayName}
            currentIndex={currentIndex}
            steps={graph.steps}
            avatarSrc={duetAvatar}
            onLocale={onLocale}
            onLogout={onLogout}
            workspaceMenu={workspaceMenu}
          />
        </div>

        <form
          aria-label={t('formLabel')}
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={event => {
            event.preventDefault()
            if (!primaryDisabled) goForward()
          }}
        >
          {/* The scroll owner is the window's whole width — the gutter and the
              reading column are drawn INSIDE it, so no part of the window is
              dead to the wheel. */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={contentRef}
              data-onboarding-scroll
              className="h-full overflow-y-auto overscroll-contain"
            >
              <div
                className={cn(
                  ONBOARDING_LAYOUT.gutter,
                  'flex min-h-full items-start py-7 sm:py-10',
                )}
              >
                <div className={cn(ONBOARDING_LAYOUT.content, 'my-auto')}>
                  <AnimatePresence mode="wait" initial={false} custom={direction}>
                    <motion.div
                      key={state.step}
                      custom={direction}
                      initial={{
                        opacity: 0,
                        transform: `translateY(${direction > 0 ? 12 : -8}px)`,
                      }}
                      animate={{ opacity: 1, transform: 'translateY(0)' }}
                      exit={{
                        opacity: 0,
                        transform: `translateY(${direction > 0 ? -8 : 12}px)`,
                      }}
                      transition={{ duration: 0.24, ease: EASE_OUT_EXPO }}
                    >
                      {state.step === 'identity' ? (
                        <IdentityStep
                          name={state.duetName}
                          displayName={displayName}
                          invalid={nameTouched && !nameIsValid}
                          onName={name => dispatch({ type: 'set-name', name })}
                        />
                      ) : state.step === 'team' ? (
                        <TeamStep
                          duetName={displayName}
                          catalog={catalog}
                          recommendations={state.recommendations}
                          selectedNames={state.selectedAgentNames}
                          onToggle={name => dispatch({ type: 'toggle-agent', name })}
                          onRetry={loadAgents}
                          onLoadMore={() =>
                            void loadAgents(
                              undefined,
                              catalog.status === 'ready'
                                ? (catalog.nextCursor ?? undefined)
                                : undefined,
                            )
                          }
                        />
                      ) : state.step === 'goal' ? (
                        <GoalStep
                          duetName={displayName}
                          goal={state.goal}
                          customText={state.customPurpose}
                          touched={goalTouched}
                          onPick={pickGoal}
                          onChooseCustom={() => {
                            // Without this, a goal tapped less than a beat ago
                            // still has a queued jump to `follow-ups` — a step
                            // that choosing "write your own" removes from the
                            // graph, so it lands on a step that is not there.
                            cancelAdvance()
                            dispatch({ type: 'choose-custom-goal' })
                          }}
                          onCustomText={text => dispatch({ type: 'set-custom-purpose', text })}
                        />
                      ) : state.step === 'follow-ups' && state.goal.kind === 'preset' ? (
                        <FollowUpsStep
                          duetName={displayName}
                          goalId={state.goal.goalId}
                          index={state.followUpIndex}
                          answers={state.answers}
                          details={state.answerDetails}
                          onAnswer={(questionId, chipId) => {
                            cancelAdvance()
                            dispatch({ type: 'answer-question', questionId, chipId })
                            if (shouldAdvanceAfterAnswer(state.answerDetails[questionId])) {
                              advanceAfterSelection(goForward)
                            }
                          }}
                          onDetail={(questionId, detail) => {
                            // The rule is evaluated when the chip is tapped, so
                            // typing straight after a tap has to call the queued
                            // move off itself.
                            cancelAdvance()
                            dispatch({ type: 'set-answer-detail', questionId, detail })
                          }}
                        />
                      ) : state.step === 'payment' ? (
                        <OnboardingPaymentStep
                          workspaceSlug={workspaceSlug}
                          api={paymentSource}
                          billingEmail={billingEmail}
                          onReady={() => setPaymentReady(true)}
                        />
                      ) : (
                        <ReadyStep
                          duetName={displayName}
                          goal={state.goal}
                          goalSummary={goalSummary}
                          answers={state.answers}
                          agentNames={readyAgentNames}
                        />
                      )}
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </div>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent via-background/50 to-background"
            />
          </div>

          <div className={cn(ONBOARDING_LAYOUT.gutter, 'shrink-0')}>
            <footer
              className={cn(
                'border-t border-foreground/10 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pt-5',
                (completionError || completionWarning || missingSelections > 0) && 'pt-3 sm:pt-4',
              )}
            >
              <div className={ONBOARDING_LAYOUT.content}>
                {completionError || completionWarning ? (
                  <p
                    role="alert"
                    aria-atomic="true"
                    className={cn(
                      'mb-3 text-right text-sm',
                      completionWarning ? 'text-amber-700 dark:text-amber-300' : 'text-destructive',
                    )}
                  >
                    {completionWarning ?? completionError}
                  </p>
                ) : null}

                <div
                  className={cn(
                    'flex items-start gap-4',
                    stepConfig.previous ? 'justify-between' : 'justify-end',
                  )}
                >
                  {stepConfig.previous && completed === undefined ? (
                    <div className="min-w-16">
                      <button
                        type="button"
                        onClick={goBack}
                        className="inline-flex min-h-12 items-center gap-2 rounded-lg px-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground active:opacity-70 focus-visible:ring-2 focus-visible:ring-foreground"
                      >
                        <ArrowLeft className="size-4" aria-hidden />
                        {t('back')}
                      </button>
                    </div>
                  ) : null}

                  <div
                    className={cn(
                      'flex items-center gap-3',
                      stepConfig.primaryWidth === 'responsive-full' && 'w-full sm:w-auto',
                    )}
                  >
                    <button
                      type="submit"
                      data-onboarding-primary
                      disabled={primaryDisabled}
                      className={cn(
                        'inline-flex min-h-12 min-w-36 items-center justify-center gap-2.5 rounded-xl border border-neutral-950 bg-neutral-950 px-5 text-sm font-semibold text-neutral-50 shadow-[0_12px_28px_-18px_currentColor] outline-none transition-opacity hover:opacity-88 active:opacity-80 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-50 dark:bg-neutral-50 dark:text-neutral-950 sm:min-w-44',
                        stepConfig.primaryWidth === 'responsive-full' && 'w-full sm:w-auto',
                      )}
                    >
                      {completing ? (
                        <CircleNotch className="size-4 motion-safe:animate-spin" aria-hidden />
                      ) : null}
                      <span>{primaryLabel}</span>
                      {!completing ? <ArrowRight className="size-4" aria-hidden /> : null}
                    </button>
                  </div>
                </div>
              </div>
            </footer>
          </div>
        </form>
      </main>
    </MotionConfig>
  )
}

/**
 * Duet's mark, wearing whatever the chosen goal put in his hand.
 *
 * One image: by the time the header can change, the goal tiles have already
 * rendered every variant, so the swap comes out of cache rather than off the
 * network. It is decorative — the assistant's name sits beside it — so it
 * carries no alt text.
 */
function DuetMark({
  src,
  className,
  priority = false,
}: {
  src: string
  className?: string
  priority?: boolean
}) {
  return (
    <Image
      src={src}
      alt=""
      width={112}
      height={112}
      priority={priority}
      className={cn('shrink-0 object-cover', className)}
    />
  )
}

function OnboardingHeader({
  assistantName,
  currentIndex,
  steps,
  avatarSrc,
  onLocale,
  onLogout,
  workspaceMenu,
}: {
  assistantName: string
  currentIndex: number
  steps: ReturnType<typeof effectiveOnboardingGraph>['steps']
  avatarSrc: string
  onLocale: (locale: DuetLocale) => void
  onLogout: () => void
  workspaceMenu?: ReactNode
}) {
  const t = useTranslations('duetOnboarding')
  return (
    <header className="flex h-[4.5rem] shrink-0 items-center justify-between border-b border-foreground/10">
      <div className="flex min-w-0 items-center gap-2.5">
        <DuetMark
          src={avatarSrc}
          priority
          className="size-11 overflow-hidden rounded-xl ring-1 ring-foreground/10"
        />
        <div className="min-w-0 leading-tight">
          <p className="max-w-[6.5rem] truncate text-sm font-semibold sm:max-w-[14rem]">
            {assistantName}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('setupLabel')}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div
          className="flex items-center gap-3"
          role="progressbar"
          aria-label={t('progressLabel')}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={currentIndex + 1}
          aria-valuetext={t('stepCounter', {
            current: currentIndex + 1,
            total: steps.length,
          })}
        >
          {/* The ⋯ menu costs the width this counter used to have on a phone;
              the bars and aria-valuetext keep carrying the count there. */}
          <span className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground sm:block">
            {t('stepCounter', { current: currentIndex + 1, total: steps.length })}
          </span>
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((step, index) => (
              <span
                key={step.id}
                className="h-1 w-5 overflow-hidden rounded-full bg-foreground/20 sm:w-6"
              >
                <motion.span
                  className="block h-full origin-left rounded-full bg-foreground"
                  initial={false}
                  animate={{ transform: `scaleX(${index <= currentIndex ? 1 : 0})` }}
                  transition={{ duration: 0.22, ease: EASE_OUT_EXPO }}
                />
              </span>
            ))}
          </div>
        </div>
        {workspaceMenu}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('menuLabel')}
              className="grid size-9 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground"
            >
              <DotsThree aria-hidden size={22} weight="bold" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-60">
            <PreferenceMenuItems onLocale={onLocale} onLogout={onLogout} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function StepIntroduction({
  kicker,
  title,
  body,
}: {
  /** Optional: a step whose title already says where you are omits it. */
  kicker?: string
  title: string
  body?: string
}) {
  return (
    <div className="mb-7 sm:mb-8">
      {kicker === undefined ? null : (
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {kicker}
        </p>
      )}
      <h1 className="text-[2.35rem] font-semibold leading-[1.02] tracking-[-0.052em] sm:text-[3.25rem]">
        {title}
      </h1>
      {body === undefined ? null : (
        <p className="mt-4 max-w-[58ch] text-[0.95rem] leading-7 text-muted-foreground sm:text-base">
          {body}
        </p>
      )}
    </div>
  )
}

function IdentityStep({
  name,
  displayName,
  invalid,
  onName,
}: {
  name: string
  displayName: string
  invalid: boolean
  onName: (name: string) => void
}) {
  const t = useTranslations('duetOnboarding')
  return (
    <div>
      <StepIntroduction
        kicker={t('identityKicker')}
        title={t('identityTitle')}
        body={t('identityBody')}
      />
      <div className="mb-5 flex items-center gap-3 rounded-2xl border border-foreground/10 bg-background/55 p-3.5 dark:bg-white/[0.025]">
        <Image
          src="/icons/duet-avatar.png"
          alt={t('duetAlt', { name: displayName })}
          width={96}
          height={96}
          priority
          className="size-11 rounded-xl object-cover ring-1 ring-foreground/10"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{displayName}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('duetAlwaysHere')}</p>
        </div>
      </div>
      <label htmlFor="onboarding-duet-name" className="text-sm font-medium">
        {t('nameLabel')}
      </label>
      <input
        id="onboarding-duet-name"
        value={name}
        onChange={event => onName(event.target.value.slice(0, WORKSPACE_DUET_NAME_MAX_LENGTH))}
        maxLength={WORKSPACE_DUET_NAME_MAX_LENGTH}
        required
        enterKeyHint="next"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'onboarding-name-error' : 'onboarding-name-hint'}
        className={cn(
          'mt-2 h-14 w-full rounded-xl border bg-background/70 px-4 text-lg font-medium outline-none transition-[border-color,box-shadow] focus:ring-4 dark:bg-white/[0.035]',
          invalid
            ? 'border-destructive focus:border-destructive focus:ring-destructive/10'
            : 'border-foreground/15 focus:border-foreground/40 focus:ring-foreground/[0.06]',
        )}
      />
      <p
        id={invalid ? 'onboarding-name-error' : 'onboarding-name-hint'}
        className={cn('mt-2 text-xs', invalid ? 'text-destructive' : 'text-muted-foreground')}
      >
        {invalid ? t('nameRequired') : t('nameHint')}
      </p>
    </div>
  )
}

function GoalStep({
  duetName,
  goal,
  customText,
  touched,
  onPick,
  onChooseCustom,
  onCustomText,
}: {
  duetName: string
  goal: GoalMode
  customText: string
  touched: boolean
  onPick: (goalId: OnboardingGoalId) => void
  onChooseCustom: () => void
  onCustomText: (text: string) => void
}) {
  const t = useTranslations('duetOnboarding')
  const customChosen = goal.kind === 'custom'
  const invalid =
    touched && (goal.kind === 'none' || (customChosen && customText.trim().length === 0))
  return (
    <div>
      <StepIntroduction
        kicker={t('goalKicker')}
        title={t('goalTitle')}
        body={t('goalBody', { name: duetName })}
      />
      {/* One column at every width. Two columns suited six tiles (a clean 3×2);
          three leaves a hole beside the last one, and the descriptions these
          tiles now carry would rather have the full width than share it. */}
      <div className="grid gap-3" data-onboarding-goal-tiles>
        {ONBOARDING_GOALS.map(candidate => {
          const selected = goal.kind === 'preset' && goal.goalId === candidate.id
          return (
            <motion.button
              key={candidate.id}
              type="button"
              aria-pressed={selected}
              /* The tile's name is the goal, and the subtitle is its
                 description — not a second half of the name. Left to the
                 button's own contents both would run together into "Grow my
                 business It's running already…", which is a worse thing to hear
                 read out and a name no test can match on. */
              aria-label={t(goalLabelKey(candidate.id))}
              aria-describedby={`onboarding-goal-${candidate.id}-description`}
              onClick={() => onPick(candidate.id)}
              // The tile owns the gesture; the mark inside reads it through
              // variants, so there is still no hover state in React.
              initial={false}
              animate={selected ? 'out' : 'away'}
              whileHover="out"
              whileFocus="out"
              className={cn(
                'group flex min-h-[4.25rem] items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left text-[0.95rem] font-medium outline-none transition-[color,background-color,border-color] duration-150 focus-visible:ring-2 focus-visible:ring-foreground',
                selected
                  ? 'border-foreground bg-foreground/[0.045]'
                  : 'border-foreground/10 bg-background/55 hover:bg-foreground/[0.04] dark:bg-white/[0.025]',
              )}
            >
              {/* Three goals instead of six, so each label is broader and each
                  tile has room to say who it is for — the same two-line body
                  the custom tile has always had. */}
              <span className="min-w-0">
                <span className="block">{t(goalLabelKey(candidate.id))}</span>
                <span
                  id={`onboarding-goal-${candidate.id}-description`}
                  className="mt-0.5 block text-xs font-normal text-muted-foreground"
                >
                  {t(goalDescriptionKey(candidate.id))}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2.5">
                {/* Duet holding the tool this goal is about, on a spring so he
                    lands like a character rather than a fading image: he
                    arrives small and tilted, swings past upright, and rocks
                    back into place. A spring gives that for free, and gives it
                    differently depending on how fast the pointer arrives —
                    which is the part an eased transition can never do. */}
                <motion.span variants={GOAL_MARK_REVEAL} className="block size-9">
                  <Image
                    src={goalAvatar(candidate.id)}
                    alt=""
                    aria-hidden
                    width={112}
                    height={112}
                    className="size-9 rounded-lg object-cover ring-1 ring-foreground/10"
                  />
                </motion.span>
                <span
                  aria-hidden
                  className={cn(
                    'grid size-6 place-items-center rounded-full transition-colors',
                    selected
                      ? 'bg-foreground text-background'
                      : 'text-transparent ring-1 ring-inset ring-foreground/25',
                  )}
                >
                  <Check className="size-3.5" weight="bold" />
                </span>
              </span>
            </motion.button>
          )
        })}
        <button
          type="button"
          aria-pressed={customChosen}
          aria-expanded={customChosen}
          onClick={onChooseCustom}
          className={cn(
            'flex min-h-[4.25rem] items-center justify-between gap-3 rounded-2xl border px-4 py-3.5 text-left outline-none transition-[color,background-color,border-color,transform] duration-150 active:scale-[.99] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-foreground',
            customChosen
              ? 'border-solid border-foreground bg-foreground/[0.045]'
              : 'border-dashed border-foreground/25 hover:bg-foreground/[0.04]',
          )}
        >
          <span className="min-w-0">
            <span className="block text-[0.95rem] font-medium">{t('goalCustomTile')}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t('goalCustomHint')}
            </span>
          </span>
          <span
            aria-hidden
            className={cn(
              'grid size-6 shrink-0 place-items-center rounded-full transition-colors',
              customChosen
                ? 'bg-foreground text-background'
                : 'text-transparent ring-1 ring-inset ring-foreground/25',
            )}
          >
            <Check className="size-3.5" weight="bold" />
          </span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {customChosen ? (
          <motion.div
            // Collapse through grid-template-rows rather than height: `auto`
            // has no numeric start, so height animation forces a per-frame
            // layout pass. `0fr → 1fr` reads the same and stays off the
            // layout thrash path.
            initial={{ opacity: 0, gridTemplateRows: '0fr' }}
            animate={{ opacity: 1, gridTemplateRows: '1fr' }}
            exit={{ opacity: 0, gridTemplateRows: '0fr' }}
            transition={{ duration: 0.22, ease: EASE_OUT_EXPO }}
            className="grid"
          >
            <div className="overflow-hidden pt-4">
              <label htmlFor="onboarding-custom-goal" className="text-sm font-medium">
                {t('customGoalLabel')}
              </label>
              <textarea
                id="onboarding-custom-goal"
                value={customText}
                onChange={event =>
                  onCustomText(event.target.value.slice(0, WORKSPACE_PURPOSE_MAX_LENGTH))
                }
                maxLength={WORKSPACE_PURPOSE_MAX_LENGTH}
                rows={3}
                autoFocus
                placeholder={t('customGoalPlaceholder')}
                enterKeyHint="next"
                aria-invalid={invalid}
                aria-describedby={invalid ? 'onboarding-goal-error' : undefined}
                className={cn(
                  'mt-2 w-full resize-none rounded-xl border bg-background/70 px-4 py-3 text-base font-medium outline-none transition-[border-color,box-shadow] focus:ring-4 dark:bg-white/[0.035]',
                  invalid
                    ? 'border-destructive focus:border-destructive focus:ring-destructive/10'
                    : 'border-foreground/15 focus:border-foreground/40 focus:ring-foreground/[0.06]',
                )}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {invalid ? (
        <p id="onboarding-goal-error" className="mt-3 text-xs text-destructive">
          {t(customChosen ? 'customGoalRequired' : 'goalRequired')}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The purpose as it stands: the goal, then the answers given so far.
 *
 * The goal leads because it leads the composed purpose too — the stored text
 * opens "Goal: grow my business." and the answers qualify it. It is styled a
 * step stronger than the answers so the row reads as a heading followed by
 * its detail rather than a run of equal tags.
 *
 * The same list serves two places. On a follow-up question it is what the
 * reader is standing on rather than a counter of how many screens are left —
 * with one question per goal that means the goal alone, since the question
 * being asked is never recapped. In the closing summary it shows the answers
 * with the goal suppressed, because the row it hangs under already names it.
 * Unanswered questions read their smart default, because that default is what
 * the stored purpose will say — a recap that showed a blank would be lying
 * about the text being assembled.
 */
function AnsweredChips({
  goalId,
  answers,
  upTo,
  showGoal = true,
  className,
}: {
  goalId: OnboardingGoalId
  answers: Readonly<Partial<Record<OnboardingQuestionId, OnboardingChipId>>>
  /** How many questions to recap — the current question is never included. */
  upTo: number
  /** Off where a heading already names the goal, as the summary row does. */
  showGoal?: boolean
  className?: string
}) {
  const t = useTranslations('duetOnboarding')
  const questions = getOnboardingGoal(goalId).questions.slice(0, upTo)
  return (
    <ul
      data-onboarding-answered
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      aria-label={t('answeredSoFar')}
    >
      {showGoal ? (
        <li className="inline-flex items-center rounded-full bg-foreground/[0.11] px-2.5 py-1 text-xs font-medium text-foreground/85">
          {t(goalLabelKey(goalId))}
        </li>
      ) : null}
      {questions.map(question => (
        <li
          key={question.id}
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.06] py-1 pl-2 pr-2.5 text-xs text-muted-foreground"
        >
          <Check aria-hidden className="size-3 shrink-0 text-foreground/45" weight="bold" />
          {t(chipLabelKey(goalId, question.id, answers[question.id] ?? question.defaultChipId))}
        </li>
      ))}
    </ul>
  )
}

function FollowUpsStep({
  duetName,
  goalId,
  index,
  answers,
  details,
  onAnswer,
  onDetail,
}: {
  duetName: string
  goalId: OnboardingGoalId
  index: number
  answers: Readonly<Partial<Record<OnboardingQuestionId, OnboardingChipId>>>
  details: Readonly<Partial<Record<OnboardingQuestionId, string>>>
  onAnswer: (questionId: OnboardingQuestionId, chipId: OnboardingChipId) => void
  onDetail: (questionId: OnboardingQuestionId, detail: string) => void
}) {
  const t = useTranslations('duetOnboarding')
  const goal = getOnboardingGoal(goalId)
  const question = goal.questions[index] ?? goal.questions[0]!
  const selectedChip = answers[question.id] ?? question.defaultChipId
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={question.id}
        initial={{ opacity: 0, transform: 'translateY(10px)' }}
        animate={{ opacity: 1, transform: 'translateY(0)' }}
        exit={{ opacity: 0, transform: 'translateY(-6px)' }}
        transition={{ duration: 0.2, ease: EASE_OUT_EXPO }}
      >
        {/* What you already said, instead of a counter. The header's step
            indicator already carries progress; this carries the answers, so
            the space earns its place twice — orientation and a record of the
            purpose being assembled. */}
        <AnsweredChips goalId={goalId} answers={answers} upTo={index} className="mb-3" />
        {/* Only one question asks by name today ("What should Ada take on
            first?"), but every title is formatted with it — a title that grows
            a {name} later should not have to grow a prop too. */}
        <StepIntroduction title={t(questionTitleKey(goalId, question.id), { name: duetName })} />
        <div className="flex flex-wrap gap-2.5" role="group" data-onboarding-chip-row>
          {question.chipIds.map(chipId => {
            const selected = chipId === selectedChip
            return (
              <button
                key={chipId}
                type="button"
                aria-pressed={selected}
                onClick={() => onAnswer(question.id, chipId)}
                className={cn(
                  'inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none transition-[color,background-color,border-color,transform] duration-150 active:scale-[.97] motion-reduce:active:scale-100 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  selected
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/25 hover:bg-foreground/[0.04]',
                )}
              >
                {t(chipLabelKey(goalId, question.id, chipId))}
              </button>
            )
          })}
        </div>
        <div className="mt-6">
          <label
            htmlFor={`onboarding-detail-${question.id}`}
            className="text-sm font-medium text-muted-foreground"
          >
            {t('addDetailLabel')}
          </label>
          <input
            id={`onboarding-detail-${question.id}`}
            value={details[question.id] ?? ''}
            onChange={event => onDetail(question.id, event.target.value)}
            placeholder={t('addDetailPlaceholder')}
            enterKeyHint="next"
            autoComplete="off"
            spellCheck={false}
            className="mt-2 h-12 w-full rounded-xl border border-foreground/15 bg-background/70 px-4 text-base outline-none transition-[border-color,box-shadow] focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06] dark:bg-white/[0.035]"
          />
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

function TeamStep({
  duetName,
  catalog,
  recommendations,
  selectedNames,
  onToggle,
  onRetry,
  onLoadMore,
}: {
  duetName: string
  catalog: CatalogState
  recommendations: RecommendationsState
  selectedNames: readonly string[]
  onToggle: (name: string) => void
  onRetry: () => void
  onLoadMore: () => void
}) {
  const t = useTranslations('duetOnboarding')
  const { recommended, rest } = partitionCatalog(catalog, recommendations)
  const agentCard = (agent: MarketplaceListingSummary, reason?: string) => {
    const selected = selectedNames.includes(agent.agentName)
    return (
      <MarketplaceAgentGalleryCard
        key={agent.agentName}
        listing={agent}
        instances={{ instances: [], installedCount: 0, issueCount: 0, hasUnreadUpdate: false }}
        // Picking, not browsing: the catalog is long and the user is meant to
        // scan it, so each card states what the agent does and stops there.
        compact
        {...(reason === undefined ? {} : { reason })}
        selection={{
          selected,
          label: t(selected ? 'deselectAgent' : 'selectAgent', { name: agent.title }),
          onToggle: () => onToggle(agent.agentName),
        }}
      />
    )
  }
  return (
    <div>
      <StepIntroduction title={t('teamTitle')} body={t('teamBody', { name: duetName })} />

      <div className="mb-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t('specialistCount', { name: duetName, count: selectedNames.length })}</span>
        <span>
          {catalog.status === 'ready' && catalog.agents.length > 1 ? (
            <>
              <span className="sm:hidden">
                {t(
                  (catalog.nextCursor !== null && catalog.nextCursor !== undefined) ||
                    catalog.moreError
                    ? 'catalogBrowseLoaded'
                    : 'catalogBrowse',
                  { count: catalog.agents.length },
                )}
              </span>
              <span className="hidden sm:inline">{t('marketplacePreview')}</span>
            </>
          ) : (
            t('marketplacePreview')
          )}
        </span>
      </div>

      {catalog.status === 'loading' ? (
        <div role="status" className="grid gap-4 sm:grid-cols-2">
          <span className="sr-only">{t('marketplaceLoading')}</span>
          {[0, 1, 2].map(index => (
            <div
              key={index}
              className="min-h-[17rem] animate-pulse rounded-2xl border border-foreground/5 bg-foreground/[0.045] motion-reduce:animate-none"
            />
          ))}
        </div>
      ) : catalog.status === 'error' ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-foreground/10 text-center">
          <p className="text-sm">{t('marketplaceError')}</p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-11 items-center rounded-lg border border-foreground/15 px-3 text-sm font-medium outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-foreground"
          >
            {t('retry')}
          </button>
        </div>
      ) : (
        <>
          {/* The "picked for you" rail: a skeleton band while the request is in
              flight, four personalized cards when it lands, and nothing at all
              on failure/empty — the plain catalog below never waits for it. */}
          {recommendations.status === 'pending' ? (
            <div data-onboarding-recommendations="pending" role="status" className="mb-7">
              <span className="sr-only">{t('recommendedRailLoading')}</span>
              <Skeleton aria-hidden className="mb-3 h-3 w-32 rounded-full" />
              {/* Scaffolded like the card that hydrates in — an empty pulsing
                  box above a fully rendered catalog reads as broken, not
                  loading. */}
              <div aria-hidden className="grid gap-4 sm:grid-cols-2">
                {[0, 1].map(index => (
                  <div
                    key={index}
                    className="min-h-28 rounded-2xl border border-foreground/5 bg-foreground/[0.02] p-5"
                  >
                    <Skeleton className="size-10 rounded-xl" />
                    <Skeleton className="mt-4 h-3 w-1/2 rounded-full" />
                    <Skeleton className="mt-2.5 h-3 w-4/5 rounded-full" />
                  </div>
                ))}
              </div>
            </div>
          ) : recommended.length > 0 ? (
            /* The one moment in the flow worth animating: the user waited on
               a model to read what they wrote, so the picks arrive rather
               than appear. Label first, then each card 60ms behind the last —
               enough to read as considered, short enough that the fourth card
               lands before a fast reader reaches it. */
            <motion.section
              data-onboarding-recommendations="ready"
              aria-label={t('recommendedRailTitle')}
              className="mb-7"
              initial="hidden"
              animate="shown"
              transition={{ staggerChildren: 0.06 }}
            >
              <motion.p
                variants={RAIL_ENTRANCE}
                className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground"
              >
                <Sparkle aria-hidden weight="fill" className="size-3.5 text-brand" />
                {t('recommendedRailTitle')}
              </motion.p>
              <div className="grid gap-4 sm:grid-cols-2">
                {recommended.map(({ listing, reason }) => (
                  <motion.div key={listing.agentName} variants={RAIL_ENTRANCE}>
                    {agentCard(listing, reason)}
                  </motion.div>
                ))}
              </div>
            </motion.section>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">{rest.map(agent => agentCard(agent))}</div>
          {(catalog.nextCursor !== null && catalog.nextCursor !== undefined) ||
          catalog.moreError ? (
            <button
              type="button"
              disabled={catalog.loadingMore}
              onClick={onLoadMore}
              className="mt-5 inline-flex min-h-11 items-center rounded-lg border border-foreground/15 px-4 text-sm font-medium outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-foreground disabled:opacity-60"
            >
              {catalog.loadingMore
                ? t('catalogLoadingMore')
                : catalog.moreError
                  ? t('catalogTryAgain')
                  : t('catalogLoadMore')}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

function ReadyStep({
  duetName,
  goal,
  goalSummary,
  answers,
  agentNames,
}: {
  duetName: string
  goal: GoalMode
  /** The goal echo: a preset goal's label, or the user's own words. */
  goalSummary?: string
  answers: Readonly<Partial<Record<OnboardingQuestionId, OnboardingChipId>>>
  /** The agents joining this workspace — picked on the team step, or brought by a campaign. */
  agentNames: readonly string[]
}) {
  const t = useTranslations('duetOnboarding')
  /**
   * Which face is being named. The stack overlaps by a third, so a face that
   * lifts clear of its neighbours is what tells you which one the name belongs
   * to — the name alone under a row of half-hidden marks would be a riddle.
   * Focus drives it as well as the pointer: this is the only place these agents
   * are introduced, and an introduction available only to a mouse is not one.
   */
  const [namedFace, setNamedFace] = useState<number>()
  // Duet leads, so it is face 0 and the agents follow it — the same order they
  // are rendered in, which is what lets the index alone identify a face without
  // a synthetic key that an agent slug could one day collide with.
  const faceNames = [duetName, ...agentNames.map(marketplaceSlugLabel)]
  return (
    <div>
      <div className="mb-6">
        <div className="flex -space-x-3" onPointerLeave={() => setNamedFace(undefined)}>
          <ReadyFace
            index={0}
            name={faceNames[0]!}
            named={namedFace === 0}
            onName={setNamedFace}
            entrance={{ opacity: 0, scale: 0.94 }}
            delay={0}
            className="relative z-10"
          >
            <Image
              src="/icons/duet-avatar.png"
              alt=""
              width={112}
              height={112}
              className="size-14 object-cover"
            />
          </ReadyFace>
          {agentNames.map((agentName, index) => (
            <ReadyFace
              key={agentName}
              index={index + 1}
              name={faceNames[index + 1]!}
              named={namedFace === index + 1}
              onName={setNamedFace}
              entrance={{ opacity: 0, x: -8, scale: 0.94 }}
              delay={0.05 + index * 0.05}
            >
              <MarketplaceAgentMark name={agentName} className="size-14" />
            </ReadyFace>
          ))}
        </div>
        {/* Reserved, not conditional: a row that appeared on hover would shove
            the whole celebration down a line the first time a pointer crossed a
            face. Absolute inside it so the outgoing name and the incoming one
            cross-fade in the same place — `mode="wait"` would make each name
            wait out the last one's exit, and sweeping the row would run a third
            of a second behind the pointer. */}
        <div className="relative mt-3 h-5" aria-hidden>
          <AnimatePresence>
            {namedFace === undefined ? null : (
              <motion.p
                key={namedFace}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14, ease: EASE_OUT_EXPO }}
                className="absolute inset-0 text-sm font-medium text-foreground"
              >
                {faceNames[namedFace]}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
      <StepIntroduction
        kicker={t('readyKicker')}
        title={t('readyTitle')}
        body={t('readyBody', { name: duetName, count: agentNames.length })}
      />
      <div className="divide-y divide-foreground/10 rounded-2xl border border-foreground/10 bg-background/45 px-4 dark:bg-white/[0.02]">
        {goalSummary === undefined ? null : (
          <SummaryRow label={goalSummary} detail={t('goalRow')}>
            {/* The answers hang off the goal they qualify, rather than
                standing as a third row: this is the last look a user gets at
                the purpose they assembled, and it belongs to that first tick. */}
            {goal.kind === 'preset' ? (
              <AnsweredChips
                goalId={goal.goalId}
                answers={answers}
                upTo={getOnboardingGoal(goal.goalId).questions.length}
                showGoal={false}
                className="mt-2"
              />
            ) : null}
          </SummaryRow>
        )}
        <SummaryRow
          label={t('specialistCount', { name: duetName, count: agentNames.length })}
          detail={t('teamRoster')}
        />
      </div>
    </div>
  )
}

/**
 * Where a face starts before it deals itself in. Spelled out rather than typed
 * as framer's own `TargetAndTransition`: that union is wide enough that `initial`
 * cannot narrow it, and the compiler gives up on the whole expression.
 */
type FaceEntrance = { opacity: number; scale: number; x?: number }

/**
 * One face in the ready stack — the entrance it arrives with, and the lift that
 * separates it from its neighbours while it is being named.
 *
 * Two nested motions on purpose. The entrance carries a stagger delay so the
 * faces deal out like cards; driving the lift from that same motion would make
 * every hover sit out the delay belonging to that face's place in the row, so
 * the fourth agent would answer a third of a second late.
 */
function ReadyFace({
  index,
  name,
  named,
  onName,
  entrance,
  delay,
  className,
  children,
}: {
  index: number
  name: string
  named: boolean
  onName: (index: number | undefined) => void
  entrance: FaceEntrance
  delay: number
  className?: string
  children: ReactNode
}) {
  return (
    <motion.span
      initial={entrance}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ duration: 0.22, delay, ease: EASE_OUT_EXPO }}
      className={cn('relative', className)}
      style={named ? { zIndex: 20 } : undefined}
    >
      <motion.span
        // Focusable because this is the only surface that ever says these
        // agents' names, and an introduction a keyboard cannot reach is not one.
        tabIndex={0}
        role="img"
        aria-label={name}
        onPointerEnter={() => onName(index)}
        onFocus={() => onName(index)}
        onBlur={() => onName(undefined)}
        animate={{ y: named ? -6 : 0, scale: named ? 1.06 : 1 }}
        transition={{ duration: 0.16, ease: EASE_OUT_EXPO }}
        className="block overflow-hidden rounded-[28%] border-[3px] border-background outline-none focus-visible:ring-2 focus-visible:ring-foreground"
      >
        {children}
      </motion.span>
    </motion.span>
  )
}

function SummaryRow({
  label,
  detail,
  children,
}: {
  label: string
  detail: string
  /** Optional extra beneath the caption — the goal row hangs its answers here. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-4 py-3.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background">
        <Check className="size-3.5" weight="bold" aria-hidden />
      </span>
      <div className="min-w-0">
        {/* Clamped because a "Write your own" goal echoes the user's words. */}
        <p className="line-clamp-2 text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        {children}
      </div>
    </div>
  )
}
