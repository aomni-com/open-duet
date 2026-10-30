'use node'

import { generateText } from 'ai'
import { makeFunctionReference, type FunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { internalAction } from '../../_generated/server'
import { generateTitleWithTimeout } from './titleGenerationCore'
import { SESSION_TITLE_MODEL, SESSION_TITLE_TIMEOUT_MS } from './titles'

export const generateSessionTitle = internalAction({
  args: {
    workspaceId: v.id('workspaces'),
    sessionId: v.id('agentSessions'),
    prompt: v.string(),
    attemptId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const title = await generateTitleWithTimeout(async abortSignal => {
      const result = await generateText({
        model: SESSION_TITLE_MODEL,
        system:
          'Write a concise title for this AI work session. Return only the title, at most eight words, without quotes or punctuation at the end.',
        prompt: args.prompt,
        abortSignal,
      })
      return result.text
    }, SESSION_TITLE_TIMEOUT_MS)
    await ctx.runMutation(fnMutation('domains/agentSessions/model:finishTitleAttempt'), {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      attemptId: args.attemptId,
      title,
    })
    return null
  },
})

function fnMutation(name: string): FunctionReference<'mutation', 'internal'> {
  return makeFunctionReference(name) as unknown as FunctionReference<'mutation', 'internal'>
}
