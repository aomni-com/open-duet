import type { GenericMutationCtx } from 'convex/server'
import type { GenericId, Value } from 'convex/values'

import type { DataModel, Id } from '../../_generated/dataModel'
import { isBlockedEmailDomain } from '../signupAbuse/blockedEmailDomains'
import { updateCanonicalUserIdentity } from './directoryRefresh'
import { EPHEMERAL_DEFAULT_TTL_MS } from './ephemeralModel'
import { cleanDisplayName, cleanOptionalString, normalizeEmail } from './identity'
import { classifySignupIdentity } from './signupIdentity'

type MutationCtx = GenericMutationCtx<DataModel>

interface AuthProfile {
  email?: string
  name?: string
  image?: string
  emailVerified?: boolean
  emailVerificationTime?: number
}

interface CreateOrUpdateUserArgs {
  existingUserId: GenericId<'users'> | null
  type: 'oauth' | 'credentials' | 'email' | 'phone' | 'verification'
  profile: AuthProfile
}

interface ParsedCredentialsProfile {
  providerAccountId: string
  email: string
  name?: string
  image?: string
  emailVerified: boolean
}

export async function createOrLinkUserForAuth(
  ctx: MutationCtx,
  args: CreateOrUpdateUserArgs,
): Promise<GenericId<'users'>> {
  // Convex Auth calls this callback from the mutation that creates the user,
  // account, and verification code. Refuse here, before the first insert, so
  // direct browser/Convex calls cannot leave auth rows behind and rely on the
  // later mail callback to notice the blocked domain.
  if (
    (args.type === 'email' || args.type === 'verification') &&
    typeof args.profile.email === 'string' &&
    isBlockedEmailDomain(args.profile.email)
  ) {
    throw new Error('Signup is not allowed for this email domain')
  }
  const now = Date.now()
  const email = normalizeEmail(args.profile.email)
  const emailVerified =
    args.profile.emailVerified === true ||
    typeof args.profile.emailVerificationTime === 'number' ||
    args.type === 'email' ||
    args.type === 'verification'
  const name = cleanDisplayName(args.profile.name)
  const image = cleanOptionalString(args.profile.image)
  const [firstName, lastName] = splitName(name)

  let userId = args.existingUserId as Id<'users'> | null
  if (userId === null) {
    const existing = await ctx.db
      .query('users')
      .withIndex('by_email', q => q.eq('email', email))
      .unique()
    if (existing !== null && !emailVerified) {
      throw new Error('Cannot link unverified email to an existing user')
    }
    userId = existing?._id ?? null
  }

  if (userId === null) {
    userId = await ctx.db.insert('users', {
      email,
      name,
      image,
      firstName,
      lastName,
      emailVerificationTime: emailVerified ? now : undefined,
      paidCreditBalanceMicroUsd: 0,
      monthlyCreditBalanceMicroUsd: 0,
      memberDirectoryRevision: 0,
      createdAt: now,
      updatedAt: now,
      // Accounts born on a configured test inbox expire on their own. Live
      // journeys sign up through the real sign-in page, where there is no
      // `ephemeral` option to pass, so their workspaces and VMs used to
      // outlive the run forever — and a journey that died mid-run leaked
      // whether or not its cleanup was written correctly. Disposability
      // belongs at birth (the one moment it can be decided) rather than in
      // every journey's finally block. Inert in production, which never
      // configures a test inbox. An explicit `ephemeral` from login-as still
      // wins: it patches this default afterwards.
      ...(classifySignupIdentity(email).disposable
        ? { ephemeralExpiresAt: now + EPHEMERAL_DEFAULT_TTL_MS }
        : {}),
    })
  } else {
    const currentUser = await ctx.db.get(userId)
    if (currentUser === null) throw new Error('Auth user disappeared during profile update')
    const directoryName = name ?? currentUser.name
    const retainedProfile = profileFieldsToKeep({ name, image, firstName, lastName })
    await updateCanonicalUserIdentity(ctx, {
      user: currentUser,
      email,
      name: directoryName,
      now,
      patch: {
        ...(retainedProfile.image === undefined ? {} : { image: retainedProfile.image }),
        ...(retainedProfile.firstName === undefined
          ? {}
          : { firstName: retainedProfile.firstName }),
        ...(retainedProfile.lastName === undefined ? {} : { lastName: retainedProfile.lastName }),
        ...(emailVerified ? { emailVerificationTime: now } : {}),
      },
    })
  }

  return userId
}

/**
 * The profile fields a *returning* sign-in is allowed to write.
 *
 * Absent is not empty. Providers carry different things: Google supplies a
 * display name and an avatar URL, a magic link supplies neither. Patching all
 * four unconditionally meant the second sign-in erased what the first had
 * stored — sign in with Google, then once by email, and the avatar and the
 * display name were gone.
 *
 * So a field a provider did not send is left alone, and one it *did* send still
 * wins. Only the insert path writes the absent case, because there is nothing
 * there to lose.
 */
export function profileFieldsToKeep(fields: {
  name?: string
  image?: string
  firstName?: string
  lastName?: string
}): { name?: string; image?: string; firstName?: string; lastName?: string } {
  return {
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(fields.image === undefined ? {} : { image: fields.image }),
    ...(fields.firstName === undefined ? {} : { firstName: fields.firstName }),
    ...(fields.lastName === undefined ? {} : { lastName: fields.lastName }),
  }
}

export function profileFromCredentials(
  credentials: Partial<Record<string, Value | undefined>>,
): ParsedCredentialsProfile {
  const email = normalizeEmail(
    typeof credentials.email === 'string' ? credentials.email : undefined,
  )
  const providerAccountId =
    typeof credentials.providerAccountId === 'string' && credentials.providerAccountId.trim()
      ? credentials.providerAccountId.trim()
      : email
  return {
    providerAccountId,
    email,
    name: cleanDisplayName(typeof credentials.name === 'string' ? credentials.name : undefined),
    image: cleanOptionalString(
      typeof credentials.image === 'string' ? credentials.image : undefined,
    ),
    emailVerified: credentials.emailVerified !== false,
  }
}

function splitName(name: string | undefined): [string | undefined, string | undefined] {
  if (!name) return [undefined, undefined]
  const parts = name.split(/\s+/)
  return [parts[0], parts.length > 1 ? parts.slice(1).join(' ') : undefined]
}
