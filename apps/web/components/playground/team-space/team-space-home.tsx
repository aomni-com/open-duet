'use client'

import { CaretDownIcon, PlusIcon, UsersThreeIcon } from '@phosphor-icons/react'
import { useState } from 'react'

import { AppGrid } from './team-space-apps'
import { TeamSpaceComposer } from './team-space-composer'
import { useWorkspace, useMember } from './team-space-workspace'

/**
 * Where a person lands.
 *
 * One question and one bar to answer it in, and under the bar the things this
 * workspace was bought for: the apps its agents built and keep fed.
 *
 * The chats were here for two passes and both were wrong. First they were here
 * twice — an away-feed and a chat list that were the same six rooms written out
 * — and then once, which was still one time too many: the column beside this
 * page already lists every chat, and a chat is where work is *discussed* rather
 * than where it is done. An app is a place a person goes to get something, so
 * Home is where the apps are.
 */
export function TeamSpaceHome({
  draft = '',
  onOpenApp,
}: {
  draft?: string
  onOpenApp: (id: string) => void
}) {
  const [value, setValue] = useState(draft)
  const workspace = useWorkspace()
  const viewer = useMember(workspace.viewerId)
  const firstName = viewer?.name.split(' ')[0] ?? ''

  return (
    <>
      <header className="flex h-12 shrink-0 items-center border-b border-border/70">
        <div className="mx-auto flex w-full max-w-[46rem] items-center gap-2 px-5">
          {/* The column carries the workspace's identity on a desktop. Below `lg`
            there is no column, so the header says where you are instead. */}
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-sm font-semibold text-background lg:hidden"
          >
            H
          </span>
          <span className="text-sm font-medium lg:hidden">{workspace.name}</span>
          <span className="hidden text-sm font-medium lg:block">Home</span>
          <span className="min-w-0 flex-1" />
          <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground">
            <PlusIcon className="size-3" />
            Invite
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-5 pb-16 pt-10 sm:pt-14">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {workspace.greetingDate}
          </p>
          <h1 className="mt-2 font-serif text-3xl font-normal italic leading-tight tracking-tight">
            Good afternoon, {firstName}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {workspace.agents.length} agents are in this workspace. Ask for something and Duet will
            bring in whoever owns it.
          </p>

          <div className="mt-6">
            <TeamSpaceComposer
              prominent
              value={value}
              onValueChange={setValue}
              label={`Message ${workspace.name}`}
              placeholder="What do you want to do next?"
              banner={
                <div className="flex min-w-0 items-center gap-2">
                  <UsersThreeIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-xs font-medium">
                    Everyone at {workspace.name}
                  </span>
                  <CaretDownIcon className="size-3 shrink-0 text-muted-foreground" />
                  <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:block">
                    <kbd className="rounded border border-border bg-background px-1 font-sans text-[10px]">
                      @
                    </kbd>{' '}
                    to bring in an agent or a colleague
                  </span>
                </div>
              }
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {workspace.starters.map(starter => (
              <button
                key={starter.label}
                type="button"
                onClick={() => setValue(starter.draft)}
                className="rounded-full border border-border/80 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
              >
                {starter.label}
              </button>
            ))}
          </div>

          <h2 className="mb-2 mt-10 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            Apps in this workspace
          </h2>
          {/* The chats used to be here, and they were the wrong answer twice
              over: the column already lists them, and a chat is where work is
              discussed rather than where it is done. What a client bought is
              the apps their agents built, so that is what Home opens on. */}
          <AppGrid onOpenApp={onOpenApp} />
        </div>
      </div>
    </>
  )
}
