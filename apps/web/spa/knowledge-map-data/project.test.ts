/* The projection is the seam between the drive's vocabulary and the map's, so
   what is worth pinning is every place the two do not line up one-to-one.
   The state axis is no longer one of those places: `bucket` arrives decided and
   is carried straight through, and the rule that decides it is the contract's,
   tested once in `bucket-of.test.ts` rather than a second time here. What is
   left is the machine readings and which files an agent is said to keep. */
import { describe, expect, test } from 'bun:test'

import { ROOT_AGENT_SCOPE, SESSION_BUCKETS } from '@repo/contract'
import type {
  ActivitySessionSummary,
  Agent,
  App,
  FileEntry,
  SessionActivityMachine,
} from '@repo/contract'

import { attention, toneOf } from '../knowledge-map/palette'
import {
  fileExtension,
  projectWorkspaceMap,
  toMapAgent,
  toMapApp,
  toMapFile,
  toMapJob,
  visibleFiles,
  type CoreFacts,
  type MapCopy,
  type MapIcons,
} from './project'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')

/* The projection asks its caller for every phrase; these tests only care that
   it asks, and with what — so the stub reports the arguments rather than
   pretending to format. */
const COPY: MapCopy = { when: (at, now) => `${Math.round((now - at) / 60_000)}m` }

/* Same idea for the one thing on the map that is neither words nor a field on
   a record: the stub reports which file it was asked for rather than pretending
   to be the drive's download URL, which `app-icon.test.tsx` already pins. */
const ICONS: MapIcons = {
  app: app => (app.icon === undefined ? undefined : `art:${app.anchorPath}/${app.icon}`),
  agent: agent => (agent.icon === undefined ? undefined : `art:${agent.anchorPath}/${agent.icon}`),
}

function relay(over: Partial<SessionActivityMachine> = {}): SessionActivityMachine {
  return { activity: 'idle', ...over }
}

function job(over: Partial<ActivitySessionSummary> = {}): ActivitySessionSummary {
  return {
    id: 'job-1',
    bucket: 'running',
    title: 'Reconcile invoices',
    updatedAt: NOW,
    unread: false,
    machine: relay(),
    ...over,
  }
}

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    name: 'notes.md',
    path: 'analyst/notes.md',
    type: 'file',
    size: 1200,
    mtime: '2026-07-30T11:00:00.000Z',
    ...over,
  }
}

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    workspaceId: 'ws-1',
    anchorId: 'anchor-1',
    anchorPath: 'agents/analyst',
    anchorState: 'active',
    slug: 'analyst',
    name: 'Analyst',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  }
}

function slice(over: Partial<Parameters<typeof projectWorkspaceMap>[1][number]> = {}) {
  return { agent: agent(), apps: [], jobs: [], ...over }
}

/* An app on the drive that no agent's anchor encloses — the seeded hello app is
   the one every drive is born with. */
const helloApp = {
  slug: 'hello',
  name: 'Hello',
  runtimeStatus: 'reconciled',
  anchorState: 'active',
  anchorPath: 'welcome/hello-app',
  updatedAt: NOW,
} as App

/* The centre is the drive: its own name, its own leftovers, and the caption the
   route counted. Everything a test does not care about is empty. */
function core(over: Partial<CoreFacts> = {}): CoreFacts {
  return { name: 'Acme', meta: '1 agent', apps: [], jobs: [], ...over }
}

describe('toMapJob', () => {
  /* The map draws the bucket the server stamped. Re-deriving it here would be a
     second definition of the product's central concept, free to disagree with
     the one the Convex index is keyed on. */
  test('the state is carried through, not recomputed', () => {
    for (const bucket of SESSION_BUCKETS) {
      expect(toMapJob(job({ bucket }), NOW, COPY).state).toBe(bucket)
    }
  })

  /* A wake time on anything but a scheduled job is a poll interval or a stale
     reading, and printing it would read as a promise the job is not making. */
  test('only a scheduled job prints when it wakes', () => {
    const machine = relay({ activity: 'sleeping', nextWakeAt: NOW + 60_000 })
    expect(toMapJob(job({ bucket: 'scheduled', machine }), NOW, COPY).wakesIn).toBe('-1m')
    expect(toMapJob(job({ bucket: 'running', machine }), NOW, COPY).wakesIn).toBeUndefined()
    expect(toMapJob(job({ bucket: 'scheduled' }), NOW, COPY).wakesIn).toBeUndefined()
  })

  test('a progress bar needs a total to be a fraction of', () => {
    expect(
      toMapJob(job({ machine: relay({ progress: { completed: 3, total: 4 } }) }), NOW, COPY)
        .progress,
    ).toBe(0.75)
    expect(
      toMapJob(job({ machine: relay({ progress: { completed: 0, total: 0 } }) }), NOW, COPY)
        .progress,
    ).toBeUndefined()
  })

  test('the bounded projected step reaches the map', () => {
    expect(toMapJob(job({ machine: relay({ step: 'matching' }) }), NOW, COPY).step).toBe('matching')
  })
})

