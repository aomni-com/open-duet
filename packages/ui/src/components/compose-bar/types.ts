import type { ReactNode } from 'react'

import type { QualitySelectorProps } from '../quality-selector'
import type { ComposeBarSuggestionItem } from './compose-bar-mention-extension'

export type ComposeBarOption<Id extends string = string> = {
  /** Opaque identifier owned by the consumer. */
  id: Id
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
}

export type ComposeBarPicker<Id extends string = string> = {
  label: string
  value: Id
  options: readonly ComposeBarOption<Id>[]
  onValueChange: (id: Id) => void
  icon?: ReactNode
  disabled?: boolean
}

export type ComposeBarQualityControl<Id extends string = string> = Omit<
  QualitySelectorProps<Id>,
  'appearance' | 'onAfterSelect'
>

export type ComposeBarAiToggle = {
  label: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  icon: ReactNode
  disabled?: boolean
}

/**
 * One skill the composer can insert. `name` is what the user types after `/`
 * and `path` is carried into the emitted tag; both are opaque here — the
 * primitive never resolves, installs, or validates a skill. `scopeLabel` is
 * consumer-localized text (e.g. "Global"), so `@repo/ui` learns no scope
 * vocabulary.
 */
export type ComposeBarSkill = ComposeBarSuggestionItem & {
  path: string
}

/** Labels any trigger's picker needs; each capability supplies its own. */
export type ComposeBarPickerLabels = {
  /** Accessible name for the picker list. */
  list: string
  loading: string
  empty: string
  /** Shown when the list could not be read at all — never as "you have none". */
  unavailable: string
}

/** An explicitly requested next page; loaded rows remain usable in every state. */
export type ComposeBarPickerContinuation = {
  loading: boolean
  /** The continuation failed. Its action retries the same cursor. */
  unavailable: boolean
  onLoadMore: () => void
  labels: {
    loadMore: string
    loading: string
    retry: string
  }
}

type ComposeBarPickerCapability<Item extends ComposeBarSuggestionItem> = {
  items: readonly Item[]
  labels: ComposeBarPickerLabels
  loading?: boolean
  /** The list could not be read. Distinct from an empty list, which is an answer. */
  unavailable?: boolean
  continuation?: ComposeBarPickerContinuation
  onOpen?: () => void
}

/**
 * The `/` picker capability. Omit it and typing `/` is ordinary text.
 *
 * `onOpen` fires when the picker appears, which is the consumer's cue to
 * refresh: skills are files someone may have installed a minute ago.
 */
export type ComposeBarSkills = ComposeBarPickerCapability<ComposeBarSkill>

/**
 * One agent the composer can name. `name` is what a reader calls it and
 * `slug` is what everything else does — the address the agent uses to reach
 * it, and the only thing telling two colleagues with the same name apart, so
 * both are shown. `path` is the agent's folder, absent for the drive root.
 *
 * The consumer decides which rows are pickable and says why: this primitive
 * knows nothing about onboarding.
 */
export type ComposeBarAgent = ComposeBarSuggestionItem & {
  slug: string
  path?: string
}

/**
 * The `@` picker capability. Omit it and typing `@` is ordinary text.
 *
 * The list is the agents this session can already reach, decided upstream and
 * ordered there. The composer neither walks the hierarchy nor filters it, and
 * a row's standing — whose report it is, whose peer — reaches it as a
 * `scopeLabel` the consumer has already put into words.
 */
export type ComposeBarAgents = ComposeBarPickerCapability<ComposeBarAgent>

export type ComposeBarAttachmentStatus = {
  label: string
  tone?: 'neutral' | 'danger'
  display?: 'overlay' | 'badge'
}

export type ComposeBarAttachment = {
  /** Opaque identifier used for keys and removal events. */
  id: string
  name: string
  meta?: string
  status?: ComposeBarAttachmentStatus
  preview?:
    | { kind: 'image'; src: string }
    | { kind: 'text'; text: string }
    | { kind: 'table'; rows: readonly (readonly string[])[] }
}

export type ComposeBarAction = {
  id: string
  label: string
  icon: ReactNode
  onSelect: () => void
  active?: boolean
  disabled?: boolean
}

/* No `multiple` switch: the composer is a batch surface, so the picker always
   opens multi-select. The escape hatch existed only for a fixture, and a
   fixture that opens a different picker from the product is how "it only lets
   me pick one" survives a code read. */
export type ComposeBarFileInput = {
  accept?: string
  label?: string
}

export type ComposeBarAttachments = {
  items: readonly ComposeBarAttachment[]
  onRemove?: (attachment: ComposeBarAttachment) => void
  onRetry?: (attachment: ComposeBarAttachment) => void
  onFilesSelected?: (files: readonly File[]) => boolean | void
  fileInput?: ComposeBarFileInput
  renderPreview?: (attachment: ComposeBarAttachment) => ReactNode
  dropLabel?: string
  retryLabel?: string
  getRemoveLabel?: (attachment: ComposeBarAttachment) => string
}

