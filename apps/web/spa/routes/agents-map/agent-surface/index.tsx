'use client'

/* The surface's own look lives with the map's, because it is the map's: the
   same `--km-*` surfaces, the same hairlines, the same glass. Imported here so
   a host that mounts only this surface still gets them. */
import '../../../knowledge-map/knowledge-map.css'

/* ============================================================================
   One agent, unfolded on the map it lives on.

   ---- it is not a page, and the whole design is about that ----
   The camera has already flown into this agent's face and parked it in the gap
   this composition leaves for it. So the face at the top of the left column is
   not a picture of the agent, it *is* the agent, still standing on the canvas
   with its trunk running off under the glass towards the core. Nothing here
   draws an avatar; the first row of the left column is a *hole*, and the map is
   what measures it and flies the face into it.

   ---- two columns, and no middle ----
   Left is who this is and the one continuous conversation with them: the
   identity block hard against the top of the column, and the thread taking
   everything under it. Nothing else. A jobs panel used to be wedged between the
   two, which put the thread you came back to continue two thirds of the way
   down its own column; it later became a door beside the name, and then it left
   Build entirely — an agent's other sessions are Work's subject, and this
   surface holds the one conversation Build is about.

   Right is one card, and its body is whatever the reader picked in the single
   row of selectors across its top: the agent's apps, its folder on the drive,
   and the workspace desktop. The card opens on the agent's first app because
   that is the thing an agent is *for*.

   That row replaced a breadcrumb. A crumb named the one app the pane had
   resolved to and offered no way to any other — and inside an agent this is the
   only surface its apps exist on at all, because the ring puts them away the
   moment you come in.

   The row used to carry the agent's work and the drive's connections too. Both
   left: an agent's work is Work's list, and connections belong to the drive
   rather than to any one agent, so every agent drew the same list of them.

   ---- the agent is a cluster, not a card ----
   Its name is set beside the hole, the way out is tucked against the side of
   it, and the places it can take you sit under it — all on the canvas,
   none in a panel. That is what the map itself would draw if it could: a
   caption over a face. Wrapping the same four things in a card underneath
   produced a picture of the agent sitting below the agent, and cost a hand's
   width of the height the conversation actually wants.

   Everything else follows from the hole. The panels are glass rather than card,
   so the dimmed ring reads through them. They are inset, so the canvas frames
   them on four sides. The way out is a flight back to the ring rather than a
   close button, because nothing was opened.

   Presentational, like everything under this folder: the route owns the queries
   and the navigation. The conversation arrives as `chat` because it is a whole
   product surface with its own state, and this only frames it.
   ========================================================================= */
import {
  Desktop as DesktopIcon,
  HardDrive as HardDriveIcon,
  SquaresFour as SquaresFourIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useState, type ComponentProps, type ReactNode } from 'react'

import { AgentAvatar } from '../../../agents/agent-avatar'
import type { Read } from '../../../knowledge-map-data/use-agent-reads'
import type { AppItem, FileItem, Skill } from '../../../knowledge-map/types'
import type { HeaderItem } from './header-order'
import {
  AgentActions,
  EmptyStage,
  Notice,
  Pick,
  type PickDrag,
  PickMark,
  PickRow,
  ReadNotice,
  AgentOverflow,
  SectionHead,
  PaneSwitch,
} from './parts'
import { pickOf, stageOf, type AgentSurfaceShowing } from './stage'

export type { AgentSurfaceShowing } from './stage'

