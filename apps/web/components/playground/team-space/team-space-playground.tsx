'use client'

import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'

import appEn from '../../../messages/en/app.json'
import { TeamSpaceAppPane } from './team-space-apps'
import { TeamSpaceBuild } from './team-space-build'
import {
  findApp,
  findJobIn,
  findSessionIn,
  HARBOR,
  jobsForChat,
  WORKSPACES,
} from './team-space-fixture'
import { TeamSpaceHome } from './team-space-home'
import { TeamSpaceJob } from './team-space-job'
import { TeamSpaceJobsRail } from './team-space-jobs-rail'
import { TeamSpaceShell } from './team-space-shell'
import { TeamSpaceThread } from './team-space-thread'
import { TeamSpaceWorkspaceProvider } from './team-space-workspace'

/**
 * The whole product, against nothing.
 *
 * One route, and everything in it is reached the way a person would reach it.
 * It used to be fifteen registry entries, one per state, because each was a
 * screenshot; what that produced was a playground index where the same mock
 * appeared fifteen times and no single link opened *the* mock. This is the
 * mock. The states are all still here — they are behind clicks now, which is
 * where they are in the product.
 *
 * What it argues: one workspace has two doors and most people only ever have
 * one of them. The door most people use opens on the apps their agents built,
 * with a column of conversations beside it. **Duet answers every one of those
 * conversations** — naming another agent hands the work over, it does not hand
 * over the reply — and what it hands over is a session you can open, watch and
 * steer. The builder's door is the workspace as a canvas, and an agent on it
 * opens onto its own tuning conversation beside the record of everywhere it
 * has been pulled in.
 *
 * Build mounts the product's own map through the real projection. Everything
 * else is a mock.
 */
export function TeamSpacePlayground() {
  const [workspaceId, setWorkspaceId] = useState(HARBOR.id)
  const workspace = WORKSPACES.find(candidate => candidate.id === workspaceId) ?? HARBOR
  const [mode, setMode] = useState<'work' | 'build'>('work')

  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [appId, setAppId] = useState<string | undefined>(undefined)
  const [buildAgent, setBuildAgent] = useState<string | undefined>(undefined)
  const [openJobId, setOpenJobId] = useState<string | undefined>(undefined)
  const [jobsOpen, setJobsOpen] = useState(false)

  const chat = openId === undefined ? undefined : findSessionIn(workspace, openId)
  const job = openJobId === undefined ? undefined : findJobIn(workspace, openJobId)
  const app = appId === undefined ? undefined : findApp(workspace, appId)

  const clear = () => {
    setOpenId(undefined)
    setAppId(undefined)
    setOpenJobId(undefined)
  }

  const openChat = (id: string) => {
    clear()
    setOpenId(id)
    /* Two facts decide whether the rail comes out with the chat, and only one of
       them is about the chat. A room with nothing in flight opens without it —
       the panel earns its width by having something in it. And a window too
       narrow to hold a third column opens without it too, because below `lg`
       the rail is the whole screen: auto-opening there would land a reader on
       the index of a conversation they asked to read. */
    setJobsOpen(jobsForChat(workspace, id).length > 0 && hasRoomForRail())
  }

  const switchWorkspace = (id: string) => {
    clear()
    setJobsOpen(false)
    setMode('work')
    setBuildAgent(undefined)
    setWorkspaceId(id)
  }

  const body =
    mode === 'build' ? (
      <TeamSpaceBuild agentSlug={buildAgent} onOpenAgent={setBuildAgent} />
    ) : app !== undefined ? (
      <TeamSpaceAppPane app={app} onBack={clear} />
    ) : chat === undefined ? (
      <TeamSpaceHome onOpenApp={setAppId} />
    ) : job !== undefined ? (
      <TeamSpaceJob chat={chat} job={job} onBack={() => setOpenJobId(undefined)} />
    ) : (
      <TeamSpaceThread
        session={chat}
        onBack={clear}
        onOpenJob={setOpenJobId}
        jobsOpen={jobsOpen}
        onToggleJobs={() => setJobsOpen(open => !open)}
      />
    )

  return (
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      {/* `MemoryRouter` is not decoration: Build mounts the product's own map,
          which is a route component that renders links. An explicit in-memory
          route keeps it mounted without a URL and without this fixture
          pretending to own one. */}
      <MemoryRouter>
        <TeamSpaceWorkspaceProvider workspace={workspace}>
          <TeamSpaceShell
            mode={mode}
            onMode={next => {
              setMode(next)
              if (next === 'build') setBuildAgent(undefined)
            }}
            activeAgentSlug={buildAgent}
            onOpenAgent={setBuildAgent}
            activeSessionId={openId}
            activeAppId={appId}
            onSwitchWorkspace={switchWorkspace}
            onNavigate={target => {
              if (target.kind === 'home') return clear()
              if (target.kind === 'session') return openChat(target.id)
              clear()
              setAppId(target.id)
            }}
            railCovers={openJobId === undefined}
            rail={
              chat !== undefined && jobsOpen ? (
                <TeamSpaceJobsRail
                  chatId={chat.id}
                  openJobId={openJobId}
                  onOpenJob={setOpenJobId}
                  onClose={() => setJobsOpen(false)}
                />
              ) : undefined
            }
          >
            {body}
          </TeamSpaceShell>
        </TeamSpaceWorkspaceProvider>
      </MemoryRouter>
    </NextIntlClientProvider>
  )
}

/** Whether this window can hold a third column beside a conversation. */
function hasRoomForRail(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
}
