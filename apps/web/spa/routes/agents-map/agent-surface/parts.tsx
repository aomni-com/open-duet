'use client'

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import {
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
/* ============================================================================
   The material the agent surface is cut from.

   The surface next door decides where an agent's things belong on the screen.
   What a door looks like, what "needs you" is coloured, and what happens when a
   read fails are not its business — so every one of those lives here exactly
   once, and the composition arranges them.

   ---- it never rounds a missing answer down to zero ----
   Every list arrives as a `Read`: rows *and* the phase the query is in. An
   agent with no files and an agent whose folder listing failed both hand over
   an empty array, and a panel given only the array prints the same confident
   "0" for both. Nothing here prints a count it has not been told is final, and
   a failed read says so in words.
   ========================================================================= */
import {
  ArrowUpRightIcon,
  DotsThree as DotsThreeIcon,
  GraduationCapIcon,
  PlugsIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/shadcn/dropdown-menu'

/* The same roving-tabindex rule the window's own tab bar keeps, so two tablists
   in one product do not answer an arrow key differently. */
import { rovingTabIndexForKey } from '../../../drive/tab-keyboard'
import type { Read } from '../../../knowledge-map-data/use-agent-reads'
import type { FileItem, Skill, Tone } from '../../../knowledge-map/types'

/** Where an agent can take you. Duet has none of these: it *is* the drive. */
export type AgentIdentity = {
  trainHref?: string
  settingsHref?: string
}

/* ---------------------------------------------------------------- the state
   The map's own state colours rather than a second set: `data-tone` is what the
   map's stylesheet already keys `--km-tone` off, so a dot in here and the badge
   on the same agent's face out on the ring cannot disagree about what "needs
   you" looks like. Only two of the five are saturated, which is the map's rule
   and not this file's to change: colouring "finished" and "on a clock" as
   loudly as "needs you" is how a map turns into a dashboard.
   `currentColor` is the fallback for a fixture rendered outside the canvas. */
export function StateDot({ tone, size = 6 }: { tone: Tone; size?: number }) {
  return (
    <span
      aria-hidden
      data-tone={tone}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full bg-[var(--km-tone,currentColor)]"
    />
  )
}

/** Train and settings, set under the name of the agent they belong to. */
export function AgentActions({ identity }: { identity: AgentIdentity }) {
  const t = useTranslations('duetApp.agentSurface')
  return (
    <>
      {identity.trainHref !== undefined && (
        <ActionLink href={identity.trainHref} icon={<GraduationCapIcon aria-hidden size={13} />}>
          {t('train')}
        </ActionLink>
      )}
      {identity.settingsHref !== undefined && (
        <ActionLink
          href={identity.settingsHref}
          icon={<SlidersHorizontalIcon aria-hidden size={13} />}
        >
          {t('settings')}
        </ActionLink>
      )}
    </>
  )
}

export function ActionLink({
  href,
  icon,
  children,
}: {
  href: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <Link to={href} className="km-act">
      {icon}
      {children}
    </Link>
  )
}

/** Header actions share the thread's height budget, so keep them on one line. */
export function SectionHead({
  title,
  note,
  action,
}: {
  title: string
  note?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-4 pt-3 pb-1.5">
      <h3 className="km-eyebrow">{title}</h3>
      {note !== undefined && <span className="truncate km-meta-text">{note}</span>}
      {action}
    </div>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-1.5 px-4 py-4 text-center km-quiet">
      {children}
    </p>
  )
}

/** The two phases that are not rows, drawn the same way wherever they appear. */
export function ReadNotice({ read }: { read: Read<unknown> }) {
  const t = useTranslations('duetApp.agentSurface')
  return (
    <Notice>
      {read.phase === 'error' && <WarningCircleIcon aria-hidden size={15} weight="duotone" />}
      {t(read.phase === 'error' ? 'failed' : 'pending')}
    </Notice>
  )
}

/* The mark a selector wears: the destination's own icon, carrying the state of
   the list behind it rather than sitting beside a second dot. One glyph doing
   both jobs keeps the chip the width of its word, and a row of five chips does
   not turn into a row of ten small round things.

   A read that is still arriving or has failed says so by going quiet — it must
   never resolve to a confident zero, which is the lie this surface is most
   prone to telling. */
export function PickMark({ icon, read }: { icon: ReactNode; read?: Read<unknown> }) {
  return (
    <span className="km-pick-mark" data-phase={read?.phase ?? 'ready'} aria-hidden>
      {icon}
    </span>
  )
}

/* ------------------------------------------------- the row at the top of it
   One selector per thing the card can show, read left to right in whatever
   order the reader has put them in — see `header-order.ts`. There are no
   sections: a section claims two of these are a different kind of thing, and to
   somebody choosing what to look at they are answers to one question.

   It replaced a breadcrumb that named the one app the pane had resolved to and
   offered no way to any other. Inside an agent this is the only surface its
   apps exist on at all, because the ring puts them away the moment you come in.

   Not `role="tablist"`. Tabs promise arrow-key navigation between them, and a
   row that takes the role without the behaviour is worse for a reader on a
   keyboard than a row of ordinary buttons — which is what these are, each one
   saying whether it is the current one.

   ---- and the reader can rearrange it ----
   Dragged with the pointer, and moved with the keyboard by the same two keys
   that would otherwise do nothing here: a row that can only be arranged by
   dragging is a row that half the people using it cannot arrange. The grab is on
   the whole chip rather than a handle, because a handle small enough not to
   crowd a short word is too small to aim at — and a chip that is already a
   button gives the pointer somewhere obvious to land.

   `draggable` rather than pointer capture: the native drag is what gives the
   reader the drag image, the escape-to-cancel, and the cursor the platform uses
   for this everywhere else, none of which is worth re-implementing badly. */
/* The row is sortable, and it is `@dnd-kit` that makes it so.

   Hand-rolled first, on the HTML5 drag API, and it was wrong in two ways at
   once. `draggable` on a button is swallowed by Chrome and Safari, so the row
   moved for a test dispatching events and for nobody using a mouse. And even
   where the drag started, nothing moved *during* it: the native API hands you a
   ghost image and a drop target and no way to show the row rearranging itself,
   which is the only feedback that tells a reader the gesture is working.

   dnd-kit because it is the maintained one, and because of what it is built on:
   pointer events rather than the native drag controller, so a button is just an
   element; a keyboard sensor with the same semantics as the pointer one, so the
   accessible path is the library's job rather than a second implementation of
   mine; and transforms during the drag, which is what makes the neighbours slide
   out of the way. */
export type PickDrag = {
  /** `moved` lands where `onto` is */
  onDrop: (moved: string, onto: string) => void
}

/**
 * The strip, with everything in it sortable.
 *
 * `closestCenter` rather than the default rectangle intersection: the chips are
 * different widths — an app's title against the word "Files" — and intersection
 * makes a wide neighbour easy to hit and a narrow one nearly impossible.
 * Restricted to the horizontal axis and to the strip itself, because a row that
 * can be dragged upward off its own card is a row that looks broken while you
 * use it.
 */
export function PickRow({
  keys,
  drag,
  label,
  children,
}: {
  keys: readonly string[]
  /** absent when the row is not this reader's to arrange */
  drag?: PickDrag
  label: string
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      /* A chip is a button first. Without a threshold the press that switches
         the view is read as the start of a drag and the click never lands. */
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const strip = (
    <div role="group" aria-label={label} className="km-picks">
      {children}
    </div>
  )
  if (drag === undefined) return strip
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
      accessibility={{ announcements: undefined }}
      onDragEnd={event => {
        const over = event.over
        if (over === null || over.id === event.active.id) return
        drag.onDrop(String(event.active.id), String(over.id))
      }}
    >
      <SortableContext items={[...keys]} strategy={horizontalListSortingStrategy}>
        {strip}
      </SortableContext>
    </DndContext>
  )
}

export function Pick({
  current,
  pick,
  onPick,
  mark,
  menu,
  menuSlot = false,
  sortable = false,
  label,
  children,
}: {
  current: string | null
  pick: string
  onPick: () => void
  /** the map's own reading of the list behind it, and only when it is not quiet */
  mark?: ReactNode
  /** what can be done to the thing this selector names, offered only while it is current */
  menu?: ReactNode
  /**
   * Whether this selector is the kind that can carry a menu, which is a
   * different question from whether it is carrying one *now*.
   *
   * The room is reserved either way. A trigger that appears on selection is a
   * trigger that widens the chip and pushes every chip after it sideways — the
   * fault this row has already been fixed for twice, once for a bolder label and
   * once for a chip that vanished mid-drag. Selection may change what the row
   * says; it must never change where the row is.
   */
  menuSlot?: boolean
  /** whether this row is the reader's to arrange */
  sortable?: boolean
  /** what dragging does, said once so a reader on a keyboard is told too */
  label?: string
  children: ReactNode
}) {
  const current_ = pick === current
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: pick,
    disabled: !sortable,
  })

  /* One shell around every selector, whether or not it has a door. It used to be
     put on only when a chip was current and had somewhere to open, which made
     the current chip a *different box* from the ones beside it — and the box it
     borrowed was `.km-chip`, a name a list of skills further down this file was
     already using for something with a border and nine pixels of padding. The
     app selector came out ten pixels taller than everything else in the row. */
  return (
    <span
      ref={setNodeRef}
      className="km-pick-slot"
      data-menu-slot={menuSlot ? 'true' : undefined}
      data-current={current_ ? 'true' : undefined}
      data-held={isDragging ? 'true' : undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        aria-current={current_ ? 'true' : undefined}
        onClick={onPick}
        className="km-pick"
        title={sortable ? label : undefined}
        {...attributes}
        {...listeners}
      >
        {mark}
        <span className="truncate">{children}</span>
      </button>
      {/* Everything that can be done to what the chip names, and only while that
          is what you are looking at. It lives in the shell rather than beside the
          row because an action parked at the far end had to say which app it
          meant, and that sentence was longer than the row had room for.

          Outside the drag listeners on purpose: they are on the chip, so the
          trigger stays an ordinary button and a press on it opens the menu
          rather than lifting the chip. */}
      {menu !== undefined && current_ && menu}
    </span>
  )
}

/* --------------------------------------------------------- skills and files
   The quiet two thirds of what an agent has. They are drawn apart rather than
   together, because they answer different questions: what it knows how to do
   belongs beside who it is, and what it keeps belongs beside what it reaches. */
export function SkillChips({ skills }: { skills: Read<Skill> }) {
  const t = useTranslations('duetApp.agentSurface')
  return (
    <Group read={skills} title={t('tabs.skills')} empty={t('emptySkills')}>
      <ul className="flex flex-wrap gap-1.5">
        {skills.items.map(skill => (
          <li key={skill.id} className="km-chip">
            <SparkleIcon aria-hidden size={13} weight="duotone" className="text-muted-foreground" />
            {skill.title}
          </li>
        ))}
      </ul>
      <ReadMore read={skills} />
    </Group>
  )
}

export function FileRows({
  files,
  onOpenFile,
}: {
  files: Read<FileItem>
  onOpenFile: (file: FileItem) => void
}) {
  const t = useTranslations('duetApp.agentSurface')
  return (
    <Group read={files} title={t('tabs.files')} empty={t('emptyFiles')}>
      <ul className="grid gap-1">
        {files.items.map(file => (
          <li key={file.id}>
            <Row
              onClick={() => onOpenFile(file)}
              title={file.title}
              badge={file.folder === true ? t('folder') : file.kind}
            >
              {/* a folder has no size, and "0 B" would be a worse answer than
                  nothing at all */}
              {file.size === undefined ? file.when : `${file.size} · ${file.when}`}
            </Row>
          </li>
        ))}
      </ul>
      <ReadMore read={files} />
    </Group>
  )
}

function ReadMore<T>({ read }: { read: Read<T> }) {
  const t = useTranslations('duetApp.agentSurface')
  if ((read.hasMore !== true && read.moreFailed !== true) || read.onLoadMore === undefined)
    return null
  return (
    <button
      type="button"
      disabled={read.loadingMore}
      onClick={read.onLoadMore}
      className="km-row mt-2 w-full justify-center text-xs font-medium disabled:pointer-events-none disabled:opacity-60"
    >
      {read.loadingMore ? t('loadingMore') : read.moreFailed ? t('retry') : t('loadMore')}
    </button>
  )
}

/* The stage when the agent reaches no app to put on it.
   It says the one thing that is true and offers the one thing to do about it,
   and then shows what the agent *does* have — because a pane that is empty
   because a query returned nothing and a pane that is empty because the design
   forgot about it look identical, and only one of them is honest. */
export function EmptyStage({
  skills,
  files,
  onOpenFile,
  integrationsHref,
}: {
  skills: Read<Skill>
  files: Read<FileItem>
  onOpenFile: (file: FileItem) => void
  integrationsHref?: string
}) {
  const t = useTranslations('duetApp.agentSurface')
  return (
    <div className="grid gap-8">
      <section className="grid justify-items-start gap-2.5">
        <PlugsIcon aria-hidden size={22} weight="duotone" className="text-muted-foreground" />
        <p className="km-body">{t('emptyApps')}</p>
        {integrationsHref !== undefined && (
          <ActionLink href={integrationsHref}>{t('connectApp')}</ActionLink>
        )}
      </section>
      <SkillChips skills={skills} />
      <FileRows files={files} onOpenFile={onOpenFile} />
    </div>
  )
}

const SETUP_EXPECTED_SECONDS = 30

/**
 * The setup that has not arrived yet: the one control before it starts, a
 * bounded progress expectation once it is in flight, or the passive handoff
 * shown to a viewer who cannot perform onboarding.
 */
export function SetupStage({
  action,
  waiting = false,
}: {
  action?: ReactNode
  /**
   * The setup is on its way — its conversation is being opened, or its app is
   * still starting — so this is a wait rather than a thing to press.
   *
   * No control at all, because the control would be the same call that is
   * already in flight: a button offered here is one a reader presses twice
   * while wondering why nothing happened. The bar approaches completion over
   * the usual 30-second startup without claiming the app is ready; the real app
   * record remains the only thing that ends this state.
   */
  waiting?: boolean
}) {
  const t = useTranslations('duetApp.agentSurface')
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  useEffect(() => {
    if (!waiting) {
      setElapsedSeconds(0)
      return
    }
    const startedAt = Date.now()
    const timer = window.setInterval(
      () =>
        setElapsedSeconds(
          Math.min(SETUP_EXPECTED_SECONDS, Math.floor((Date.now() - startedAt) / 1_000)),
        ),
      1_000,
    )
    return () => window.clearInterval(timer)
  }, [waiting])
  const progress = Math.round((elapsedSeconds / SETUP_EXPECTED_SECONDS) * 90)
  const progressTime =
    elapsedSeconds < SETUP_EXPECTED_SECONDS
      ? t('setupProgressRemaining', { seconds: SETUP_EXPECTED_SECONDS - elapsedSeconds })
      : t('setupProgressLonger')
  return (
    <div className="grid h-full content-center justify-items-center overflow-y-auto px-6 py-10">
      {waiting ? (
        <div className="grid w-full max-w-lg justify-items-center gap-5 rounded-2xl border border-brand/20 bg-card px-8 py-8 text-center shadow-md">
          <span className="grid size-11 place-items-center rounded-full bg-brand/10 text-brand">
            <SparkleIcon aria-hidden size={22} weight="duotone" />
          </span>
          <div role="status" className="grid gap-1">
            <p className="text-lg font-semibold text-foreground">{t('setupPreparing')}</p>
            <p className="text-sm leading-5 text-foreground/70">
              {t('setupPreparingBody', { seconds: SETUP_EXPECTED_SECONDS })}
            </p>
          </div>
          <div className="grid w-full gap-2">
            <div className="flex items-center justify-between text-xs font-semibold text-foreground/75">
              <span>{t('setupProgressValue')}</span>
              <span>{progressTime}</span>
            </div>
            <div
              role="progressbar"
              aria-label={t('setupProgressLabel')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-valuetext={progressTime}
              className="h-2.5 w-full overflow-hidden rounded-full bg-foreground/10"
            >
              <span
                aria-hidden
                className="block h-full w-full origin-left rounded-full bg-gradient-to-r from-brand/70 via-brand to-brand/80 transition-transform duration-300 ease-out motion-reduce:transition-none"
                style={{ transform: `scaleX(${progress / 100})` }}
              />
            </div>
          </div>
        </div>
      ) : action !== undefined ? (
        <div className="w-full max-w-[15rem]">{action}</div>
      ) : (
        <p className="max-w-sm text-center text-sm leading-6 text-foreground/70">
          {t('setupOwnerRequired')}
        </p>
      )}
    </div>
  )
}

/** One shell for all of them, so pending, failed and empty look the same. */
export function Group({
  read,
  title,
  empty,
  children,
}: {
  read: Read<unknown>
  title: string
  empty: string
  children: ReactNode
}) {
  return (
    /* `content-start`, because a group beside a taller one is stretched to
       match it and auto rows share the slack out — which walks the heading down
       the page and opens a hand's width under it. */
    <section className="grid min-w-0 content-start gap-2">
      <h3 className="flex items-center gap-2.5 km-eyebrow">
        {title}
        <span className="h-px flex-1 bg-[color-mix(in_srgb,var(--km-line)_70%,transparent)]" />
      </h3>
      {read.phase !== 'ready' ? (
        <ReadNotice read={read} />
      ) : read.items.length === 0 ? (
        <p className="px-1 py-1.5 km-quiet">{empty}</p>
      ) : (
        children
      )}
    </section>
  )
}

/** One row, whatever it holds: a name, a line of meta, and where it goes. */
export function Row({
  title,
  badge,
  onClick,
  children,
}: {
  title: string
  badge?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" onClick={onClick} className="km-row group">
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate km-body leading-5">{title}</span>
        <span className="block truncate km-quiet">{children}</span>
      </span>
      {badge !== undefined && <span className="km-badge-pill">{badge}</span>}
      <ArrowUpRightIcon
        aria-hidden
        size={13}
        /* Drawn on touch, revealed on hover — the mark that says this row opens
           something is the only thing distinguishing it from a line of text, and
           `group-hover` says nothing at all to a finger. */
        className="shrink-0 text-muted-foreground opacity-60 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100"
      />
    </button>
  )
}

/* ---------- the two panes, and the control that chooses between them ----------
   Drawn at every width and shown at one: the stylesheet keeps `.km-pane-switch`
   out of the layout until the container is too narrow to hold both panes at
   once. Rendering it unconditionally is deliberate — whether there is room for
   two columns is a question about the *container*, and a container query is the
   only thing that can answer it. A JS width read here would be answering a
   different question and would be wrong inside a split view, a fixture box, and
   every case the sheet's own comment already lists.

   A tablist rather than two buttons, because that is what it is: two panels, one
   showing. The second segment is named for whatever the card is currently
   holding, so the reader is never asked to guess what is behind it. */
export function PaneSwitch({
  pane,
  onPane,
  label,
  chatLabel,
  workLabel,
  chatMark,
  workMark,
}: {
  pane: 'chat' | 'work'
  onPane: (pane: 'chat' | 'work') => void
  label: string
  chatLabel: string
  /** the name of the thing the card is showing — an app's title, Files, Desktop */
  workLabel: string
  /** each pane's own reading, so a change while you are on the other one shows */
  chatMark?: ReactNode
  workMark?: ReactNode
}) {
  const segments = [
    { key: 'chat' as const, text: chatLabel, mark: chatMark, panel: 'km-pane-chat' },
    { key: 'work' as const, text: workLabel, mark: workMark, panel: 'km-pane-work' },
  ]
  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className="km-pane-switch">
      {segments.map((segment, index) => (
        <button
          key={segment.key}
          type="button"
          role="tab"
          aria-selected={pane === segment.key}
          aria-controls={segment.panel}
          /* One stop for the pair, which is what a tablist is: arrow keys move
             between the segments and Tab leaves for the pane itself. */
          tabIndex={pane === segment.key ? 0 : -1}
          onClick={() => onPane(segment.key)}
          onKeyDown={event => {
            const step = rovingTabIndexForKey(event.key, index, segments.length)
            if (step === null) return
            event.preventDefault()
            onPane(segments[step]!.key)
          }}
          className="km-pane-seg"
        >
          {segment.mark}
          <span>{segment.text}</span>
        </button>
      ))}
    </div>
  )
}

/* ---------- the doors, behind one control ----------
   On the phone composition the doors stop being a row and become a menu. That
   is not the same trade as hiding them: a row of 28px links inside a 170px
   column was unreachable, and the reason they had to be *drawn* was that
   nothing else in the product leads to Train or Settings. A menu with a
   permanent 40px trigger leads to both, and gives the conversation back the
   pixels the row was spending.

   Both this and `AgentActions` are always rendered, and the stylesheet shows one
   or the other. A JS width read would be the wrong instrument — whether there is
   room for a row of doors is a question about the *container*, which is the
   thing a container query can answer and `window.innerWidth` cannot.

   The trigger used to carry an unread dot, because one of the doors behind it
   was Jobs and a door with something waiting behind it has to say so even when
   it is folded away. Both remaining doors are configuration rather than
   conversation, so there is nothing left for the mark to be about. */
export function AgentOverflow({
  identity,
  label,
  trainLabel,
  settingsLabel,
}: {
  identity: AgentIdentity
  label: string
  trainLabel: string
  settingsLabel: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="km-overflow" aria-label={label}>
          <DotsThreeIcon aria-hidden size={20} weight="bold" />
        </button>
      </DropdownMenuTrigger>
      {/* Aligned to the end, because the trigger is the last thing in the header
          row and a menu that opens leftward off a right-hand control is the one
          shape that never runs off the screen. */}
      {/* `km-hues` because this content is portalled to the document body, and the
          state tones every mark on this surface reads (`--km-*`) are declared on
          `.knowledge-map`. Without it the unread dot falls back to `currentColor`
          and comes out the same near-black as the label beside it — which an
          unprimed reviewer read as a stray full stop, in a product that has
          already taught them a blue dot means something new.

          The rows are `h-11`: a dropdown is the one context where the only thing
          a reader does is tap, and the desktop default put three 30px rows
          against each other with no separation. */}
      <DropdownMenuContent
        align="end"
        className="km-hues min-w-52 [&_[role=menuitem]]:h-11 [&_[role=menuitem]]:gap-2.5 [&_[role=menuitem]]:text-sm"
      >
        {identity.trainHref !== undefined && (
          <DropdownMenuItem asChild>
            <Link to={identity.trainHref}>
              <GraduationCapIcon aria-hidden size={16} />
              {trainLabel}
            </Link>
          </DropdownMenuItem>
        )}
        {identity.settingsHref !== undefined && (
          <DropdownMenuItem asChild>
            <Link to={identity.settingsHref}>
              <SlidersHorizontalIcon aria-hidden size={16} />
              {settingsLabel}
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