describe('visibleFiles', () => {
  /* Folders are what the agent made too — an agent that files its work in
     `reports/` is not an agent with nothing. */
  test('keeps what the agent made, drops what configures it', () => {
    const kept = visibleFiles([
      file({ name: 'notes.md' }),
      file({ name: 'AGENTS.md' }),
      file({ name: 'agent.json' }),
      file({ name: '.env' }),
      file({ name: 'reports', type: 'directory' }),
      file({ name: 'link', type: 'symlink' }),
      file({ name: 'q3.csv' }),
    ])
    expect(kept.map(entry => entry.name)).toEqual(['notes.md', 'reports', 'q3.csv'])
  })

  test('a folder card carries no byte count', () => {
    const folder = toMapFile(file({ name: 'reports', type: 'directory', size: 4096 }), NOW, COPY)
    expect(folder.folder).toBe(true)
    expect(folder.size).toBeUndefined()
    expect(folder.kind).toBe('folder')
  })
})

describe('fileExtension', () => {
  test('reads the suffix, and says "file" when there is not one', () => {
    expect(fileExtension('q3.csv')).toBe('csv')
    expect(fileExtension('Report.PDF')).toBe('pdf')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
    expect(fileExtension('README')).toBe('file')
    // a leading dot names the file, it does not give it a type
    expect(fileExtension('.gitignore')).toBe('file')
    expect(fileExtension('trailing.')).toBe('file')
  })
})

describe('toMapApp', () => {
  const app = (over: Partial<App> = {}): App =>
    ({
      slug: 'grafana',
      name: 'Grafana',
      runtimeStatus: 'reconciled',
      anchorState: 'active',
      updatedAt: NOW,
      ...over,
    }) as App

  test('an app still coming up is not yet connected', () => {
    expect(toMapApp(app({ runtimeStatus: 'reconciling' }), NOW, COPY, ICONS).state).toBe(
      'available',
    )
  })

  /* The map draws an app as its own artwork and falls back to two letters, so
     the projection is where "does this one have any" is answered — from the
     same rule every other surface resolves an app icon by, not from a second
     opinion about where the drive keeps it. */
  test('an app carries the URL its own artwork is served at', () => {
    const drawn = toMapApp(app({ anchorPath: 'apps/grafana', icon: 'icon.png' }), NOW, COPY, ICONS)
    expect(drawn.icon).toBe('art:apps/grafana/icon.png')
    // and an app that ships none says so, rather than pointing at a 404
    expect(toMapApp(app({ anchorPath: 'apps/grafana' }), NOW, COPY, ICONS).icon).toBeUndefined()
  })

  /* The reason this defers to `appDisplayStatus` rather than reading
     `runtimeStatus`: an app can be cleanly reconciled and still be down. */
  test('"connected" means up, not merely last-reconciled', () => {
    expect(toMapApp(app(), NOW, COPY, ICONS).state).toBe('connected')
    expect(toMapApp(app({ disabledAt: NOW }), NOW, COPY, ICONS).state).toBe('available')
    expect(toMapApp(app({ anchorState: 'broken' }), NOW, COPY, ICONS).state).toBe('available')
    expect(toMapApp(app({ runtimeStatus: 'reconcile_failed' }), NOW, COPY, ICONS).state).toBe(
      'available',
    )
  })
})

