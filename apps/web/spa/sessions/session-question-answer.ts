import type { AgentTurnQuestion } from '@repo/contract'
import type { ComposeBarSessionQuestionSelection } from '@repo/ui/components/compose-bar'

export function supportsQuestionOptionPanel(questions: readonly AgentTurnQuestion[]): boolean {
  return questions.length > 0 && questions.every(question => question.options.length > 0)
}

export function serializeSessionQuestionAnswers(
  questions: readonly AgentTurnQuestion[],
  selections: readonly ComposeBarSessionQuestionSelection[],
): string {
  const selectedByQuestion = new Map(
    selections.map(selection => [selection.questionIndex, selection.optionIndexes]),
  )
  const answered = questions.flatMap((question, questionIndex) => {
    const selected = [...(selectedByQuestion.get(questionIndex) ?? [])]
      .sort((left, right) => left - right)
      .flatMap(optionIndex => question.options[optionIndex]?.label ?? [])
    if (selected.length === 0) return []
    const answer = selected.join(', ')
    return questions.length === 1
      ? [answer]
      : [`${question.header?.trim() || question.question.trim()}: ${answer}`]
  })
  return answered.join('\n')
}
