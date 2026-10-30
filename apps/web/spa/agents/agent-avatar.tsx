'use client'

import { Avatar, Style } from '@dicebear/core'
import definition from '@dicebear/styles/pixelbot.json' with { type: 'json' }
import Image from 'next/image'
import { type ComponentPropsWithoutRef, useMemo } from 'react'

import type { Agent } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import { DriveFileIcon, FileIconImage } from '../drive/drive-file-icon'
import { IdentityAvatarFrame } from '../identity/identity-avatar'

/* A drawn robot per agent. It used to be `glass` — a translucent blur pattern —
   which is a texture rather than a face, so the agent's initials had to be
   burned over the middle of it before anyone could tell two agents apart. A
   pixelbot is already different per seed and already reads as *an agent*, so the
   letters came off with it. */
const agentStyle = new Style(definition)

type AgentAvatarProfile = Pick<Agent, 'anchorPath' | 'icon' | 'updatedAt'>

export type AgentAvatarProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> & {
  avatarKey: string
  duet?: boolean
  profile?: AgentAvatarProfile
  workspaceSlug?: string
  /**
   * This agent's uploaded icon as a URL, for a caller that has already resolved
   * one — the alternative to `profile` + `workspaceSlug`, not a third kind of
   * icon.
   *
   * The knowledge map's projection resolves every icon on the drive up front
   * (`MapIcons` in knowledge-map-data/project.ts) because it draws into SVG,
   * where an `<image href>` is the only way in. The rail is fed from that same
   * projection, so it holds a URL and not the anchor/version the resolver wants
   * — and before this existed it simply dropped the icon on the floor and drew
   * the generated robot beside a canvas drawing the real artwork.
   */
  src?: string
  priority?: boolean
}

export function AgentAvatar({
  avatarKey,
  duet = false,
  profile,
  workspaceSlug,
  src,
  className,
  priority = false,
  ...props
}: AgentAvatarProps) {
  const generatedSrc = useMemo(
    () => (duet ? undefined : createAgentAvatarDataUri(avatarKey)),
    [avatarKey, duet],
  )
  const generated =
    generatedSrc === undefined ? undefined : (
      <Image
        unoptimized
        fill
        src={generatedSrc}
        alt=""
        sizes="4rem"
        className="size-full object-cover"
      />
    )

  return (
    <IdentityAvatarFrame
      kind="agent"
      {...props}
      data-agent-avatar={
        duet
          ? 'duet'
          : src !== undefined || (profile?.icon !== undefined && workspaceSlug !== undefined)
            ? 'custom'
            : 'dicebear'
      }
      aria-hidden
      className={cn('block [container-type:inline-size]', className)}
    >
      {duet ? (
        <Image
          unoptimized
          fill
          priority={priority}
          src="/icons/duet-avatar.png"
          alt=""
          sizes="4rem"
          className="size-full object-cover"
        />
      ) : src !== undefined ? (
        <FileIconImage src={src} className="size-full object-cover" fallback={generated} />
      ) : profile !== undefined && workspaceSlug !== undefined ? (
        <DriveFileIcon
          entity={profile}
          workspaceSlug={workspaceSlug}
          className="size-full object-cover"
          fallback={generated}
        />
      ) : (
        generated
      )}
    </IdentityAvatarFrame>
  )
}

/* Seed and nothing else. The corner used to be set here too, which put a second
   radius inside a frame that already rounds at 28% — the tile's shape is the
   frame's business, in the product and in the knowledge map alike. */
export function createAgentAvatarDataUri(avatarKey: string): string {
  return new Avatar(agentStyle, { seed: canonicalAgentAvatarSeed(avatarKey) }).toDataUri()
}

function canonicalAgentAvatarSeed(avatarKey: string): string {
  const normalized = avatarKey
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `duet-agent:${normalized || 'agent'}`
}