export type AgentSurfaceProps = {
  name: string
  /**
   * The second line under it — the slug, for an agent that has been given a name
   * of its own, and nothing at all otherwise. Handed in rather than derived: the
   * map draws the same pair on the face this surface unfolded from, and one of
   * them deciding for itself is how the two would come to disagree.
   */
  subtitle?: string
  /** the drive itself rather than one of the agents on it */
  duet?: boolean
  skills: Read<Skill>
  files: Read<FileItem>
  apps: Read<AppItem>
  /**
   * What the reader has picked, or null for whatever this agent leads with.
   *
   * Null rather than the first app, because the apps arrive after the agent
   * does — see `stageOf`.
   */
  showing: AgentSurfaceShowing | null
  onShow: (showing: AgentSurfaceShowing | null) => void
  /**
   * The way back to a folded roster, or nothing when the column is already out.
   *
   * This slot used to hold a back arrow out to the drive's picture of itself.
   * It is gone: the roster beside this surface reaches every agent and the
   * graph both, so a dedicated way out was a control for a journey the column
   * already makes in one click — and the button that opens a folded column had
   * nowhere in flow to stand, so it was floating on top of this agent's face.
   */
  openRoster?: ReactNode
  onOpenFile: (file: FileItem) => void
  /**
   * Everything that can be done to the app the card is showing, mounted by the
   * route on that app's own selector.
   *
   * One node rather than a set of callbacks: publishing an app, copying its
   * link and deleting it are a product surface with mutations and a
   * confirmation behind them, and this composition's business is only *where*
   * on the card they hang. Only the current selector wears it, which is why it
   * is a single node and not one per chip — the card shows one app at a time.
   */
  appMenu?: ReactNode
  /**
   * The agents one layer beneath this one. The ring defers a nested agent to
   * its parent — this row is where the parent honours that deferral, so a
   * grandchild is one click from the surface that owns it rather than a URL
   * you have to know.
   */
  childAgents?: readonly { id: string; name: string }[]
  onOpenChildAgent?: (id: string) => void
  /** where the drive's connections are made and repaired — the empty stage only */
  integrationsHref?: string
  /** the agent's own pages. Absent for Duet, which has none. */
  trainHref?: string
  settingsHref?: string
  /**
   * The row across the top of the card, in the order the reader arranged it.
   *
   * Solved by the route rather than here, because the order outlives the mount:
   * it is read from storage before the first frame and written back on every
   * drag, and a presentational surface that owned it would lose the arrangement
   * every time the reader flew to another agent and back.
   */
  row: readonly HeaderItem[]
  /** absent when the row is not this reader's to arrange */
  drag?: PickDrag
  /**
   * What to draw in the cluster's first row.
   *
   * Handed in for the same reason `subtitle` is: the ring draws this agent too,
   * and two surfaces each deciding what it looks like is how they come to
   * disagree. `avatarKey` is the slug, which is what `agentIdentityFromProfile`
   * has always meant by it — see `spa/sessions/session-agent.ts`, the one owner
   * of how an agent appears beside its own messages.
   */
  portrait: {
    avatarKey: string
    profile?: ComponentProps<typeof AgentAvatar>['profile']
    workspaceSlug?: string
  }
  /** the one continuous conversation, mounted by the route */
  chat: ReactNode
  /**
   * The one control over that conversation, at the end of its header's line.
   *
   * Mounted by the route for the same reason the conversation is: what it can
   * do depends on the route's own reads — whether there is a default chat at
   * all, and whether a first message is still landing — and this surface holds
   * none of them. Absent is ordinary: an owner nobody has written to yet has no
   * chat to act on.
   */
  chatAction?: ReactNode
  /**
   * The agent's own folder on the drive, mounted by the route.
   *
   * The drive is a whole product surface with its own navigation, so it arrives
   * the same way the conversation and the app do. It opens *on this agent* — see
   * the route — rather than at the root the reader would have to walk down from.
   */
  drive?: ReactNode
  /** This agent's route into the one shared workspace desktop. */
  desktop?: ReactNode
  /**
   * The app the card is showing, mounted by the route.
   *
   * A live product surface with its own frame and its own failure states, so it
   * arrives the same way the conversation does. Absent while the route has not
   * caught up with `showing` — the row still marks the app, because it is the
   * app that is being looked at either way.
   */
  app?: ReactNode
  /**
   * The agent's own setup, when it has not been done — its onboarding app, or a
   * panel offering the conversation that does it. Present ONLY while the agent
   * is locked, and then it is the whole surface.
   *
   * Everything else here is about an agent you can use. A locked one cannot
   * hold a conversation (the composer answers that it is unavailable), and
   * reaches its other apps only after this is finished — so the two
   * columns would be a column of absences beside the one thing to do. The
   * surface collapses to one: the agent's own cluster, and this under it.
   *
   * A node rather than a target, because which of the two shapes it takes is a
   * question about the agent's config and its app list, and both of those are
   * the route's reads. Its `state` is what the *header* needs: a locked agent's
   * cluster is dressed as the onboarding it is — centred, on its own measure,
   * with the word for what this is over the name and one line about how it ends
   * under it — and which line that is depends on which shape is below.
   *
   * The header, and only the header. A second bar over the body would be a
   * title under a title: this surface already names the agent at the top of
   * itself, and that is the header an onboarding gets to wear.
   */
  setup?: {
    /** Which setup presentation is below the header. */
    state: 'ready' | 'waiting' | 'chat' | 'app' | 'blocked'
    body: ReactNode
  }
}

