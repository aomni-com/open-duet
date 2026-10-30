import type { SessionBucket } from '@repo/contract'

/**
 * The North Star fixture for the *work* side of the product.
 *
 * Two routes exist into the same workspace. One is the surface we already have —
 * the builder's: files beside a chat, where a consultant assembles an agent,
 * gives it its documents and ships the apps its client will use. The other is
 * this one: what the client's own staff open every morning. Sessions in a
 * column, a room per piece of work, and one bar that asks what is next.
 *
 * Everything here is invented. No query, no transport, no backend: the point of
 * the fixture is to argue about the shape of the surface before anything is
 * built behind it.
 */

export type TeamPerson = {
  readonly id: string
  readonly name: string
  /** What this person does, in the words the workspace would use. */
  readonly role: string
  /** Someone from outside the client company — the consultant, here. */
  readonly external?: boolean
}

export type TeamAgent = {
  readonly id: string
  readonly name: string
  /** The address. Two agents may share a name; only this tells them apart. */
  readonly slug: string
  readonly blurb: string
  /** The one agent that answers a room nobody addressed. */
  readonly orchestrator?: boolean
  readonly status: 'ready' | 'working' | 'setup'
  /** Present while `status` is `working`: what it is doing right now. */
  readonly activity?: string
}

/** A person or an agent, addressed the same way from the composer. */
export type TeamMember =
  | ({ readonly kind: 'person' } & TeamPerson)
  | ({ readonly kind: 'agent' } & TeamAgent)

/* Stand-in artwork for the apps a workspace ships. A data URI rather than a file the
   playground serves, because the map draws these in SVG and a screenshot must
   not wait on a second request to know what a tile looks like — and because the
   dock, the grid and the map all have to draw the *same* mark, which only holds
   if there is one source for it. */
