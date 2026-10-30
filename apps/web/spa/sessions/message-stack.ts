import { isSameInputSender } from '@repo/contract'

import type { ProjectedMessage } from './projection'

/**
 * How long one voice can keep talking before the next message reads as a new
 * turn rather than a continuation of the last one.
 */
const GROUPING_WINDOW_MS = 3 * 60 * 1000

/** Where a message sits in its stack: the head shows the author, the tail closes it. */
export type MessageStackPosition = {
  leading: boolean
  trailing: boolean
}

function sameVoice(previous: ProjectedMessage, current: ProjectedMessage): boolean {
  if (previous.role !== current.role) return false
  if (previous.role === 'input' && current.role === 'input') {
    // A prompt, a note, and an answer are three different acts even from one
    // person. Folding them together would hide which one starts a turn.
    return previous.source === current.source && isSameInputSender(previous.sender, current.sender)
  }
  return true
}

function withinWindow(previous: ProjectedMessage, current: ProjectedMessage): boolean {
  const from = previous.role === 'input' ? previous.createdAt : undefined
  const to = current.role === 'input' ? current.createdAt : undefined
  // Agent turns carry no clock, so an untimed pair stays continuous rather
  // than being split by data the projection never had.
  if (from === undefined || to === undefined) return true
  return Math.abs(to - from) <= GROUPING_WINDOW_MS
}

function continues(previous: ProjectedMessage, current: ProjectedMessage): boolean {
  return sameVoice(previous, current) && withinWindow(previous, current)
}

/** One position per message, in the order they were given. */
export function messageStack(
  messages: readonly ProjectedMessage[],
): readonly MessageStackPosition[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1]
    const next = messages[index + 1]
    return {
      leading: previous === undefined || !continues(previous, message),
      trailing: next === undefined || !continues(message, next),
    }
  })
}