describe('toMapAgent', () => {
  /* Same rule an app's own artwork is drawn by: the ring is not the second
     opinion about where the drive keeps an agent's icon, it asks the one rule
     every surface resolves one by. An agent that ships none says so, rather
     than the face silently keeping whatever it drew last. */
  test('an agent carries the URL its own custom icon is served at', () => {
    const withIcon = slice({ agent: agent({ anchorPath: 'agents/analyst', icon: 'icon.png' }) })
    expect(toMapAgent(withIcon, NOW, COPY, ICONS).icon).toBe('art:agents/analyst/icon.png')
    expect(toMapAgent(slice(), NOW, COPY, ICONS).icon).toBeUndefined()
  })
})

describe('projectWorkspaceMap', () => {
  /* The headline of the merge, and the one thing a screenshot cannot prove on
     its own: the ring used to read a jobs-only list, so a plain chat waiting on
     its owner left the agent grey. There is one list now, and a session with no
     machine at all reaches the map and colours the face it belongs to. */
  test('a plain conversation with no machine still colours its agent', () => {
    const plainAsk = job({ id: 'chat-1', bucket: 'asking', machine: undefined })
    expect(plainAsk.machine).toBeUndefined()

    const { data } = projectWorkspaceMap(
      core({ meta: '1 agent' }),
      [slice({ agent: agent({ id: 'support' }), jobs: [plainAsk] })],
      NOW,
      COPY,
      ICONS,
    )
    const mapped = data.agents[0]!
    expect(mapped.jobs.map(j => j.state)).toEqual(['asking'])
    expect(attention(mapped.jobs).top).toBe('asking')
    expect(toneOf('asking')).toBe('alert')
  })

  /* The map sends an agent node to its chat, and the sessions surface refuses a
     disabled agent or one whose folder is gone. The host has to be able to tell
     before it navigates, or the click lands on "Agent unavailable". */
  test('an agent that cannot hold a conversation says so', () => {
    const { routes, data } = projectWorkspaceMap(
      core({ meta: '2 agents' }),
      [
        slice({ agent: agent({ id: 'live' }) }),
        // Its own path: two agents cannot share an anchor in production, and
        // two fixture agents on one path read as each other's parent here.
        slice({
          agent: agent({ id: 'off', slug: 'off', anchorPath: 'agents/off', disabledAt: NOW }),
        }),
      ],
      NOW,
      COPY,
      ICONS,
    )
    expect(routes.get('live')?.launchable).toBe(true)
    expect(routes.get('off')?.launchable).toBe(false)
    // and the ring draws it as locked rather than as an ordinary agent
    expect(data.agents.find(a => a.id === 'off')?.locked).toBe(true)
    expect(data.agents.find(a => a.id === 'live')?.locked).toBe(false)
  })

  /* One layer, the same rule the roster prompt lives by (specs/done/agent-delegation
     D1/D13): a nested agent is its parent's to show, not root's peer — but it
     stays reachable, so deep links and the rail lose nobody. */
  test('the ring draws only direct children of root; the directory keeps everyone', () => {
    const parent = agent({ id: 'research', slug: 'research', anchorPath: 'agents/research' })
    const nested = agent({
      id: 'scout',
      slug: 'scout',
      anchorPath: 'agents/research/scout',
      anchorId: 'anchor-scout',
    })
    const projected = projectWorkspaceMap(
      core({ meta: '1 agent' }),
      [slice({ agent: parent }), slice({ agent: nested, jobs: [job({ id: 'nested-job' })] })],
      NOW,
      COPY,
      ICONS,
    )
    expect(projected.data.agents.map(mapped => mapped.id)).toEqual(['research'])
    expect([...projected.agentDirectory.keys()].sort()).toEqual(['research', 'scout'])
    expect(projected.childAgentIds.get('research')).toEqual(['scout'])
    expect(projected.parentAgentIds.get('scout')).toBe('research')
    expect(projected.parentAgentIds.has('research')).toBe(false)
    // Routes and activity stay complete: a deep link to the grandchild still
    // resolves, and its motion is still recorded under its own id.
    expect(projected.routes.get('scout')?.slug).toBe('scout')
    expect(projected.activity.get('scout')).toBe(NOW)
    // A sibling whose slug shares a prefix must not nest.
    const prefixSibling = agent({
      id: 'research-notes',
      slug: 'research-notes',
      anchorPath: 'agents/research-notes',
      anchorId: 'anchor-notes',
    })
    const withSibling = projectWorkspaceMap(
      core(),
      [slice({ agent: parent }), slice({ agent: prefixSibling })],
      NOW,
      COPY,
      ICONS,
    )
    expect(withSibling.data.agents.map(mapped => mapped.id).sort()).toEqual([
      'research',
      'research-notes',
    ])
  })

  test('the core meta and job recency caption come from the caller', () => {
    const { data } = projectWorkspaceMap(
      core({ meta: 'whatever the route said' }),
      [slice({ jobs: [job({ updatedAt: NOW - 120_000 })] })],
      NOW,
      COPY,
      ICONS,
    )
    expect(data.coreMeta).toBe('whatever the route said')
    expect(data.agents[0]?.jobs[0]?.when).toBe('2m')
  })

  /* Duet comes out in the same shape a ring agent does, carrying what nobody
     else claimed — that is what lets the map draw its apps off the centre and
     the zoom list them, from one record rather than two. */
  test('the centre is Duet, carrying the apps and jobs no agent claimed', () => {
    const { data } = projectWorkspaceMap(
      core({ name: 'Bob', apps: [helloApp], jobs: [job({ id: 'root-job', bucket: 'done' })] }),
      [slice()],
      NOW,
      COPY,
      ICONS,
    )
    expect(data.duet.id).toBe(ROOT_AGENT_SCOPE)
    expect(data.duet.name).toBe('Bob')
    expect(data.duet.apps.map(entry => entry.id)).toEqual(['hello'])
    expect(data.duet.jobs.map(entry => [entry.id, entry.title, entry.state])).toEqual([
      ['root-job', 'Reconcile invoices', 'done'],
    ])
    // and it is never one of the faces on the ring
    expect(data.agents.map(entry => entry.id)).toEqual(['agent-1'])
  })

  /* `Date.parse` on a malformed mtime yields NaN, and "NaN minutes ago" on a
     row is worse than no caption at all. */
  test('an unparseable file time prints nothing rather than NaN', () => {
    expect(toMapFile(file({ mtime: 'not a date' }), NOW, COPY).when).toBe('')
    expect(toMapFile(file({ mtime: new Date(NOW - 120_000).toISOString() }), NOW, COPY).when).toBe(
      '2m',
    )
  })

  test('routes carry what the ids cannot', () => {
    const { routes } = projectWorkspaceMap(
      core(),
      [slice({ agent: agent({ id: 'agent-7', slug: 'seo', anchorPath: 'agents/seo' }) })],
      NOW,
      COPY,
      ICONS,
    )
    expect(routes.get('agent-7')).toEqual({
      slug: 'seo',
      anchorPath: 'agents/seo',
      launchable: true,
    })
  })

  /* The side table the drawer sorts on. Absence is the load-bearing half:
     "nothing in flight" has to be tellable from "in flight, at the epoch". */
  test('activity keeps the newest work timestamp and leaves quiet carriers absent', () => {
    const { activity } = projectWorkspaceMap(
      core({ jobs: [job({ id: 'root-1', updatedAt: NOW - 600_000 })] }),
      [
        slice({
          agent: agent({ id: 'busy' }),
          jobs: [
            job({ id: 'a', updatedAt: NOW - 900_000 }),
            job({ id: 'b', updatedAt: NOW - 60_000 }),
            job({ id: 'c', updatedAt: NOW - 300_000 }),
          ],
        }),
        slice({ agent: agent({ id: 'quiet', slug: 'quiet' }) }),
      ],
      NOW,
      COPY,
      ICONS,
    )
    expect(activity.get('busy')).toBe(NOW - 60_000)
    expect(activity.get(ROOT_AGENT_SCOPE)).toBe(NOW - 600_000)
    expect(activity.has('quiet')).toBe(false)
  })

  /* The second side table, beside the first and never merged into it. The
     preview travels on the owner's `chat` — the one session the wire gives it
     to — and this only files it under the id the map draws that owner by. */
  test('the preview rides the chat, keyed the way the map keys everything else', () => {
    const { previews } = projectWorkspaceMap(
      core({
        chat: {
          ...job({ id: 'root-chat' }),
          preview: { text: 'reindex it', author: { kind: 'user', userId: 'u_1' } },
        },
      }),
      [
        slice({
          agent: agent({ id: 'talkative' }),
          chat: {
            ...job({ id: 'chat-1' }),
            preview: { text: 'on it.', author: { kind: 'agent' } },
          },
        }),
        // Its conversation exists but holds nothing anyone said.
        slice({ agent: agent({ id: 'wordless', slug: 'wordless' }), chat: job({ id: 'chat-2' }) }),
        slice({ agent: agent({ id: 'quiet', slug: 'quiet' }) }),
      ],
      NOW,
      COPY,
      ICONS,
    )
    expect(previews.get('talkative')).toEqual({ text: 'on it.', author: { kind: 'agent' } })
    expect(previews.get(ROOT_AGENT_SCOPE)).toEqual({
      text: 'reindex it',
      author: { kind: 'user', userId: 'u_1' },
    })
    // Absent, not empty: two different facts, and the row draws them apart.
    expect(previews.has('wordless')).toBe(false)
    expect(previews.has('quiet')).toBe(false)
  })

  /* Work is described by its title. A preview on a job is a second description
     of one session, and the wire deliberately carries none. */
  test('an owner\u2019s work never contributes a preview', () => {
    const { previews } = projectWorkspaceMap(
      core(),
      [slice({ agent: agent({ id: 'busy' }), jobs: [job({ id: 'a' })] })],
      NOW,
      COPY,
      ICONS,
    )
    expect(previews.has('busy')).toBe(false)
  })

  /* A rename touches the agent record and touches no work. A list that claims
     to be ordered by activity must not reshuffle because somebody corrected a
     spelling — so the record's own clock is deliberately not in the table. */
  test('an agent record moving is not activity', () => {
    const { activity } = projectWorkspaceMap(
      core(),
      [slice({ agent: agent({ id: 'renamed', updatedAt: NOW }) })],
      NOW,
      COPY,
      ICONS,
    )
    expect(activity.has('renamed')).toBe(false)
  })

  /* An unnamed agent is the common case on a fresh drive — the name is optional
     on the wire — and it has to reach the ring with something readable on it. */
  test('an agent with no name falls back to its slug', () => {
    const named = projectWorkspaceMap(core(), [slice()], NOW, COPY, ICONS)
    expect(named.data.agents[0]?.name).toBe('Analyst')

    const bare = projectWorkspaceMap(
      core(),
      [slice({ agent: agent({ name: undefined, slug: 'market-scout' }) })],
      NOW,
      COPY,
      ICONS,
    )
    expect(bare.data.agents[0]?.name).toBe('market-scout')
  })

  /* The slug is what everything outside the map calls this agent — its folder,
     its URL, the `@` you type at it — so a drive that has renamed one still
     needs the other name to hand. It rides as a subtitle rather than as a slug
     field on purpose: the map draws it, and the decision of *whether there is a
     second line at all* is a naming question, which is this projection's. An
     agent showing its slug as its name has nothing to say twice. */
  test('a named agent carries its slug as a subtitle, and an unnamed one carries none', () => {
    const named = projectWorkspaceMap(core(), [slice()], NOW, COPY, ICONS)
    expect(named.data.agents[0]?.subtitle).toBe('analyst')

    const bare = projectWorkspaceMap(
      core(),
      [slice({ agent: agent({ name: undefined, slug: 'market-scout' }) })],
      NOW,
      COPY,
      ICONS,
    )
    expect(bare.data.agents[0]?.subtitle).toBeUndefined()
  })

  /* Duet is the drive itself. It answers to `root` — a reserved token rather
     than a slug somebody chose — and printing it under her name would be the
     one line on the map that names an implementation detail. */
  test('Duet has no second line under her name', () => {
    const { data } = projectWorkspaceMap(core(), [slice()], NOW, COPY, ICONS)
    expect(data.duet.subtitle).toBeUndefined()
  })
})