export function AgentSurface({
  name,
  subtitle,
  duet = false,
  skills,
  files,
  apps,
  showing,
  onShow,
  openRoster,
  childAgents,
  onOpenChildAgent,
  onOpenFile,
  appMenu,
  integrationsHref,
  trainHref,
  settingsHref,
  row,
  drag,
  portrait,
  chat,
  chatAction,
  app,
  drive,
  desktop,
  setup,
}: AgentSurfaceProps) {
  const t = useTranslations('duetApp.agentSurface')
  /* What dragging does, said here rather than handed in by the route: the word
     lives in this surface's namespace, and a caller reading a different one can
     only ask for it by a name its own catalogue does not have. */
  const dragLabel = drag === undefined ? undefined : t('reorder')

  /* Which of the two panes the narrow composition is showing. Meaningless at
     every other width — the stylesheet only reads `data-pane` inside the
     container query — and held here anyway, because the alternative is asking
     JavaScript how wide the container is, which is the question a container
     query exists to answer and the one a fixture box and a split view get wrong.

     Seeded rather than synced: a URL that names a card is a reader asking to
     look at it, so a cold landing on `…/apps/invoices` opens on the work pane
     and a bare agent path opens on the conversation. After that the reader owns
     it, and the only thing that moves it is picking something — which is what
     `show` below is for. No effect writes this from `showing`; an effect that
     did would drag the pane back under a reader who had just left it. */
  /* Arriving at an agent means the conversation, unless the address said
     otherwise. A bare agent path resolves to the agent's *folder* — `files-entry`
     redirects to its registered anchor — which is the card having something to
     draw rather than a request to look at it. On the wide composition that
     distinction costs nothing because both are on screen; on a phone it decides
     what the reader lands on, and landing a reader in a file browser when they
     asked for an agent is the wrong first screen for this product.

     So: no card named at mount, open on the conversation. A card named at mount —
     a link straight to `…/apps/invoices` — open on it. */
  const [chosen, setChosen] = useState<'chat' | 'work' | null>(() =>
    showing === null ? 'chat' : null,
  )
  /* What the URL is naming, as a value rather than as an object. `showing` is
     rebuilt every render — `{ kind: 'files' }` is a new object each time — so
     comparing it by identity would report a change on every pass and reset the
     reader's choice continuously. The key is what actually changed. */
  const cardKey =
    showing === null ? 'none' : showing.kind === 'app' ? `app:${showing.app.id}` : showing.kind
  /* The agent is part of the subject too. A pane choice belongs to the agent the
     reader made it on, so walking from one agent to another has to hand the
     next one its own default rather than whatever was showing on the last. */
  const showingKey = `${name}|${cardKey}`
  const [seenKey, setSeenKey] = useState(showingKey)
  /* Reset during render rather than in an effect. When the URL comes to name a
     different card — a chip in the roster, a link in a message, the browser's
     own back button — the reader's last choice is stale and has to give way, and
     doing that in an effect renders the wrong pane first and corrects it after
     paint. This was a real defect rather than a hypothetical one: the card
     changed underneath a reader who stayed looking at the conversation, so a
     deep link to `…/files` opened on the chat and appeared to do nothing. */
  if (seenKey !== showingKey) {
    /* The entry redirect settling is not the reader moving. `none` → something is
       what arriving looks like — the route resolving the agent's own default
       card a tick after mount — and treating it as navigation would drag a reader
       who has not touched anything onto the card and undo the rule above. Every
       other transition is a real move and takes the pane with it. */
    const arriving = seenKey === `${name}|none`
    setSeenKey(showingKey)
    if (!arriving) setChosen(null)
  }
  /* Named a card, so open on the card; named the agent, so open on the
     conversation. `showing` is the URL's own reading and is null for a bare
     agent path — the row's default that `stageOf` falls back to is a fallback
     for what the card *draws*, never a request to look at it. */
  const pane: 'chat' | 'work' = chosen ?? (showing !== null ? 'work' : 'chat')
  const setPane = setChosen
  /* Picking a view is asking to see it. On the wide composition the card is
     already on screen and this changes nothing; on the narrow one it is the
     difference between a selector that works and one that appears to do nothing. */
  const show = useCallback(
    (next: AgentSurfaceShowing) => {
      setChosen('work')
      onShow(next)
    },
    [onShow],
  )
  const identity = { trainHref, settingsHref }
  const stage = stageOf(showing, apps, row)
  const current = pickOf(stage)
  /* The row names apps by id; this is how a selector gets the record behind it.
     The card can be drawing an app while the list is still in flight — that is
     the whole of `stageOf`'s reading state — so the stage's own app is the
     fallback, and a title is never left blank while something is on screen. */
  const appOf = (id: string | undefined): AppItem =>
    apps.items.find(candidate => candidate.id === id) ??
    (stage.kind === 'app' ? stage.app : ({ id: id ?? '', title: '' } as AppItem))

  return (
    <section
      aria-label={name}
      className="km-sheet"
      data-mode={setup === undefined ? undefined : 'setup'}
      data-pane={setup === undefined ? pane : undefined}
    >
      <div className="km-sheet-left">
        {/* Left to right rather than stacked: the face, and then everything that
            is said about it. It is the first thing in the column and there is
            nothing above it but the air the canvas needs to fade its own edge —
            a band of empty glass over an agent's own name is the one place on
            this surface where whitespace says nothing at all. */}
        <div className="km-well">
          {openRoster}

          {/* The agent's own face, drawn here. This used to be a *hole* — an
              empty box the map measured and flew the clicked face into — and
              the whole apparatus behind that (the well's ref, the camera's
              framing, the scrim punched around it) is gone with it. A page
              draws its subject; it does not borrow one from a canvas
              underneath.

              `.km-face` stays because the class is the geometry — the
              `--km-well` box, and the `justify-self` it takes under the narrow
              container query — and that is unchanged. What changed is that
              something is painted in it. */}
          <AgentAvatar
            className="km-face"
            avatarKey={portrait.avatarKey}
            duet={duet}
            profile={portrait.profile}
            workspaceSlug={portrait.workspaceSlug}
            priority
          />

          {/* The name and the three doors are one block, set against the face
              rather than under it: two lines, one left edge, and the pair
              optically centred on the face they belong to. */}
          <div className="km-ident">
            {/* Name and slug are one line of the block rather than two: the gap
                inside a pair belongs to the pair, and the grid's own step is
                the distance to the *doors*. */}
            {/* The one word that says this cluster is not the ordinary one.
                Inside the block rather than over it, because the block IS the
                header — the eyebrow, the name and the line under it are one
                thing the stylesheet centres and measures as a unit. */}
            {setup !== undefined && <p className="km-eyebrow">{t('setupEyebrow')}</p>}
            <div className="min-w-0 km-well-cap">
              <h2 className="truncate km-name">{name}</h2>
              {subtitle !== undefined && <p className="truncate km-well-sub">{subtitle}</p>}
            </div>
            {setup !== undefined && (
              <p className="km-setup-note">
                {t(
                  {
                    ready: 'setupNoteReady',
                    waiting: 'setupNoteWaiting',
                    chat: 'setupNoteChat',
                    app: 'setupNoteApp',
                    blocked: 'setupNoteBlocked',
                  }[setup.state],
                )}
              </p>
            )}
            <div className="km-well-acts">
              <AgentActions identity={identity} />
            </div>
            {childAgents !== undefined && childAgents.length > 0 && (
              /* The one-layer rule's other half: the ring shows this agent, and
                 this agent shows its own. A nav rather than decoration — each
                 chip is the same door the ring would have been if the child
                 were on it. */
              <nav
                aria-label={t('childAgents')}
                className="km-well-cap flex flex-wrap items-baseline gap-1.5"
              >
                {/* The eyebrow answers the cold read's fair question — a bare
                    named pill under a button row could be a status or a tag.
                    Captioned, the row reads as what it is: this agent's own
                    agents, each pill a door. */}
                <span className="km-eyebrow">{t('childAgents')}</span>
                {childAgents.map(child => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onOpenChildAgent?.(child.id)}
                    className="rounded-full border border-border/60 bg-background/70 px-2.5 py-0.5 text-xs text-foreground/90 backdrop-blur-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {child.name}
                  </button>
                ))}
              </nav>
            )}
          </div>

          {/* The same doors, behind one control, for the composition that has
              no room for a row of them. Rendered at every width and shown at
              one — the stylesheet decides, because the question is about the
              container and not about the device. */}
          <AgentOverflow
            identity={identity}
            label={t('views')}
            trainLabel={t('train')}
            settingsLabel={t('settings')}
          />
        </div>

        {/* A grid, not a flex child: the conversation is a `<section>` that
            sizes itself from the route container it normally sits directly in,
            and a grid item stretches to its cell without the shared component
            needing to know it is in a panel.

            One heading, and it is this one. The conversation brings its own
            header on its own route — a title you can rename, a status line, a
            menu — and inside this panel that was a second bar of chrome directly
            under a bar that already said what the panel was. `bare` is the
            surface being told the host has already named it. */}
        {/* Withheld during setup: a locked agent cannot start a session, so the
            panel could only say so. Nothing replaces it — the column ends at
            the agent's own cluster and the setup takes the room. */}
        {setup === undefined && (
          <div className="km-chat" id="km-pane-chat">
            <SectionHead title={t('chat')} action={chatAction} />
            <div className="grid min-h-0 min-w-0 overflow-hidden">{chat}</div>
          </div>
        )}
      </div>

      {/* The switch, between the identity block and whichever pane it chose. It
          is drawn at every width and laid out at one — see `.km-pane-switch`.

          Withheld during setup for the same reason the card is: a locked agent
          has no conversation and no other view, so there is nothing to choose
          between and the surface is already one column. */}
      {setup === undefined && (
        <PaneSwitch
          pane={pane}
          onPane={setPane}
          label={t('views')}
          chatLabel={t('chat')}
          /* The card's own subject, not a category. `stage` is what the card is
             actually drawing — which is not always what the URL asked for, since
             an app the list has not answered for yet is drawn as a stub — so the
             segment says the same word the reader can see on the pick that is
             lit. The two reading states have no subject to name, and the row's
             own word for itself is the honest fallback. */
          workLabel={
            stage.kind === 'app'
              ? appOf(stage.app.id).title
              : stage.kind === 'files'
                ? t('files')
                : stage.kind === 'desktop'
                  ? t('desktop')
                  : t('views')
          }
          /* The same mark the row's own selectors carry, so a list that is still
             arriving — or that failed — says so on the segment too, and a reader
             sitting in the conversation is not told everything is settled. */
          workMark={<PickMark icon={<SquaresFourIcon aria-hidden size={13} />} read={apps} />}
        />
      )}

      {setup !== undefined ? (
        /* One thing to do, and no row of selectors above it: the other views
           are the agent's apps, its folder, and the desktop, and none is reachable work
           until this finishes. */
        <div className="km-card" data-stage="setup">
          <div className="km-stage">{setup.body}</div>
        </div>
      ) : (
        <div className="km-card" id="km-pane-work" data-stage={stage.kind}>
          <header className="km-picker">
            {/* One strip, in the reader's own order. It used to be two — the apps
              on the left and everything else pinned to the far end behind a
              hairline — which said those were different kinds of thing. They are
              not: each one is a face of this agent, and which of them you want
              to arrive at is the reader's business, not the layout's. */}
            <PickRow keys={row.map(item => item.key)} drag={drag} label={t('views')}>
              {row.map(item =>
                item.kind === 'app' ? (
                  <Pick
                    key={item.key}
                    current={current}
                    pick={item.key}
                    onPick={() => show({ kind: 'app', app: appOf(item.appId) })}
                    sortable={drag !== undefined}
                    label={dragLabel}
                    /* Every selector wears a mark, apps included. The rest of the
                     row carrying one and the apps carrying none read as the odd
                     one out rather than as the important one. */
                    mark={<PickMark icon={<SquaresFourIcon aria-hidden size={13} />} read={apps} />}
                    /* Publishing it, copying its link, deleting it — and only on
                     the one the card is showing, which is the only app the menu
                     could be about. It used to be a door out to a page of the
                     app's own; that page is gone and this is where its controls
                     came to live. */
                    menu={appMenu}
                    /* And the room for it is kept whether or not this is the app
                       being shown, so picking one moves nothing. */
                    menuSlot
                  >
                    {appOf(item.appId).title}
                  </Pick>
                ) : item.kind === 'files' ? (
                  <Pick
                    key={item.key}
                    current={current}
                    pick={item.key}
                    onPick={() => show({ kind: 'files' })}
                    sortable={drag !== undefined}
                    label={dragLabel}
                    mark={<PickMark icon={<HardDriveIcon aria-hidden size={13} />} read={files} />}
                  >
                    {t('files')}
                  </Pick>
                ) : (
                  <Pick
                    key={item.key}
                    current={current}
                    pick={item.key}
                    onPick={() => show({ kind: 'desktop' })}
                    sortable={drag !== undefined}
                    label={dragLabel}
                    mark={<PickMark icon={<DesktopIcon aria-hidden size={13} />} />}
                  >
                    {t('desktop')}
                  </Pick>
                ),
              )}
            </PickRow>
          </header>

          {/* The app takes the whole card and nothing frames it: it is a product
            surface in its own right, and a reading column around it would be
            this surface's opinion about somebody else's layout. Everything else
            is reading, so it gets a column and a margin. */}
          {stage.kind === 'app' ? (
            <div className="km-stage">{app ?? <Notice>{t('pending')}</Notice>}</div>
          ) : stage.kind === 'files' ? (
            /* The drive's own surface, whole, with no reading column around it —
             the same rule the apps get, and for the same reason: it is somebody
             else's product and its layout is not this card's opinion. */
            <div className="km-stage">{drive ?? <Notice>{t('pending')}</Notice>}</div>
          ) : stage.kind === 'desktop' ? (
            <div className="km-stage">{desktop ?? <Notice>{t('pending')}</Notice>}</div>
          ) : (
            /* Neither remaining stage is the reader's: the app list is
             still out, or this agent reaches nothing at all. Both are reading
             rather than a product surface, so both get a column and a margin. */
            <div className="km-view">
              <div className="km-scroll min-h-0 overflow-y-auto px-[14px] py-4">
                {/* A notice is one sentence about the whole card, so it is centred
                  on the whole card. The empty stage is a column of things to
                  read, and it starts on the same left edge the row above it
                  does — a measure rather than a container width, because a title
                  with its meta nine hundred pixels to the right is a table, and
                  this is a list. */}
                {stage.kind === 'reading' ? (
                  <ReadNotice read={apps} />
                ) : (
                  <div className="grid w-full max-w-2xl gap-2">
                    <EmptyStage
                      skills={skills}
                      files={files}
                      onOpenFile={onOpenFile}
                      integrationsHref={integrationsHref}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
