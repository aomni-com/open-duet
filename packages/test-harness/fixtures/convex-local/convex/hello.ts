import { v } from 'convex/values'

import { query } from './_generated/server'

export const greeting = query({
  args: {},
  handler: () => 'hello from local convex',
})

export const echo = query({
  args: {
    value: v.string(),
  },
  handler: (_ctx, args) => args.value,
})