/* ------------------------------------------------- the owner's own chat

   Two places on a face, and the wire decides which is which: `chat` is the
   conversation this owner *is*, `jobs` is what it did. Before that split the
   chat came back among the work like any other row and was drawn as a bead —
   while the dialog that bead opens withholds it (`excludeDefault`). A node
   pointing at a door with nothing behind it. */

test('the owner’s own chat lands on its face, beside the work it did', () => {
  const chat = job({ id: 'chat-1', title: 'Its own chat', unread: true })
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [] },
    [slice({ jobs: [job({ id: 'job-1' })], chat })],
    NOW,
    COPY,
    ICONS,
  )
  const drawn = map.data.agents[0]!
  expect(drawn.jobs.map(j => j.id)).toEqual(['job-1'])
  expect(drawn.chat?.map(j => j.id)).toEqual(['chat-1'])
})

/* The projection draws what it is handed and takes nothing away. A filter here
   would be a second answer to a question the wire has already answered — and on
   the day the two disagreed, the one that is only a guess would win. */
test('the chat is drawn as handed, unread and all', () => {
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [] },
    [slice({ jobs: [], chat: job({ id: 'chat-1', unread: true }) })],
    NOW,
    COPY,
    ICONS,
  )
  expect(map.data.agents[0]!.chat?.[0]?.unread).toBe(true)
})

