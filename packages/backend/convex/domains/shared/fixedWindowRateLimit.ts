interface FixedWindowRow {
  _id: unknown
  windowStart: number
  count: number
}

interface FixedWindowState {
  windowStart: number
  count: number
  updatedAt: number
}

export async function consumeFixedWindow<T extends FixedWindowRow>(args: {
  limit: number
  windowMs: number
  now: number
  load: () => Promise<T | null>
  insert: (state: FixedWindowState) => Promise<unknown>
  patch: (row: T, state: FixedWindowState) => Promise<unknown>
}): Promise<
  { ok: true; remaining: number; resetAt: number } | { ok: false; retryAfterSeconds: number }
> {
  const windowStart = Math.floor(args.now / args.windowMs) * args.windowMs
  const existing = await args.load()
  if (existing === null) {
    await args.insert({ windowStart, count: 1, updatedAt: args.now })
    return { ok: true, remaining: args.limit - 1, resetAt: windowStart + args.windowMs }
  }
  if (existing.windowStart !== windowStart) {
    await args.patch(existing, { windowStart, count: 1, updatedAt: args.now })
    return { ok: true, remaining: args.limit - 1, resetAt: windowStart + args.windowMs }
  }
  // A spent window is query-only. Counting past the budget changes no answer,
  // and the caller doing the counting is a client already flooding: writing on
  // its every request is what turns one hot document into a retry storm the
  // surrounding mutation loses outright (Convex error #1).
  if (existing.count >= args.limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + args.windowMs - args.now) / 1000)),
    }
  }
  const count = existing.count + 1
  await args.patch(existing, { windowStart, count, updatedAt: args.now })
  return { ok: true, remaining: args.limit - count, resetAt: windowStart + args.windowMs }
}