export type ComposeBarInput = {
  /** Accessible name for the message field. */
  label: string
  id?: string
  placeholder?: string
  autoFocus?: boolean
  readOnly?: boolean
  spellCheck?: boolean
  autoCapitalize?: string
  onKeyDown?: (event: KeyboardEvent) => void
  variant?: 'default' | 'prominent'
  minHeight?: number
  maxHeight?: number
}

export type ComposeBarSubmit = {
  /** Overrides the default non-empty-message-or-attachment readiness rule. */
  enabled?: boolean
  /** A known external blocker, distinct from an empty or still-uploading draft. */
  blocked?: boolean
  onEnter?: boolean
  label?: string
  submittingLabel?: string
  /** Brief outcome copy shown after a deliberate hover or keyboard focus. */
  tooltip?: string
  /** Explains why the action is not ready yet. */
  disabledTooltip?: string
  /** Explains the external blocker represented by `blocked`. */
  blockedTooltip?: string
  /** Describes the in-flight action without replacing the accessible button name. */
  submittingTooltip?: string
}

export type ComposeBarSessionPhase = 'working' | 'waiting' | 'sleeping'

export type ComposeBarSessionTodo = {
  id: string
  label: string
  status: 'pending' | 'active' | 'complete' | 'failed'
}

export type ComposeBarSessionTodos = {
  label: string
  items: readonly ComposeBarSessionTodo[]
  statusLabels: Record<ComposeBarSessionTodo['status'], string>
  expanded: boolean
  expandLabel: string
  collapseLabel: string
  onExpandedChange: (expanded: boolean) => void
}

export type ComposeBarSessionAction = {
  label: string
  pendingLabel?: string
  ariaLabel?: string
  title?: string
  pending?: boolean
  disabled?: boolean
  error?: string
  onSelect: () => void
}

export type ComposeBarSessionQuestionOption = {
  label: string
  description?: string
}

export type ComposeBarSessionQuestion = {
  header?: string
  question: string
  options: readonly ComposeBarSessionQuestionOption[]
  multiSelect?: boolean
}

export type ComposeBarSessionQuestionSelection = {
  questionIndex: number
  optionIndexes: readonly number[]
}

export type ComposeBarSessionQuestionLabels = {
  question: string
  fallback: (index: number) => string
  pending: string
  pendingWithCount: (index: number, count: number) => string
  collapse: string
  expand: string
  previous: string
  next: string
  submit: string
  doneNext: string
  doneSubmit: string
  submitError: string
}

export type ComposeBarSessionQuestions = {
  key: string
  items: readonly ComposeBarSessionQuestion[]
  labels: ComposeBarSessionQuestionLabels
  submitting?: boolean
  onSubmit: (selections: readonly ComposeBarSessionQuestionSelection[]) => Promise<void>
}

export type ComposeBarSession = {
  key: string
  phase: ComposeBarSessionPhase
  label: string
  /**
   * Optional utility class (typically a text color) applied to the status
   * icon so a phase can carry the product's semantic status color. Supplied by
   * the consumer to keep the package palette-agnostic; omit to inherit the
   * muted header treatment.
   */
  tone?: string
  hint?: string
  question?: string
  questions?: ComposeBarSessionQuestions
  todos?: ComposeBarSessionTodos
  /** Product-owned canonical identity, rendered decoratively during the working phase. */
  avatar?: ReactNode
  action?: ComposeBarSessionAction
}

export type ComposeBarClassNames = {
  root?: string
  surface?: string
  input?: string
}

export type ComposeBarSubmitPayload<
  QualityId extends string = string,
  ReasoningId extends string = string,
> = {
  value: string
  qualityId?: QualityId
  reasoningId?: ReasoningId
  attachments: readonly ComposeBarAttachment[]
}

export type ComposeBarHandle = {
  focus: () => void
}

export type ComposeBarProps<
  QualityId extends string = string,
  ReasoningId extends string = string,
> = {
  /** Controlled message value. The compose bar never persists or clears it. */
  value: string
  onValueChange: (value: string) => void
  onSubmit: (payload: ComposeBarSubmitPayload<QualityId, ReasoningId>) => void
  input: ComposeBarInput
  /** Turns the whole surface off — for a composer that has nowhere to send. */
  disabled?: boolean
  /** A send is in flight: Send waits for it, while the draft stays editable. */
  submitting?: boolean
  submit?: ComposeBarSubmit
  quality?: ComposeBarQualityControl<QualityId>
  reasoning?: ComposeBarPicker<ReasoningId>
  session?: ComposeBarSession
  /** Opaque `/` skill picker. Omit it and `/` stays ordinary text. */
  skills?: ComposeBarSkills
  /** Opaque `@` agent picker. Omit it and `@` stays ordinary text. */
  agents?: ComposeBarAgents
  aiToggle?: ComposeBarAiToggle
  attachments?: ComposeBarAttachments
  actions?: readonly ComposeBarAction[]
  status?: ReactNode
  /** Consumer-owned context control rendered immediately before the submit button. */
  submitAccessory?: ReactNode
  banner?: ReactNode
  classNames?: ComposeBarClassNames
}
