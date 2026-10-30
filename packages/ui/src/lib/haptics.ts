import { WebHaptics, type HapticInput } from 'web-haptics'

export type HapticPresetName =
  | 'success'
  | 'warning'
  | 'error'
  | 'light'
  | 'medium'
  | 'heavy'
  | 'soft'
  | 'rigid'
  | 'selection'
  | 'nudge'
  | 'buzz'

export type HapticFeedback = HapticPresetName | Exclude<HapticInput, string>
export type HapticFeedbackProp = HapticFeedback | false | null

type DefaultPreventableEvent = {
  defaultPrevented?: boolean
}

const HAPTIC_DEDUPE_MS = 40
const TOUCH_POINTER_QUERY = '(hover: none), (pointer: coarse)'

let haptics: WebHaptics | null = null
let lastHapticAt = 0

function isTouchHapticsEnvironment() {
  if (typeof window === 'undefined') {
    return false
  }

  return (
    window.navigator.maxTouchPoints > 0 || window.matchMedia?.(TOUCH_POINTER_QUERY).matches === true
  )
}

function getHaptics() {
  if (!isTouchHapticsEnvironment()) {
    return null
  }

  haptics ??= new WebHaptics()
  return haptics
}

export function triggerHapticFeedback(feedback: HapticFeedbackProp | undefined = 'light') {
  if (!feedback) {
    return
  }

  if (!isTouchHapticsEnvironment()) {
    return
  }

  const now = window.performance?.now() ?? Date.now()
  if (now - lastHapticAt < HAPTIC_DEDUPE_MS) {
    return
  }

  lastHapticAt = now
  void getHaptics()
    ?.trigger(feedback)
    .catch(() => {})
}

export function composeHapticEventHandler<Event extends DefaultPreventableEvent>(
  handler: ((event: Event) => void) | undefined,
  feedback: HapticFeedbackProp | undefined = 'light',
) {
  return (event: Event) => {
    handler?.(event)
    if (!event.defaultPrevented) {
      triggerHapticFeedback(feedback)
    }
  }
}

export function composeHapticValueChangeHandler<Args extends unknown[]>(
  handler: ((...args: Args) => void) | undefined,
  feedback: HapticFeedbackProp | undefined = 'selection',
) {
  return (...args: Args) => {
    handler?.(...args)
    triggerHapticFeedback(feedback)
  }
}
