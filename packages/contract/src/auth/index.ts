import { z } from 'zod'

import { DUET_API_KEY_PREFIX } from '../api-keys/index'
import { HUMAN_ENTRY_CODE_PATTERN } from '../entry-code/index'
import { ApiRateLimitErrorSchema } from '../http/index'
import { WorkspaceSlugSchema } from '../slug/index'
import { WorkspaceRoleSchema } from '../workspaces/index'

export * from './credential-kind'

export const AUTH_SIGN_IN_PATH = '/sign-in'
export const LOCAL_AUTH_ORIGIN = 'http://localhost:3000'
export const MAGIC_LINK_CALLBACK_PATH = '/auth/magic-link/callback'

/**
 * How long a sign-in code lives, for both the record that issued it and the
 * credential proof it redeems.
 *
 * One number because the two are owned by different systems — Duet owns the
 * request, `@convex-dev/auth` owns the verification code — and a code that
 * outlives its request is a window in which nothing is counting attempts.
 */
export const SIGN_IN_CODE_TTL_SECONDS = 600

// `POST /v1/admin/login-as` — the admin rail that mints an impersonation
// session against the programmatic-login secret. Deliberately absent from the
// public endpoint registry; the schemas still live here so the route and its
// callers share one shape instead of hand-mirroring it.
export const AdminLoginAsRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email())
    .transform(email => email.toLowerCase()),
  workspaceSlug: WorkspaceSlugSchema.optional(),
  ttlSeconds: z.number().finite().positive().optional(),
  create: z.boolean().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  // Disposable identity, only meaningful together with `create`: `true` buys
  // the 6h default lifetime, an epoch-ms timestamp names the deletion moment.
  // Capped at 24h; the sweep then erases the user and every workspace they
  // own, and their VMs carry the `duet-ephemeral` tag from birth.
  ephemeral: z.union([z.literal(true), z.number().finite().positive()]).optional(),
})
export type AdminLoginAsRequest = z.infer<typeof AdminLoginAsRequestSchema>

export const AdminLoginAsResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.number().int().positive(),
  userId: z.string(),
  workspaceSlug: WorkspaceSlugSchema,
  created: z.boolean(),
})
export type AdminLoginAsResponse = z.infer<typeof AdminLoginAsResponseSchema>

// ---------------------------------------------------------------------------
// Agent sign-in — `POST /v1/auth/email/{start,verify}`, both `scope: 'public'`.
//
// Unlike `AdminLoginAs*` above, these schemas are registered in the public
// endpoint registry, and `apps/docs`' `verify:endpoints` renders every
// registered schema through `toJSONSchema` in both directions. So: **no
// `.transform()`, no `.pipe()`** here. Normalization is spelled with zod4
// overwrites (`.trim()`, `.toLowerCase()`), which are checks rather than a
// second type and therefore render.
// ---------------------------------------------------------------------------

/**
 * The handle `start` hands back and `verify` hands in. Hex, matching the
 * `[a-f0-9]` alphabet the device-code rail already uses for machine-read
 * identifiers — the human-read alphabet is `HumanEntryCodeSchema`'s, and these
 * two are never confused because only one of them is ever typed.
 *
 * One schema rather than the regex written twice: `start` returning an id that
 * `verify` would reject is exactly the bug a second spelling invites.
 */
export const SignInRequestIdSchema = z.string().regex(/^req_[a-f0-9]{32}$/)

/**
 * Email validated *after* trimming and lowercasing, rather than
 * `z.email().trim().toLowerCase()` as first drafted: a format check belongs to
 * the string type itself and so runs before any check appended to it, which
 * means the drafted spelling rejects ` casey@example.com ` instead of trimming
 * it. `.check(z.email())` appends the format as a check, so it sees the
 * normalized value. Both spellings are transform-free and render identically as
 * JSON Schema; only this one actually trims.
 */
const NormalizedEmailSchema = z.string().trim().toLowerCase().check(z.email())

export const EmailSignInStartRequestSchema = z.object({
  email: NormalizedEmailSchema,
  // Named in the email so the human can see which agent asked.
  client_name: z.string().trim().min(1).max(64).optional(),
})
export type EmailSignInStartRequest = z.infer<typeof EmailSignInStartRequestSchema>

export const EmailSignInStartResponseSchema = z.object({
  request_id: SignInRequestIdSchema,
  expires_in: z.number().int().positive(),
})
export type EmailSignInStartResponse = z.infer<typeof EmailSignInStartResponseSchema>

export const EmailSignInVerifyRequestSchema = z.object({
  request_id: SignInRequestIdSchema,
  // Upper-cased before validating, the way the device rail's `normalizeUserCode`
  // does: a human who types `rnp4-4y37` made no mistake worth a 400.
  code: z.string().trim().toUpperCase().regex(HUMAN_ENTRY_CODE_PATTERN),
  // New account only; ignored for a human who already exists.
  name: z.string().trim().min(1).max(200).optional(),
  workspace_name: z.string().trim().min(1).max(100).optional(),
  // The returning human's answer to a `workspace_ambiguous` refusal.
  workspace_slug: WorkspaceSlugSchema.optional(),
})
export type EmailSignInVerifyRequest = z.infer<typeof EmailSignInVerifyRequestSchema>

