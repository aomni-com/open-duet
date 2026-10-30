/**
 * Author-supplied names, made safe to drop into a generated markdown prompt.
 *
 * Neither `AppNameSchema` nor `AgentNameSchema` restricts characters — both
 * only trim and bound length — so a name is arbitrary user text arriving in a
 * document the model reads as instructions. A backtick closes a code span, a
 * newline starts a new block, and either can turn a row into something that no
 * longer reads as a row.
 *
 * One owner for both renderers: the apps block and the agents block must agree,
 * because the moment they diverge only one of them is safe and nobody notices
 * which.
 */
export function sanitizePromptLabel(
  value: string,
  options: { fallback: string; maxLength: number },
): string {
  const sanitized = value.replace(/[\r\n\t`]/g, '').slice(0, options.maxLength)
  return sanitized.length === 0 ? options.fallback : sanitized
}
