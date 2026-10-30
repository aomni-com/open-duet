'use client'

import { GlobeIcon } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { useState } from 'react'

import {
  ComposeBar,
  type ComposeBarAgent,
  type ComposeBarSession,
} from '@repo/ui/components/compose-bar'

import { buildTierQualityOptions } from '../../../spa/model-tiers/tier-quality-options'
import type { TeamWorkspace } from './team-space-fixture'
import { useWorkspace } from './team-space-workspace'

const qualityOptions = buildTierQualityOptions()
type QualityId = (typeof qualityOptions)[number]['id']

/**
 * Who `@` offers, and in what order: the orchestrator first because it is the
 * default answer, then the agents that can take work, then the people in the
 * room.
 *
 * The shipped picker is an *agent* roster — `ComposeBarAgents` — and people are
 * fed through it here because the mock's whole claim is that a room addresses
 * both the same way. That is the one contract change this surface asks for: the
 * `@` trigger has to carry a second kind of subject, and a person's row needs a
 * face rather than a slug. Nothing else about the composer moves.
 */
function rosterOf(workspace: TeamWorkspace): readonly ComposeBarAgent[] {
  return [
    ...workspace.agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      description: agent.blurb,
      scopeLabel: agent.orchestrator === true ? 'Answers by default' : 'Agent',
      disabled: agent.status === 'setup',
      disabledLabel: agent.status === 'setup' ? 'Awaiting setup' : undefined,
    })),
    ...workspace.people
      .filter(person => person.id !== workspace.viewerId)
      .map(person => ({
        id: person.id,
        name: person.name,
        slug: person.id,
        description: person.role,
        scopeLabel: person.external === true ? 'Guest' : 'Teammate',
      })),
  ]
}

/**
 * The order the picker opens in: whoever is already in this room first, the
 * rest of the workspace under them.
 *
 * Ordering is the consumer's call — `ComposeBarAgents` says the list "is
 * decided upstream and ordered there" — and the decision worth making is that
 * proximity beats kind. A chat where two agents and two people are already
 * talking should not make you scroll past four agents you have never used to
 * reach the colleague sitting in it.
 */
export function rosterForRoom(
  workspace: TeamWorkspace,
  memberIds: readonly string[],
): readonly ComposeBarAgent[] {
  const roster = rosterOf(workspace)
  const inRoom = roster.filter(entry => memberIds.includes(entry.id))
  return [...inRoom, ...roster.filter(entry => !inRoom.includes(entry))]
}

const ROSTER_LABELS = {
  list: 'People and agents',
  loading: 'Looking for people and agents…',
  empty: 'Nobody here answers to that',
  unavailable: 'This workspace’s roster could not be read',
}

export function TeamSpaceComposer({
  value,
  onValueChange,
  placeholder,
  label,
  roster,
  prominent = false,
  session,
  banner,
  status,
  className,
  onSubmitted,
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  label: string
  /** Who `@` offers, in the order it offers them. Defaults to the whole workspace. */
  roster?: readonly ComposeBarAgent[]
  /** The home bar is taller and opens with more room to type into. */
  prominent?: boolean
  session?: ComposeBarSession
  banner?: ReactNode
  status?: ReactNode
  className?: string
  /**
   * What to do with a sent draft.
   *
   * Omitted, the bar clears itself and the message goes nowhere — which is all
   * a screenshot fixture needs. A surface where sending is part of the argument
   * passes this and owns the transcript.
   */
  onSubmitted?: (value: string) => void
}) {
  const workspace = useWorkspace()
  const [qualityId, setQualityId] = useState<QualityId>('balanced')
  const [webSearch, setWebSearch] = useState(false)

  return (
    <ComposeBar
      value={value}
      onValueChange={onValueChange}
      session={session}
      banner={banner}
      status={status}
      input={{
        label,
        placeholder,
        variant: prominent ? 'prominent' : 'default',
        maxHeight: prominent ? 220 : 180,
      }}
      quality={{
        label: 'Quality',
        value: qualityId,
        options: qualityOptions,
        onValueChange: setQualityId,
      }}
      agents={{ items: roster ?? rosterOf(workspace), labels: ROSTER_LABELS }}
      attachments={{ items: [], onFilesSelected: () => false }}
      actions={[
        {
          id: 'web',
          label: webSearch ? 'Disable web search' : 'Enable web search',
          icon: <GlobeIcon />,
          active: webSearch,
          onSelect: () => setWebSearch(enabled => !enabled),
        },
      ]}
      onSubmit={payload => {
        if (onSubmitted === undefined) {
          onValueChange('')
          return
        }
        onSubmitted(payload.value)
      }}
      classNames={{ root: className }}
    />
  )
}

/** The picker's copy, for a surface that draws it without an editor behind it. */
export { ROSTER_LABELS as TEAM_ROSTER_LABELS }
