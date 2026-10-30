import { Avatar, Style } from '@dicebear/core'
import definition from '@dicebear/styles/notionists-neutral.json' with { type: 'json' }
import Image from 'next/image'
import { useMemo, type ComponentPropsWithoutRef } from 'react'

import { cn } from '@repo/ui/lib/utils'

/* A drawn face per person, from their own name. It used to be the first letter
   of that name on a slate gradient, which made two people in the same workspace
   whose names start with the same letter into the same badge — an avatar that
   cannot tell anyone apart is a coloured square. */
const userStyle = new Style(definition)

export type IdentityAvatarKind = 'agent' | 'user'

export function IdentityAvatarFrame({
  kind,
  className,
  ...props
}: ComponentPropsWithoutRef<'span'> & { kind: IdentityAvatarKind }) {
  return (
    <span
      data-identity-avatar={kind}
      data-avatar-shape="squarish"
      className={cn('relative shrink-0 overflow-hidden rounded-[28%]', className)}
      {...props}
    />
  )
}

export function UserAvatar({
  name,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<'span'>, 'children'> & { name: string }) {
  const src = useMemo(() => createUserAvatarDataUri(name), [name])
  return (
    <IdentityAvatarFrame
      kind="user"
      {...props}
      aria-hidden
      className={cn(
        /* The art is black line work on transparency, so the plate stays light
           in both themes rather than following the surface: on a dark card the
           theme-aware neutral would have taken the drawing with it. */
        'block bg-slate-100 shadow-xs ring-1 ring-black/10',
        className,
      )}
    >
      <Image unoptimized fill src={src} alt="" sizes="4rem" className="size-full object-cover" />
    </IdentityAvatarFrame>
  )
}

/**
 * The face, as a data URI. Deterministic in the name, so the same person wears
 * the same face on every surface without anything being stored against them.
 */
export function createUserAvatarDataUri(name: string): string {
  return new Avatar(userStyle, { seed: canonicalUserAvatarSeed(name) }).toDataUri()
}

/* The same normalisation the agent seed uses: a name is typed by hand in a
   dozen places, and "Walter Monecke", " walter monecke " and "walter-monecke"
   are one person who should not collect three faces. */
function canonicalUserAvatarSeed(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `duet-user:${normalized || 'user'}`
}