function art(back: string, ink: string, mark: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${back}"/>${mark.replaceAll('%INK%', ink)}</svg>`,
  )}`
}

export const APP_ART = {
  checklist: art(
    '#0f3b2e',
    '#7fe3bd',
    '<path d="M18 22l5 5 9-11" stroke="%INK%" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 42l5 5 9-11" stroke="%INK%" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 24h10M40 44h10" stroke="%INK%" stroke-width="4" stroke-linecap="round"/>',
  ),
  ledger: art(
    '#1e3a5f',
    '#8fd3ff',
    '<rect x="14" y="34" width="8" height="18" rx="2" fill="%INK%"/><rect x="28" y="22" width="8" height="30" rx="2" fill="%INK%"/><rect x="42" y="12" width="8" height="40" rx="2" fill="%INK%"/>',
  ),
  contract: art(
    '#f2ede3',
    '#3d3427',
    '<rect x="16" y="12" width="32" height="40" rx="4" fill="none" stroke="%INK%" stroke-width="3"/><path d="M24 24h16M24 32h16M24 40h10" stroke="%INK%" stroke-width="3" stroke-linecap="round"/>',
  ),
  board: art(
    '#3a1f4d',
    '#e2b8ff',
    '<rect x="12" y="14" width="12" height="36" rx="3" fill="%INK%"/><rect x="28" y="14" width="12" height="24" rx="3" fill="%INK%"/><rect x="44" y="14" width="8" height="32" rx="3" fill="%INK%"/>',
  ),
  brief: art(
    '#4a2c12',
    '#ffcf9e',
    '<rect x="14" y="18" width="36" height="28" rx="4" fill="none" stroke="%INK%" stroke-width="3"/><path d="M14 26h36" stroke="%INK%" stroke-width="3"/><path d="M26 18v-4h12v4" stroke="%INK%" stroke-width="3" fill="none"/>',
  ),
  calendar: art(
    '#123a4d',
    '#9fe6ff',
    '<rect x="12" y="18" width="40" height="34" rx="4" fill="none" stroke="%INK%" stroke-width="3"/><path d="M12 28h40M22 12v10M42 12v10" stroke="%INK%" stroke-width="3" stroke-linecap="round"/><rect x="20" y="34" width="8" height="8" rx="2" fill="%INK%"/>',
  ),
} as const

/**
 * One app the workspace ships.
 *
 * An app is the thing a client actually *uses* — the surface an agent built for
 * them — and it is the reasin the workspace was bought. `ownerAgentId` is what makes
 * it more than a bookmark: every app on this surface belongs to an agent, which
 * is who you talk to when it is wrong.
 */
export type TeamApp = {
  readonly id: string
  readonly name: string
  readonly blurb: string
  /** The agent that built it and keeps it fed. */
  readonly ownerAgentId: string
  readonly art: string
  /** One line under the name: what it says about itself right now. */
  readonly meta: string
}

export type TeamArtifact = {
  readonly id: string
  readonly name: string
  readonly meta: string
  readonly tone: 'sheet' | 'doc' | 'app'
}

export type TeamEntry =
  | {
      readonly kind: 'message'
      readonly id: string
      readonly authorId: string
      readonly at: string
      /** Prose. `@slug` in it becomes a chip against the roster below. */
      readonly body: string
      readonly artifacts?: readonly TeamArtifact[]
      /** Continues the row above it — same author, same minute. */
      readonly stacked?: boolean
    }
  | {
      readonly kind: 'handoff'
      readonly id: string
      readonly fromId: string
      readonly toId: string
      readonly at: string
      readonly task: string
      /** The job this handoff opened. The card in the transcript is its door. */
      readonly jobId: string
      readonly status: 'running' | 'done'
      readonly steps: readonly {
        readonly label: string
        readonly state: 'done' | 'active' | 'todo'
      }[]
    }
  | { readonly kind: 'day'; readonly id: string; readonly label: string }

/**
 * What the composer says the room is doing.
 *
 * The compose bar already has these three phases; what a session has to supply
 * is which one it is in and the words for it. A room where nothing is running
 * supplies none, and the composer is just a composer.
 */
export type TeamComposerState =
  | {
      readonly kind: 'working'
      readonly agentId: string
      readonly label: string
      readonly todos: readonly {
        readonly label: string
        readonly status: 'pending' | 'active' | 'complete' | 'failed'
      }[]
    }
  | { readonly kind: 'waiting'; readonly label: string; readonly question: string }
  | { readonly kind: 'sleeping'; readonly label: string; readonly hint: string }

export type TeamSession = {
  readonly id: string
  readonly title: string
  /** Who is in the room, in the order the column draws them. */
  readonly memberIds: readonly string[]
  readonly unread?: number
  /** An agent is mid-turn in here right now. */
  readonly live?: boolean
  /** Waiting on a person to answer something. */
  readonly asking?: boolean
  /** Nothing due until its next scheduled run. */
  readonly sleeping?: boolean
  /** Who spoke last, and what they said — the column's second line. */
  readonly lastAuthorId: string
  readonly lastLine: string
  readonly lastAt: string
  /** What the room says about itself above its first message. */
  readonly intro: string
  readonly composer?: TeamComposerState
  readonly entries: readonly TeamEntry[]
}

/**
 * A workspace, as one value.
 *
 * Everything a surface needs in order to draw itself lives in here rather than
 * in module scope, because the product's own answer to "may this person build
 * agents" is a membership role in one workspace — not a fact about the person. The
 * same account is a builder in one workspace and only a worker in the next, and
 * a mock that cannot express that cannot show what the second one looks like.
 */
export type TeamWorkspace = {
  readonly id: string
  readonly name: string
  /** The letter in the workspace tile. */
  readonly mark: string
  /** The consultancy that built the agents in this workspace. */
  readonly builder: string
  /**
   * Whether the reader may cross into the builder's surface.
   *
   * False is the ordinary case — most people in a workspace did not build its
   * agents and are not maintaining them. It removes the mode switch rather than
   * disabling it: a control that is never usable is furniture somebody has to
   * explain, and the reader whose only mode is Work should not have to learn
   * that a second one exists.
   */
  readonly viewerCanBuild: boolean
  readonly viewerId: string
  readonly people: readonly TeamPerson[]
  readonly agents: readonly TeamAgent[]
  readonly apps: readonly TeamApp[]
  readonly sessions: readonly TeamSession[]
  readonly jobs: readonly TeamJob[]
  /** What Home offers when there is nothing in particular to do. */
  readonly starters: readonly { readonly label: string; readonly draft: string }[]
  readonly greetingDate: string
}

const HARBOR_PEOPLE: readonly TeamPerson[] = [
  { id: 'walter', name: 'Walter Monecke', role: 'Operations' },
  { id: 'priya', name: 'Priya Raman', role: 'Client services' },
  { id: 'tomas', name: 'Tomás Herrera', role: 'Finance' },
  { id: 'ada', name: 'Ada Whitlock', role: 'Analyst' },
  { id: 'marco', name: 'Marco Feld', role: 'Studio Feld', external: true },
]

const HARBOR_AGENTS: readonly TeamAgent[] = [
  {
    id: 'duet',
    name: 'Duet',
    slug: 'duet',
    blurb: 'Answers here by default and hands the work to whoever owns it.',
    orchestrator: true,
    status: 'working',
    activity: 'Rebuilding the variance pack',
  },
  {
    id: 'ledger',
    name: 'Ledger',
    slug: 'ledger',
    blurb: 'Month-end close, reconciliations and the variance pack.',
    status: 'working',
    activity: 'Reconciling September',
  },
  {
    id: 'sable',
    name: 'Sable',
    slug: 'sable',
    blurb: 'Reads contracts and flags the clauses that cost money.',
    status: 'ready',
  },
  {
    id: 'atlas',
    name: 'Atlas',
    slug: 'atlas',
    blurb: 'Desk research, market briefs, competitor teardowns.',
    status: 'ready',
  },
  {
    id: 'rhea',
    name: 'Rhea',
    slug: 'rhea',
    blurb: 'Screens candidates and books the panel.',
    status: 'ready',
  },
  {
    id: 'pike',
    name: 'Pike',
    slug: 'pike',
    blurb: 'Builds the dashboards and keeps them fed.',
    status: 'setup',
  },
]

/** Agents first, then people: the order every roster in the product opens in. */
export function membersOf(workspace: TeamWorkspace): readonly TeamMember[] {
  return [
    ...workspace.agents.map(agent => ({ kind: 'agent' as const, ...agent })),
    ...workspace.people.map(person => ({ kind: 'person' as const, ...person })),
  ]
}

export function findMemberIn(workspace: TeamWorkspace, id: string): TeamMember | undefined {
  return membersOf(workspace).find(member => member.id === id)
}

/** The one transcript the fixture writes out in full. */
const Q3_ENTRIES: readonly TeamEntry[] = [
  { kind: 'day', id: 'day-tue', label: 'Today' },
  {
    kind: 'message',
    id: 'm1',
    authorId: 'priya',
    at: '09:12',
    body: 'Morning — the board pack is due Thursday. @duet can you own the Q3 close this week? Tomás has the bank feeds.',
  },
  {
    kind: 'message',
    id: 'm2',
    authorId: 'duet',
    at: '09:12',
    body: "Taking it. I'll run the close with Ledger and bring you a variance pack against the Q2 commentary that's already in the workspace. One blocker: September's Xero feed stops on the 26th, so the last four days are unreconciled until someone re-authorises it.",
  },
  {
    kind: 'handoff',
    id: 'h1',
    fromId: 'duet',
    toId: 'ledger',
    at: '09:13',
    task: 'Reconcile September and build the Q3 variance pack',
    jobId: 'reconcile-september',
    status: 'running',
    steps: [
      { label: 'Pull the September ledger', state: 'done' },
      { label: 'Match against the bank feed', state: 'done' },
      { label: 'Flag variances over 5%', state: 'active' },
      { label: 'Write the commentary', state: 'todo' },
    ],
  },
  {
    kind: 'message',
    id: 'm3',
    authorId: 'tomas',
    at: '09:26',
    body: 'Re-authorised. Feed runs to the 30th now.',
  },
  {
    kind: 'message',
    id: 'm4',
    authorId: 'duet',
    at: '09:31',
    body: 'September reconciles clean apart from two items — a £48,200 Kestrel invoice with no matching PO, and the Whitfield retainer billed twice on the 14th. Everything else is inside tolerance.',
    artifacts: [
      {
        id: 'a1',
        name: 'Q3-variance-pack.xlsx',
        meta: 'Sheet · 6 tabs · updated 09:31',
        tone: 'sheet',
      },
      { id: 'a2', name: 'September-exceptions.md', meta: 'Note · 2 items', tone: 'doc' },
    ],
  },
  {
    kind: 'message',
    id: 'm5',
    authorId: 'tomas',
    at: '09:40',
    body: 'The Kestrel one is a prepayment, not a miss — it should sit in accruals. @sable has the MSA if you need the billing term.',
  },
  {
    kind: 'message',
    id: 'm6',
    authorId: 'duet',
    at: '09:41',
    body: '@sable confirms the MSA bills annually in advance, so the prepayment runs to 31 March. Moved it to accruals and asked Ledger to rebuild. The Whitfield duplicate is a genuine double-charge — I have raised a credit note for @priya to approve.',
  },
]

const KESTREL_ENTRIES: readonly TeamEntry[] = [
  { kind: 'day', id: 'k-day', label: 'Today' },
  {
    kind: 'message',
    id: 'k1',
    authorId: 'priya',
    at: '08:31',
    body: '@sable the Kestrel MSA renewal landed on my desk this morning. Anything in it I should push back on before I sign?',
  },
  {
    kind: 'message',
    id: 'k2',
    authorId: 'duet',
    at: '08:52',
    body: 'Three things. Liability is capped at one month of fees, which is well below what we agreed last year. The renewal is automatic on 12 months with 90 days notice — that notice window opens in six weeks. And the rate card allows an uplift of CPI plus 4% rather than the CPI-only we asked for.',
    artifacts: [{ id: 'k-a1', name: 'Kestrel-MSA-notes.md', meta: 'Note · 3 flags', tone: 'doc' }],
  },
  {
    kind: 'message',
    id: 'k3',
    authorId: 'duet',
    at: '08:54',
    body: 'I can draft the pushback, but the auto-renewal is a commercial call rather than a legal one.',
    stacked: true,
  },
]

const BELLWEATHER_ENTRIES: readonly TeamEntry[] = [
  { kind: 'day', id: 'b-day', label: 'Yesterday' },
  {
    kind: 'message',
    id: 'b1',
    authorId: 'priya',
    at: '14:02',
    body: 'New client — Bellweather Foods, kickoff on Friday. @duet can you get us ready?',
  },
  {
    kind: 'message',
    id: 'b2',
    authorId: 'duet',
    at: '14:02',
    body: "Yes. Atlas will pull a company brief and draft the data request; I'll set the folder up from the onboarding template so Ada has somewhere to put the returns.",
  },
  {
    kind: 'handoff',
    id: 'b3',
    fromId: 'duet',
    toId: 'atlas',
    at: '14:03',
    task: 'Brief Bellweather Foods and draft the first data request',
    jobId: 'bellweather-brief',
    status: 'done',
    steps: [
      { label: 'Read the filed accounts', state: 'done' },
      { label: 'Check the trade press', state: 'done' },
      { label: 'Draft the data request', state: 'done' },
    ],
  },
  {
    kind: 'message',
    id: 'b4',
    authorId: 'duet',
    at: '15:40',
    body: 'Brief is in the folder. £42m turnover, three sites, and they moved to Sage in January — so the first-year cleanup is probably bigger than the proposal assumed.',
    artifacts: [
      { id: 'b-a1', name: 'Bellweather-brief.md', meta: 'Note · 4 pages', tone: 'doc' },
      { id: 'b-a2', name: 'Data-request.xlsx', meta: 'Sheet · 31 items', tone: 'sheet' },
    ],
  },
  {
    kind: 'message',
    id: 'b5',
    authorId: 'ada',
    at: '16:11',
    body: "Noted. I'll put the scope risk in front of Priya before Friday.",
  },
]

const HIRE_ENTRIES: readonly TeamEntry[] = [
  { kind: 'day', id: 'h-day', label: 'Yesterday' },
  {
    kind: 'message',
    id: 'r1',
    authorId: 'ada',
    at: '11:20',
    body: '@rhea applications closed for the senior analyst role. Can you screen them against the spec?',
  },
  {
    kind: 'message',
    id: 'r2',
    authorId: 'duet',
    at: '12:05',
    body: 'Screened 14. Four are worth a panel — two practice-side with audit experience, two from industry. The other ten are short on the modelling requirement rather than on sector, so widening the sector would not have helped.',
    artifacts: [
      { id: 'r-a1', name: 'shortlist.xlsx', meta: 'Sheet · 14 rows · 4 flagged', tone: 'sheet' },
    ],
  },
]

const PRICING_ENTRIES: readonly TeamEntry[] = [
  { kind: 'day', id: 'p-day', label: 'Monday' },
  {
    kind: 'message',
    id: 'p1',
    authorId: 'walter',
    at: '09:05',
    body: '@atlas how are the other five firms pricing advisory retainers now?',
  },
  {
    kind: 'message',
    id: 'p2',
    authorId: 'duet',
    at: '09:44',
    body: 'Three of the five have moved to usage pricing since March — a small base fee and a per-engagement charge on top. The two that held their retainers both raised them, one by 9% and one by 12%. Nobody is competing on the flat monthly any more.',
    artifacts: [{ id: 'p-a1', name: 'pricing-teardown.md', meta: 'Note · 5 firms', tone: 'doc' }],
  },
]

const DIGEST_ENTRIES: readonly TeamEntry[] = [
  { kind: 'day', id: 'd-day', label: 'Monday' },
  {
    kind: 'message',
    id: 'd1',
    authorId: 'duet',
    at: '07:00',
    body: 'Weekly digest — nothing here needs a decision. Cash is inside plan, no invoice is more than 60 days overdue, and the two open client queries are both with Priya.',
    artifacts: [{ id: 'd-a1', name: 'ops-digest.md', meta: 'Note · week 34', tone: 'doc' }],
  },
]

const HARBOR_SESSIONS: readonly TeamSession[] = [
  {
    id: 'q3-close',
    title: 'Q3 close — variance pack',
    memberIds: ['duet', 'ledger', 'priya', 'tomas'],
    live: true,
    lastAuthorId: 'duet',
    lastLine: 'Moved the Kestrel prepayment to accruals and asked Ledger to rebuild.',
    lastAt: '09:41',
    intro:
      'Started by Priya on Monday. Duet answers here unless you name somebody else, and brings in whichever agent owns the work.',
    composer: {
      kind: 'working',
      agentId: 'ledger',
      label: 'Ledger is rebuilding the variance pack',
      todos: [
        { label: 'Pull the September ledger', status: 'complete' },
        { label: 'Match against the bank feed', status: 'complete' },
        { label: 'Flag variances over 5%', status: 'active' },
        { label: 'Write the commentary', status: 'pending' },
      ],
    },
    entries: Q3_ENTRIES,
  },
  {
    id: 'kestrel-msa',
    title: 'Kestrel MSA review',
    memberIds: ['sable', 'duet', 'priya'],
    unread: 2,
    asking: true,
    lastAuthorId: 'duet',
    lastLine: 'Needs a decision on the 12-month auto-renewal.',
    lastAt: '08:54',
    intro:
      'Started by Priya this morning. Sable reads the contracts in this workspace; anything commercial still comes back to a person.',
    composer: {
      kind: 'waiting',
      label: 'Sable is waiting on you',
      question:
        'Do you want to let the 12-month renewal run, or serve notice before the window closes?',
    },
    entries: KESTREL_ENTRIES,
  },
  {
    id: 'bellweather',
    title: 'Bellweather onboarding',
    memberIds: ['duet', 'atlas', 'ada', 'priya'],
    unread: 5,
    lastAuthorId: 'duet',
    lastLine: 'Drafted the kickoff brief and the data it needs from the client.',
    lastAt: 'Yesterday',
    intro:
      'Started by Priya yesterday, before the client has been onboarded. What the team settles here becomes the kickoff pack.',
    entries: BELLWEATHER_ENTRIES,
  },
  {
    id: 'analyst-hire',
    title: 'Senior analyst — shortlist',
    memberIds: ['rhea', 'ada'],
    lastAuthorId: 'duet',
    lastLine: 'Screened 14 applications and shortlisted four.',
    lastAt: 'Yesterday',
    intro:
      'Started by Ada yesterday. Rhea screens against the spec in the folder, and nobody outside this chat sees the applications.',
    entries: HIRE_ENTRIES,
  },
  {
    id: 'pricing-teardown',
    title: 'Competitor pricing teardown',
    memberIds: ['atlas', 'walter'],
    lastAuthorId: 'duet',
    lastLine: 'Three of the five have moved to usage pricing since March.',
    lastAt: 'Monday',
    intro:
      'Started by you on Monday. Atlas does the reading; the teardown lands in the workspace as a note.',
    entries: PRICING_ENTRIES,
  },
  {
    id: 'ops-digest',
    title: 'Monday ops digest',
    memberIds: ['duet'],
    sleeping: true,
    lastAuthorId: 'duet',
    lastLine: 'Nothing to report. Next run Monday at 07:00.',
    lastAt: 'Mon 07:00',
    intro:
      'Duet opened this one itself and posts here every Monday at 07:00. Nobody has to be in the room for it to run.',
    composer: {
      kind: 'sleeping',
      label: 'Duet runs this digest every Monday at 07:00.',
      hint: 'Ask for anything in the meantime.',
    },
    entries: DIGEST_ENTRIES,
  },
]

export function findSessionIn(workspace: TeamWorkspace, id: string): TeamSession {
  return workspace.sessions.find(session => session.id === id) ?? workspace.sessions[0]!
}

const HARBOR_STARTERS: readonly { readonly label: string; readonly draft: string }[] = [
  {
    label: 'Chase the open invoices',
    draft: '@ledger which invoices are more than 30 days overdue?',
  },
  {
    label: 'Review a contract',
    draft: '@sable read the attached MSA and flag anything unusual on liability.',
  },
  { label: 'Brief me on a competitor', draft: '@atlas put together a one-page teardown of ' },
  { label: 'Start the week', draft: 'What needs a decision from me this week?' },
]

/* ============================================================================
   Jobs.

   A job is a session — that is the product's own settled answer
   (`specs/done/sessions-and-jobs`), not a new idea this mock is introducing.
   The chat is a session too; a job is one the chat dispatched, and the only
   thing that makes it a job rather than a chat is that something is running a
   machine inside it. So a job opens as a conversation, because it *is* one.

   Two rules carried over from the shipped agent jobs dialog rather than
   re-decided here. The states are the contract's four `SessionBucket`s, read in
   `SESSION_ACTIVITY_PRIORITY` order — asking first, because it is the only
   state the reader can clear. And the chat itself never appears in its own job
   list: it has a surface of its own, and folding it in would draw the
   conversation as work inside the panel built to list work beside it.
   ========================================================================= */

export type TeamJob = {
  readonly id: string
  /** The chat that dispatched it. A job with no parent is not a job. */
  readonly chatId: string
  readonly title: string
  /** Who is doing the work. */
  readonly agentId: string
  /** Who handed it over — usually the orchestrator, sometimes a person. */
  readonly dispatchedById: string
  readonly state: SessionBucket
  /** The one thing worth saying on a row this narrow. A clock's news is when it wakes. */
  readonly note: string
  readonly unread?: boolean
  /** Second line of the job's own header: where it came from and how long it has been. */
  readonly meta: string
  readonly steps?: readonly { readonly label: string; readonly state: 'done' | 'active' | 'todo' }[]
  /** What it produced, if it has produced anything yet. */
  readonly artifacts?: readonly TeamArtifact[]
  readonly entries: readonly TeamEntry[]
  /** Present while `state` is `asking`: what it is stuck on. */
  readonly question?: string
}

const HARBOR_JOBS: readonly TeamJob[] = [
  {
    id: 'whitfield-credit-note',
    chatId: 'q3-close',
    title: 'Whitfield credit note',
    agentId: 'ledger',
    dispatchedById: 'duet',
    state: 'asking',
    note: '4 min ago',
    unread: true,
    meta: 'Handed over by Duet at 09:41 · 4 min',
    question: 'Should the credit note land in September, or in the current period?',
    entries: [
      {
        kind: 'message',
        id: 'w1',
        authorId: 'duet',
        at: '09:41',
        body: 'The Whitfield retainer was billed twice on 14 September. Raise a credit note for the duplicate and put it in front of Priya to approve.',
      },
      {
        kind: 'message',
        id: 'w2',
        authorId: 'ledger',
        at: '09:44',
        body: 'Drafted. £3,750 against invoice INV-2291, referencing the original. One thing I will not decide on my own:',
        artifacts: [{ id: 'w-a1', name: 'CN-2291-draft.pdf', meta: 'Draft · £3,750', tone: 'doc' }],
      },
      {
        kind: 'message',
        id: 'w3',
        authorId: 'ledger',
        at: '09:44',
        body: 'Putting it in September keeps the quarter clean but reopens a period Tomás has already reconciled. Putting it in October leaves a known error inside the board pack.',
        stacked: true,
      },
    ],
  },
  {
    id: 'reconcile-september',
    chatId: 'q3-close',
    title: 'Reconcile September and build the Q3 variance pack',
    agentId: 'ledger',
    dispatchedById: 'duet',
    state: 'running',
    note: 'since 09:13',
    meta: 'Handed over by Duet at 09:13 · running 31 min',
    steps: [
      { label: 'Pull the September ledger', state: 'done' },
      { label: 'Match against the bank feed', state: 'done' },
      { label: 'Flag variances over 5%', state: 'active' },
      { label: 'Write the commentary', state: 'todo' },
    ],
    artifacts: [
      {
        id: 'j-a1',
        name: 'Q3-variance-pack.xlsx',
        meta: 'Sheet · 6 tabs · updated 09:31',
        tone: 'sheet',
      },
    ],
    entries: [
      {
        kind: 'message',
        id: 'j1',
        authorId: 'duet',
        at: '09:13',
        body: 'Reconcile September against the bank feed, flag anything over 5% against Q2, and write the commentary in the style of the pack already in the workspace. Tomás is re-authorising Xero, so the last four days may arrive late.',
      },
      {
        kind: 'message',
        id: 'j2',
        authorId: 'ledger',
        at: '09:19',
        body: 'Ledger pulled, 1,284 lines. Feed reaches the 26th so far — holding the last four days rather than reconciling against a partial.',
      },
      {
        kind: 'message',
        id: 'j3',
        authorId: 'ledger',
        at: '09:29',
        body: 'Feed is complete to the 30th. Everything matches except two items: a £48,200 Kestrel invoice with no matching PO, and the Whitfield retainer billed twice on the 14th.',
      },
      {
        kind: 'message',
        id: 'j4',
        authorId: 'walter',
        at: '09:33',
        body: 'Keep the commentary to one page — the board reads the appendix if it wants detail.',
      },
      {
        kind: 'message',
        id: 'j5',
        authorId: 'ledger',
        at: '09:34',
        body: 'One page. Working through the variances now — three of eleven are over 5%, all in cost of sales.',
      },
    ],
  },
  {
    id: 'board-pack-nudge',
    chatId: 'q3-close',
    title: 'Chase sign-off on the board pack',
    agentId: 'duet',
    dispatchedById: 'priya',
    state: 'scheduled',
    note: 'in 4 hrs',
    meta: 'Set by Priya at 09:15 · wakes at 16:00',
    entries: [
      {
        kind: 'message',
        id: 'n1',
        authorId: 'priya',
        at: '09:15',
        body: 'If the pack has not been signed off by 16:00, post in the chat and tag me and Tomás.',
      },
      {
        kind: 'message',
        id: 'n2',
        authorId: 'duet',
        at: '09:15',
        body: 'Set for 16:00 today. I will check whether the pack has been approved before I say anything, so a sign-off in the meantime cancels it.',
      },
    ],
  },
  {
    id: 'xero-reauth',
    chatId: 'q3-close',
    title: 'Re-authorise the Xero feed',
    agentId: 'duet',
    dispatchedById: 'duet',
    state: 'done',
    note: '09:26',
    meta: 'Handed over by Duet at 09:14 · took 12 min',
    entries: [
      {
        kind: 'message',
        id: 'x1',
        authorId: 'duet',
        at: '09:14',
        body: 'The September feed stops on the 26th. Ask Tomás to re-authorise and confirm when the last four days have landed.',
      },
      {
        kind: 'message',
        id: 'x2',
        authorId: 'duet',
        at: '09:26',
        body: 'Tomás re-authorised. The feed now reaches 30 September and Ledger has the missing days.',
      },
    ],
  },
  {
    id: 'august-close',
    chatId: 'q3-close',
    title: 'August close',
    agentId: 'ledger',
    dispatchedById: 'duet',
    state: 'done',
    note: 'Yesterday',
    meta: 'Handed over by Duet on Monday · took 1 hr 40 min',
    artifacts: [
      { id: 'aug-a1', name: 'August-variance-pack.xlsx', meta: 'Sheet · 6 tabs', tone: 'sheet' },
    ],
    entries: [
      {
        kind: 'message',
        id: 'aug1',
        authorId: 'duet',
        at: 'Mon 14:20',
        body: 'Same shape as July: reconcile, flag over 5%, one page of commentary.',
      },
      {
        kind: 'message',
        id: 'aug2',
        authorId: 'ledger',
        at: 'Mon 16:00',
        body: 'August closes clean. One variance over 5% — software licences, up 11% on the annual renewal that Tomás had already flagged.',
      },
    ],
  },
  {
    id: 'bellweather-brief',
    chatId: 'bellweather',
    title: 'Brief Bellweather Foods and draft the first data request',
    agentId: 'atlas',
    dispatchedById: 'duet',
    state: 'done',
    note: 'Yesterday',
    meta: 'Handed over by Duet yesterday at 14:03 · took 1 hr 37 min',
    artifacts: [
      { id: 'bw-a1', name: 'Bellweather-brief.md', meta: 'Note · 4 pages', tone: 'doc' },
      { id: 'bw-a2', name: 'Data-request.xlsx', meta: 'Sheet · 31 items', tone: 'sheet' },
    ],
    entries: [
      {
        kind: 'message',
        id: 'bw1',
        authorId: 'duet',
        at: '14:03',
        body: 'Read the filed accounts and whatever the trade press has, then draft the data request we send before kickoff.',
      },
      {
        kind: 'message',
        id: 'bw2',
        authorId: 'atlas',
        at: '15:40',
        body: '£42m turnover across three sites, and they moved to Sage in January — which is the part worth flagging, because the first-year cleanup will be bigger than the proposal assumed.',
      },
    ],
  },
]

export function jobsForChat(workspace: TeamWorkspace, chatId: string): readonly TeamJob[] {
  return workspace.jobs.filter(job => job.chatId === chatId)
}

export function findJobIn(workspace: TeamWorkspace, id: string): TeamJob | undefined {
  return workspace.jobs.find(job => job.id === id)
}

/** In flight is what the header counts: anything a person could still act on. */
export function liveJobCount(workspace: TeamWorkspace, chatId: string): number {
  return jobsForChat(workspace, chatId).filter(job => job.state !== 'done').length
}

/* ============================================================================
   The two workspaces.

   Harbor & Fenn is the one the rest of this fixture is about, and the reader
   there is the person who also maintains its agents. Merrow Health is the
   ordinary case and the reason it exists: the same account, a different
   membership, and no way across to the builder's surface. Nothing about the
   layout changes — the mode switch is simply not there, and Home is the first
   thing in the column.
   ========================================================================= */

const MERROW_PEOPLE: readonly TeamPerson[] = [
  { id: 'walter', name: 'Walter Monecke', role: 'Interim ops', external: true },
  { id: 'joan', name: 'Joan Okafor', role: 'Practice manager' },
  { id: 'devi', name: 'Devi Srinivasan', role: 'Clinical lead' },
]

const MERROW_AGENTS: readonly TeamAgent[] = [
  {
    id: 'duet',
    name: 'Duet',
    slug: 'duet',
    blurb: 'Answers here by default and hands the work to whoever owns it.',
    orchestrator: true,
    status: 'ready',
  },
  {
    id: 'rota',
    name: 'Rota',
    slug: 'rota',
    blurb: 'Builds the shift rota and chases the gaps.',
    status: 'working',
    activity: 'Filling next week',
  },
  {
    id: 'claims',
    name: 'Claims',
    slug: 'claims',
    blurb: 'Submits claims and follows up whatever comes back rejected.',
    status: 'ready',
  },
]

const MERROW_SESSIONS: readonly TeamSession[] = [
  {
    id: 'rota-next-week',
    title: 'Rota — week of 1 September',
    memberIds: ['rota', 'joan', 'walter'],
    live: true,
    lastAuthorId: 'duet',
    lastLine: 'Two gaps left on Thursday, both late shift.',
    lastAt: '11:20',
    intro:
      'Started by Joan this morning. Rota drafts the week and says what it could not fill; the gaps are always a person’s call.',
    composer: {
      kind: 'working',
      agentId: 'rota',
      label: 'Rota is filling next week',
      todos: [
        { label: 'Read the availability returns', status: 'complete' },
        { label: 'Draft the week', status: 'complete' },
        { label: 'Chase the two gaps', status: 'active' },
      ],
    },
    entries: [
      { kind: 'day', id: 'mr-day', label: 'Today' },
      {
        kind: 'message',
        id: 'mr1',
        authorId: 'joan',
        at: '11:02',
        body: '@rota can you draft next week? Devi is away Wednesday and Thursday.',
      },
      {
        kind: 'message',
        id: 'mr2',
        authorId: 'duet',
        at: '11:20',
        body: 'Drafted. Everything covers except Thursday late — two gaps, and the three people who could take them have all worked six days already.',
        artifacts: [{ id: 'mr-a1', name: 'rota-w36.xlsx', meta: 'Sheet · 7 days', tone: 'sheet' }],
      },
    ],
  },
  {
    id: 'claims-rejections',
    title: 'August claim rejections',
    memberIds: ['claims', 'joan'],
    unread: 3,
    lastAuthorId: 'duet',
    lastLine: 'Nine rejections, seven of them the same missing field.',
    lastAt: 'Yesterday',
    intro:
      'Opened by Duet when the August remittance landed. It posts here whenever a batch comes back with anything rejected.',
    entries: [
      { kind: 'day', id: 'mc-day', label: 'Yesterday' },
      {
        kind: 'message',
        id: 'mc1',
        authorId: 'duet',
        at: '16:40',
        body: 'August remittance is in. Nine rejections out of 412, and seven are the same thing — the referring clinician field is empty on anything booked through the new online form.',
        artifacts: [
          { id: 'mc-a1', name: 'august-rejections.xlsx', meta: 'Sheet · 9 rows', tone: 'sheet' },
        ],
      },
    ],
  },
  {
    id: 'supplier-review',
    title: 'Consumables supplier review',
    memberIds: ['duet', 'devi'],
    lastAuthorId: 'duet',
    lastLine: 'Pulled last year’s spend by supplier. Nothing needs you yet.',
    lastAt: 'Monday',
    intro: 'Started by Devi on Monday. Nothing has been handed off in here yet.',
    entries: [
      { kind: 'day', id: 'ms-day', label: 'Monday' },
      {
        kind: 'message',
        id: 'ms1',
        authorId: 'devi',
        at: '10:15',
        body: 'We are up for renewal in November. @duet what did we actually spend with each supplier last year?',
      },
      {
        kind: 'message',
        id: 'ms2',
        authorId: 'duet',
        at: '10:31',
        body: 'Pulled it. Three suppliers, £128k total, and 71% of it is with one of them — which is worth knowing before anybody negotiates.',
      },
    ],
  },
]

const MERROW_JOBS: readonly TeamJob[] = [
  {
    id: 'thursday-gaps',
    chatId: 'rota-next-week',
    title: 'Fill the two Thursday late shifts',
    agentId: 'rota',
    dispatchedById: 'joan',
    state: 'asking',
    note: '9 min ago',
    unread: true,
    meta: 'Handed over by Joan at 11:20 · 9 min',
    question: 'Offer the overtime rate, or leave Thursday short and move the clinic?',
    entries: [
      {
        kind: 'message',
        id: 'tg1',
        authorId: 'joan',
        at: '11:20',
        body: 'See who can take Thursday late without going over their hours.',
      },
      {
        kind: 'message',
        id: 'tg2',
        authorId: 'rota',
        at: '11:29',
        body: 'Nobody can, not without overtime. Three people are available and all three would be on day seven.',
      },
    ],
  },
  {
    id: 'rota-draft',
    chatId: 'rota-next-week',
    title: 'Draft the week of 1 September',
    agentId: 'rota',
    dispatchedById: 'joan',
    state: 'done',
    note: '11:20',
    meta: 'Handed over by Joan at 11:02 · took 18 min',
    artifacts: [{ id: 'rd-a1', name: 'rota-w36.xlsx', meta: 'Sheet · 7 days', tone: 'sheet' }],
    entries: [
      {
        kind: 'message',
        id: 'rd1',
        authorId: 'joan',
        at: '11:02',
        body: 'Same shape as last week, minus Devi on Wednesday and Thursday.',
      },
      {
        kind: 'message',
        id: 'rd2',
        authorId: 'rota',
        at: '11:20',
        body: 'Done. Everything covers except Thursday late.',
      },
    ],
  },
]

const HARBOR_APPS: readonly TeamApp[] = [
  {
    id: 'close-checklist',
    name: 'Close checklist',
    blurb: 'Where the month-end close has got to, and what is still open.',
    ownerAgentId: 'ledger',
    art: APP_ART.checklist,
    meta: '3 of 4 steps done',
  },
  {
    id: 'invoice-chaser',
    name: 'Invoice chaser',
    blurb: 'Who owes what, how old it is, and what has already been chased.',
    ownerAgentId: 'ledger',
    art: APP_ART.ledger,
    meta: '£61k outstanding',
  },
  {
    id: 'contract-shelf',
    name: 'Contract shelf',
    blurb: 'Every client MSA with the clauses that cost money pulled to the front.',
    ownerAgentId: 'sable',
    art: APP_ART.contract,
    meta: '2 renew within 90 days',
  },
  {
    id: 'hiring-board',
    name: 'Hiring board',
    blurb: 'Candidates by stage, with the panel’s notes against each one.',
    ownerAgentId: 'rhea',
    art: APP_ART.board,
    meta: '4 shortlisted',
  },
  {
    id: 'client-briefs',
    name: 'Client briefs',
    blurb: 'One page per prospect, refreshed the morning of the meeting.',
    ownerAgentId: 'atlas',
    art: APP_ART.brief,
    meta: 'Updated yesterday',
  },
]

const MERROW_APPS: readonly TeamApp[] = [
  {
    id: 'rota-board',
    name: 'Rota board',
    blurb: 'The week at a glance, with every gap marked.',
    ownerAgentId: 'rota',
    art: APP_ART.calendar,
    meta: '2 gaps next week',
  },
  {
    id: 'claims-tracker',
    name: 'Claims tracker',
    blurb: 'What has been submitted, what came back, and why.',
    ownerAgentId: 'claims',
    art: APP_ART.ledger,
    meta: '9 rejections in August',
  },
]

export const HARBOR: TeamWorkspace = {
  id: 'harbor-fenn',
  name: 'Harbor & Fenn',
  mark: 'H',
  builder: 'Studio Feld',
  viewerCanBuild: true,
  viewerId: 'walter',
  people: HARBOR_PEOPLE,
  agents: HARBOR_AGENTS,
  apps: HARBOR_APPS,
  sessions: HARBOR_SESSIONS,
  jobs: HARBOR_JOBS,
  starters: HARBOR_STARTERS,
  greetingDate: 'Tuesday, 25 August',
}

export const MERROW: TeamWorkspace = {
  id: 'merrow-health',
  name: 'Merrow Health',
  mark: 'M',
  builder: 'Studio Feld',
  viewerCanBuild: false,
  viewerId: 'walter',
  people: MERROW_PEOPLE,
  agents: MERROW_AGENTS,
  apps: MERROW_APPS,
  sessions: MERROW_SESSIONS,
  jobs: MERROW_JOBS,
  starters: [
    { label: 'Check this week’s rota', draft: '@rota is anything uncovered this week?' },
    { label: 'Chase a rejected claim', draft: '@claims what came back rejected in August?' },
    { label: 'Start the week', draft: 'What needs a decision from me this week?' },
  ],
  greetingDate: 'Tuesday, 25 August',
}

export const WORKSPACES: readonly TeamWorkspace[] = [HARBOR, MERROW]

export function findApp(workspace: TeamWorkspace, id: string): TeamApp | undefined {
  return workspace.apps.find(app => app.id === id)
}

/* ============================================================================
   Where an agent has been pulled in, and what it said when it got there.

   A chat is where work is asked for; a job is one piece of it. Neither is a
   record of the *agent*. Ask "is Ledger any good at this" and the answer is
   scattered across every room it was ever named in, which is the one question
   the surfaces above cannot answer.

   So this is the third view of the same events: not by room, not by task, but
   by the agent that did them — every time it was pulled in, what it produced,
   and whether a person has said yet if that was right. The verdict is the
   point. An audit trail nobody grades is a log; a log somebody grades is how
   the next answer gets better.
   ========================================================================= */

export type TeamVerdict = 'right' | 'wrong'

export type TeamPullIn = {
  readonly id: string
  readonly agentId: string
  /** The chat it was pulled into. */
  readonly chatId: string
  /** The job, when it was pulled in through one rather than directly. */
  readonly jobId?: string
  readonly day: string
  readonly at: string
  /** Who named it. */
  readonly askedById: string
  /** What they wanted, in one line. */
  readonly ask: string
  /** What it said back. This is the thing being judged. */
  readonly output: string
  readonly artifacts?: readonly TeamArtifact[]
  /** Absent until somebody has looked. */
  readonly verdict?: TeamVerdict
  /** What they said about it when they marked it. */
  readonly note?: string
}

export const PULL_INS: readonly TeamPullIn[] = [
  {
    id: 'p-ledger-1',
    agentId: 'ledger',
    chatId: 'q3-close',
    jobId: 'whitfield-credit-note',
    day: 'Today',
    at: '09:44',
    askedById: 'duet',
    ask: 'Raise a credit note for the duplicated Whitfield retainer',
    output:
      'Drafted. £3,750 against invoice INV-2291, referencing the original. Putting it in September keeps the quarter clean but reopens a period Tomás has already reconciled.',
    artifacts: [{ id: 'p1-a', name: 'CN-2291-draft.pdf', meta: 'Draft · £3,750', tone: 'doc' }],
  },
  {
    id: 'p-ledger-2',
    agentId: 'ledger',
    chatId: 'q3-close',
    day: 'Today',
    at: '09:31',
    askedById: 'priya',
    ask: 'Where did September land?',
    output:
      'September reconciles clean apart from two items — a £48,200 Kestrel invoice with no matching PO, and the Whitfield retainer billed twice on the 14th. Everything else is inside tolerance.',
    artifacts: [
      { id: 'p2-a', name: 'Q3-variance-pack.xlsx', meta: 'Sheet · 6 tabs', tone: 'sheet' },
    ],
    verdict: 'right',
    note: 'Exactly the level of detail the board pack needs. Keep leading with the exceptions.',
  },
  {
    id: 'p-ledger-4',
    agentId: 'ledger',
    chatId: 'q3-close',
    day: 'Today',
    at: '09:26',
    askedById: 'tomas',
    ask: 'Is the Kestrel invoice a miss?',
    output:
      'No matching purchase order, so I have flagged it as an exception and excluded it from the variance commentary until somebody confirms it.',
    verdict: 'wrong',
    note: 'It is a prepayment, not a miss. Check the MSA with @sable before calling something an exception.',
  },
  {
    id: 'p-ledger-3',
    agentId: 'ledger',
    chatId: 'q3-close',
    jobId: 'reconcile-september',
    day: 'Today',
    at: '09:19',
    askedById: 'duet',
    ask: 'Reconcile September against the bank feed',
    output:
      'Ledger pulled, 1,284 lines. Feed reaches the 26th so far — holding the last four days rather than reconciling against a partial.',
    verdict: 'right',
    note: 'Right call to hold. A partial reconciliation would have had to be redone.',
  },
  {
    id: 'p-ledger-5',
    agentId: 'ledger',
    chatId: 'q3-close',
    jobId: 'august-close',
    day: 'Monday',
    at: '16:00',
    askedById: 'duet',
    ask: 'Close August, same shape as July',
    output:
      'August closes clean. One variance over 5% — software licences, up 11% on the annual renewal Tomás had already flagged.',
    artifacts: [
      { id: 'p5-a', name: 'August-variance-pack.xlsx', meta: 'Sheet · 6 tabs', tone: 'sheet' },
    ],
    verdict: 'right',
  },
  {
    id: 'p-sable-1',
    agentId: 'sable',
    chatId: 'kestrel-msa',
    day: 'Today',
    at: '08:52',
    askedById: 'priya',
    ask: 'Anything in the Kestrel renewal I should push back on?',
    output:
      'Three things. Liability is capped at one month of fees, the renewal is automatic on 12 months with 90 days notice, and the rate card allows CPI plus 4% rather than the CPI-only we asked for.',
    artifacts: [{ id: 'ps1-a', name: 'Kestrel-MSA-notes.md', meta: 'Note · 3 flags', tone: 'doc' }],
  },
  {
    id: 'p-sable-2',
    agentId: 'sable',
    chatId: 'q3-close',
    day: 'Today',
    at: '09:40',
    askedById: 'duet',
    ask: 'How does the Kestrel MSA bill?',
    output: 'Annually in advance. The prepayment runs to 31 March.',
    verdict: 'right',
    note: 'One line, exactly what was asked. Do this more.',
  },
  {
    id: 'p-atlas-1',
    agentId: 'atlas',
    chatId: 'bellweather',
    jobId: 'bellweather-brief',
    day: 'Yesterday',
    at: '15:40',
    askedById: 'duet',
    ask: 'Brief Bellweather Foods before Friday',
    output:
      '£42m turnover across three sites, and they moved to Sage in January — which is the part worth flagging, because the first-year cleanup will be bigger than the proposal assumed.',
    artifacts: [{ id: 'pa1-a', name: 'Bellweather-brief.md', meta: 'Note · 4 pages', tone: 'doc' }],
    verdict: 'right',
    note: 'Leading with the commercial risk rather than the company facts is right.',
  },
  {
    id: 'p-atlas-2',
    agentId: 'atlas',
    chatId: 'pricing-teardown',
    day: 'Monday',
    at: '09:44',
    askedById: 'walter',
    ask: 'How are the other five pricing advisory retainers?',
    output:
      'Three of the five have moved to usage pricing since March. The two that held their retainers both raised them, one by 9% and one by 12%.',
    artifacts: [{ id: 'pa2-a', name: 'pricing-teardown.md', meta: 'Note · 5 firms', tone: 'doc' }],
  },
  {
    id: 'p-rhea-1',
    agentId: 'rhea',
    chatId: 'analyst-hire',
    day: 'Yesterday',
    at: '12:05',
    askedById: 'ada',
    ask: 'Screen the senior analyst applications',
    output:
      'Screened 14. Four are worth a panel. The other ten are short on the modelling requirement rather than on sector, so widening the sector would not have helped.',
    artifacts: [{ id: 'pr1-a', name: 'shortlist.xlsx', meta: 'Sheet · 14 rows', tone: 'sheet' }],
  },
]

export function pullInsFor(agentId: string): readonly TeamPullIn[] {
  return PULL_INS.filter(entry => entry.agentId === agentId)
}