/* An owner nobody has written to has no chat yet — the pointer names nothing —
   and that must read as nothing to say rather than as an empty conversation. */
test('an owner with no chat yet draws none, and its work is untouched', () => {
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [] },
    [slice({ jobs: [job({ id: 'job-1' })] })],
    NOW,
    COPY,
    ICONS,
  )
  expect(map.data.agents[0]!.chat).toBeUndefined()
  expect(map.data.agents[0]!.jobs.map(j => j.id)).toEqual(['job-1'])
})

/* The centre is an owner like any face and answers to the same split. */
test('the drive root’s own chat lands on the centre the same way', () => {
  const chat = job({ id: 'root-chat', unread: true })
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [job({ id: 'root-job' })], chat },
    [],
    NOW,
    COPY,
    ICONS,
  )
  expect(map.data.duet.jobs.map(j => j.id)).toEqual(['root-job'])
  expect(map.data.duet.chat?.map(j => j.id)).toEqual(['root-chat'])
})

/* The projection draws what it is handed and takes nothing away. The wire has
   already answered which row is the chat; a second answer here is one that can
   disagree, and on the day it did the guess would win. A response that named the
   same row twice is therefore drawn twice — visibly, where it is a bug worth
   seeing — rather than quietly reconciled into looking correct. */