/**
 * One workspace a signing-in human could bind to — the payload of a
 * `workspace_ambiguous` refusal, and the input the resolution rule reasons over.
 */
export const SignInWorkspaceChoiceSchema = z.object({
  slug: WorkspaceSlugSchema,
  name: z.string(),
  role: WorkspaceRoleSchema,
})
export type SignInWorkspaceChoice = z.infer<typeof SignInWorkspaceChoiceSchema>

export const EmailSignInVerifyResponseSchema = z.object({
  access_token: z.string().startsWith(DUET_API_KEY_PREFIX),
  token_type: z.literal('bearer'),
  prefix: z.string().startsWith(DUET_API_KEY_PREFIX),
  scopes: z.array(z.string()).min(1),
  workspace: z.object({ slug: WorkspaceSlugSchema, name: z.string() }),
  // Whether this call created the account. A boolean until a caller needs to
  // tell "created the workspace too" apart from "created only the account".
  created: z.boolean(),
})
export type EmailSignInVerifyResponse = z.infer<typeof EmailSignInVerifyResponseSchema>

export const EmailSignInErrorSchema = z.discriminatedUnion('error', [
  z.object({
    error: z.literal('invalid_code'),
    attempts_remaining: z.number().int().nonnegative(),
  }),
  z.object({
    error: z.literal('workspace_ambiguous'),
    workspaces: z.array(SignInWorkspaceChoiceSchema),
  }),
  z.object({ error: z.literal('expired') }),
  // Both of these are emitted by the route and were missing: `forbidden` when
  // the named workspace is not the caller's, and `invalid_request` when the
  // body does not parse. A published union that omits a refusal the endpoint
  // returns is worse than none — it teaches an agent the shape is exhaustive.
  z.object({ error: z.literal('forbidden') }),
  z.object({ error: z.literal('invalid_request') }),
  // Not a bespoke member: this is the same refusal every rate-limited endpoint
  // in the API emits, from one owner. An agent that learns to parse a 429 here
  // parses it everywhere. Its `retryAfterSeconds` is camelCase while the rest
  // of this rail is snake_case — inherited, not new; the device endpoints
  // already pair snake_case bodies with this exact refusal.
  ApiRateLimitErrorSchema,
])
export type EmailSignInError = z.infer<typeof EmailSignInErrorSchema>

/**
 * What a verify attempt concluded, before anything decides what that means over
 * HTTP.
 *
 * Lives here rather than in either half because both halves need it: the Convex
 * action returns it and the route maps it to a status. Hand-mirroring the union
 * in `apps/api` made the route's exhaustive `switch` exhaustive over the copy —
 * a sixth outcome would have type-checked while the route fell off the end and
 * returned nothing.
 */
export type SignInVerifyOutcome =
  | {
      kind: 'issued'
      accessToken: string
      prefix: string
      scopes: string[]
      workspace: { slug: string; name: string }
      created: boolean
    }
  | { kind: 'ambiguous'; workspaces: SignInWorkspaceChoice[] }
  | { kind: 'forbidden' }
  | { kind: 'invalid_code'; attemptsRemaining: number }
  | { kind: 'expired' }

export type SignInWorkspaceResolution =
  | { kind: 'bind'; slug: string }
  | { kind: 'create' }
  | { kind: 'ambiguous'; workspaces: readonly SignInWorkspaceChoice[] }
  | { kind: 'forbidden' }

/**
 * Which workspace a sign-in binds its key to — the whole rule, DB-free, so the
 * `workspace_ambiguous` refusal can be decided *before* the code is redeemed.
 * `auth:signIn` consumes the code on redemption, so a 409 raised after it would
 * hand the caller a list they can no longer act on.
 *
 * `memberships` is the caller's *live* workspaces. Empty therefore covers two
 * populations that need the same answer: an email with no account at all, and a
 * returning human whose every workspace was archived. Both get a new one.
 *
 * A requested slug is answered first and never falls through: a caller who
 * named a workspace they do not belong to is refused, not quietly bound to
 * something else or handed a fresh workspace under a name that may be someone
 * else's.
 */
export function resolveSignInWorkspace(args: {
  requestedSlug?: string
  memberships: readonly SignInWorkspaceChoice[]
}): SignInWorkspaceResolution {
  const { requestedSlug, memberships } = args
  if (requestedSlug !== undefined)
    return memberships.some(workspace => workspace.slug === requestedSlug)
      ? { kind: 'bind', slug: requestedSlug }
      : { kind: 'forbidden' }
  if (memberships.length === 0) return { kind: 'create' }
  if (memberships.length === 1) return { kind: 'bind', slug: memberships[0]!.slug }
  return { kind: 'ambiguous', workspaces: memberships }
}
