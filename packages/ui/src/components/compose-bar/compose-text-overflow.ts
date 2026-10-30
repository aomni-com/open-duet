export const COMPOSE_INLINE_TEXT_LIMIT = 10_000

export function shouldAttachPastedText({
  currentTextLength,
  pastedTextLength,
}: {
  currentTextLength: number
  pastedTextLength: number
}) {
  return pastedTextLength > 0 && currentTextLength + pastedTextLength > COMPOSE_INLINE_TEXT_LIMIT
}

export function createComposeOverflowFileName(now = new Date()) {
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
    .join('')
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, '0'))
    .join('')
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0')
  return `pasted-text-${date}-${time}-${milliseconds}.txt`
}