test('a row the wire names twice is drawn twice, never silently dropped', () => {
  const chat = job({ id: 'chat-1', unread: true })
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [] },
    [slice({ jobs: [job({ id: 'job-1' }), chat], chat })],
    NOW,
    COPY,
    ICONS,
  )
  const drawn = map.data.agents[0]!
  expect(drawn.jobs.map(j => j.id)).toEqual(['job-1', 'chat-1'])
  expect(drawn.chat?.map(j => j.id)).toEqual(['chat-1'])
})

/* ---- and what "recently active" means to a directory ----
   The rail is a list of agents under the promise "most recently active first",
   not a queue of work. The last thing that happened with an agent is the last
   thing that happened — asking it to do something, or asking it something. The
   wire's own owner order stays work-only; this is the other question. */
test('a conversation counts as the agent having moved', () => {
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [] },
    [
      slice({
        agent: agent({ id: 'busy', slug: 'busy', anchorPath: 'agents/busy' }),
        jobs: [job({ id: 'job-1', updatedAt: 2_000 })],
      }),
      slice({
        agent: agent({ id: 'chatty', slug: 'chatty', anchorPath: 'agents/chatty' }),
        jobs: [],
        chat: job({ id: 'chat-1', updatedAt: 9_000 }),
      }),
    ],
    NOW,
    COPY,
    ICONS,
  )
  expect(map.activity.get('chatty')).toBe(9_000)
  expect(map.activity.get('busy')).toBe(2_000)
})

/* An agent nobody has touched at all is still absent rather than zero: "has not
   moved" and "moved at the epoch" are different facts and the rail sorts them
   apart. */
test('an agent with neither work nor a chat has not moved', () => {
  const map = projectWorkspaceMap(
    { name: 'Duet', meta: '', apps: [], jobs: [] },
    [slice({ jobs: [] })],
    NOW,
    COPY,
    ICONS,
  )
  expect(map.activity.get('agent-1')).toBeUndefined()
})
