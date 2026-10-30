import { describe, expect, test } from 'bun:test'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

import {
  AGENT_TAGS,
  AgentConfigSchema,
  deriveListingMetadata,
  isPublishExcludedDrivePath,
  MAX_AGENT_TAGS,
  MAX_RECURSIVE_FILE_ENTRIES,
  resolveAgentConfig,
  resolveAgentTags,
} from '@repo/contract'

import { officialSeedAgents } from './manifest'
import {
  buildOfficialSyncPlan,
  CONTENT_DIR,
  loadOfficialSeedFiles,
  officialListingOrigins,
  readOfficialSeedFilesFromDisk,
  scopeToManifest,
} from './src'

/* What actually bounds this bundle, measured rather than guessed.
 *
 * BYTES are the real constraint and they bind on the gateway: the whole sync
 * arrives at `/converge-subtree` as ONE JSON body with every file base64'd,
 * and the handler decodes all of them into memory before writing any. Peak
 * cost is therefore several times the raw size, on a VM sized for idling. 16
 * MiB of content is already ~21 MiB of JSON; this is the number to defend.
 *
 * ENTRIES bind PER AGENT, not per bundle, and somewhere else entirely: a
 * listing is pulled as one agent folder over `?zip`, and both the gateway's
 * inspector and its puller refuse past `MAX_RECURSIVE_FILE_ENTRIES`. An agent
 * that crosses it cannot be installed at all. Nothing downstream cares how
 * many entries the whole tree has. The per-agent assertion protects installability.
 */
const MAX_COMFORTABLE_BYTES = 16 * 1024 * 1024

describe('official agent seed', () => {
  test('authored tree and live-row manifest agree', async () => {
    const authoredAgents = (await readdir(join(CONTENT_DIR, 'agents'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()

    // Every MANIFEST agent must have an authored root — but not the converse.
    // A folder may outlive its manifest entry: dropping an agent from the
    // manifest is demotion (it stops being managed and keeps serving), so
    // requiring exact equality here would forbid the thing the sync exists to
    // allow.
    for (const agent of officialSeedAgents) expect(authoredAgents).toContain(agent.slug)
    for (const agent of officialSeedAgents) {
      const root = join(CONTENT_DIR, agent.path)
      const agentsMd = await readFile(join(root, 'AGENTS.md'), 'utf8')
      const paragraphs = agentsMd.trim().split(/\n\s*\n/)
      expect(paragraphs[0]).toBe(`# ${agent.name}`)
      /* Paragraph one IS the store copy: `deriveListingMetadata` lifts it as
         the listing summary. Nothing pins it to a second declaration any more —
         the manifest used to carry a `description` that had to match this, and
         two places to write one sentence is one place too many. What still has
         to hold is that the paragraph exists and is prose, because a block of
         headings derives no summary at all. */
      expect(paragraphs[1]).toBeDefined()
      expect(paragraphs[1]!.startsWith('#')).toBe(false)
      const config = AgentConfigSchema.parse(
        JSON.parse(await readFile(join(root, 'agent.json'), 'utf8')),
      )
      /* Every official listing must carry at least one tag, or the catalog's
         filter hides it: there is no "untagged" chip, and a listing nobody can
         reach through the browse UI may as well not be published. The cap is
         what keeps a card's chip row readable. Asserting the RESOLVED tags —
         not the authored strings — is what catches a typo, which would
         otherwise drop silently and pass a length check on the raw array. */
      const tags = resolveAgentTags(config.tags)
      expect(tags.length).toBeGreaterThan(0)
      expect(tags.length).toBeLessThanOrEqual(MAX_AGENT_TAGS)
      /* Every official agent greets: the suggested first message is what an
         empty default chat opens on, and a blank one hands the first-contact
         moment back to the generic day-one intro. Asserted through the
         RESOLVER — the raw JSON passing while the resolver drops it (wrong
         type, whitespace) is exactly the failure this must catch. The cap
         keeps the greeting a bubble, not a pitch page. */
      const suggested = resolveAgentConfig(
        await readFile(join(root, 'agent.json'), 'utf8'),
      ).suggestedFirstMessage
      expect(suggested).toBeDefined()
      expect(suggested!.length).toBeLessThanOrEqual(300)
      expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toContain('Initial release.')
      /* An app is OPTIONAL and most agents have none. What is not optional is
         what an app must be once declared — these assertions used to run
         against every agent and pinned values the roster now legitimately
         needs to vary (an app that starts sessions declares scopes), so they
         became conditional rather than deleted. Deleting them would leave
         nothing between the catalog and an arbitrary install command. */
      for (const app of agent.apps ?? []) {
        expect(app.installCommand).toBeDefined()
        expect(app.installCommand!.length).toBeGreaterThan(0)
        expect(app.path.startsWith(`${agent.path}/apps/`)).toBe(true)
        expect((await lstat(join(CONTENT_DIR, app.path))).isDirectory()).toBe(true)

        /* An official app is drawn as its own artwork wherever the product
           shows one — the map's fan, the drive, the app's own page — and the
           fallback is initials. Every app here is one somebody will see on
           their first day, so "declares an icon" and "ships the file it
           declares" are both part of what official means. The icon is a path
           relative to the app's own folder, which is what the seed registers
           and what the drive then serves it from. */
        const icon = app.icon
        expect(icon).toBeDefined()
        expect((await lstat(join(CONTENT_DIR, app.path, icon!))).isFile()).toBe(true)
      }
    }
  })

  test('sync content is deterministic, floor-clean, link-free, and bounded for delivery', async () => {
    const first = buildOfficialSyncPlan()
    const second = buildOfficialSyncPlan()
    const paths = await authoredPaths(CONTENT_DIR)

    expect(first).toEqual(second)
    const files = loadOfficialSeedFiles()
    // Sync delivers raw content as base64 JSON, without archive padding.
    // Keep the existing raw-content memory budget for the actual serving path.
    expect(files.reduce((bytes, file) => bytes + file.bytes.byteLength, 0)).toBeLessThan(
      MAX_COMFORTABLE_BYTES,
    )

    // The binding limit: each agent folder is what a subscriber pulls, and the
    // gateway refuses one past this. An agent over it is uninstallable, which
    // no amount of headroom in the whole-tree count would reveal.
    for (const agent of officialSeedAgents) {
      const root = `${agent.path.replace(/\/+$/, '')}/`
      const owned = paths.filter(path => path.startsWith(root))
      expect(owned.length).toBeGreaterThan(0)
      expect(owned.length).toBeLessThan(MAX_RECURSIVE_FILE_ENTRIES)
    }
    for (const path of paths) {
      expect(path.split('/')).not.toContain('node_modules')
      expect(isPublishExcludedDrivePath(path)).toBe(false)
      expect((await lstat(join(CONTENT_DIR, path.replace(/\/$/, '')))).isSymbolicLink()).toBe(false)
    }
  })
})

describe('the authoring contract', () => {
  /* What separates an official agent from a preamble.
   *
   * The competition is NOT an empty agent — it is a Duet agent that already
   * carries go-to-market, firecrawl, media-creation, build-apps, publish,
   * elevenlabs and pdf. Against that, "prefer primary evidence" changes
   * nothing: a frontier model does it already when asked to research. Only
   * four things actually move behaviour, and they are checked structurally
   * because twenty-one independent authors will otherwise each invent their
   * own idea of what official means.
   *
   * Presence is enforced; wording is the author's. */
  const REQUIRED_SECTIONS = [
    // A rule that makes the agent stop or say no. A blank agent always says
    // yes, so an agent that cannot refuse is not adding one.
    { heading: '## Refuse', why: 'a refusal' },
    // Where work is written, so session two builds on session one.
    { heading: '## Artifacts', why: 'a named artifact layout' },
    // Which shared skills it uses, so it does not re-derive an API that
    // go-to-market already documents better.
    { heading: '## Delegates to', why: 'a delegation list' },
  ]

  test('every official agent carries its refusal, artifacts and delegation sections', async () => {
    for (const agent of officialSeedAgents) {
      const agentsMd = await readFile(join(CONTENT_DIR, agent.path, 'AGENTS.md'), 'utf8')
      for (const section of REQUIRED_SECTIONS) {
        if (!agentsMd.includes(section.heading)) {
          throw new Error(`${agent.slug} is missing ${section.why} (${section.heading})`)
        }
      }
    }
  })

  test('an authored onboarding interview is one an agent actually runs', async () => {
    /* `ONBOARDING.md` is loaded ONLY by an onboarding session, which only
       happens when `agent.json` declares an `onboarding` block. Author the file
       and forget the block and nothing complains: the agent is never locked,
       the session never opens, and the interview is bytes that ship and never
       execute. Nothing downstream can detect that, because from every reader's
       point of view an agent with no block is simply an agent with no
       onboarding.

       The converse fails just as quietly and costs more. An onboarding session
       is launched with the authored script and the generated completion
       contract and NOTHING else — `AGENTS.md` is deliberately withheld, so the
       interview does not know the seat, the connection, or what it is
       collecting. A chat block with no script therefore runs the contract's
       fallback ("ask the user what they want this agent to know"), completes,
       and never asks for the thing the seat requires. That is a safety net for
       an unscripted agent, not a shape an official one may ship in.

       App onboarding is exempt in both directions: it opens a page, never a
       session, so a script there would be bytes nothing loads. */
    for (const agent of officialSeedAgents) {
      const root = join(CONTENT_DIR, agent.path)
      const authored = await readFile(join(root, 'ONBOARDING.md'), 'utf8').catch(() => null)
      const config = resolveAgentConfig(await readFile(join(root, 'agent.json'), 'utf8'))
      if (config.onboarding?.kind === 'chat') {
        if (authored === null) {
          throw new Error(`${agent.slug} declares chat onboarding but authors no ONBOARDING.md`)
        }
        continue
      }
      if (authored !== null) {
        throw new Error(
          `${agent.slug} authors ONBOARDING.md that no session loads (onboarding is ${config.onboarding?.kind ?? 'undeclared'})`,
        )
      }
    }
  })

  test('onboarding app discovery uses the exact-path collection filter', async () => {
    const appPaths = {
      'code-reviewer': 'connect-repos',
      'seo-specialist': 'connect-search-console',
      'social-media-manager': 'connect-accounts',
      'support-agent': 'connect-helpdesk',
    } as const

    for (const [agentSlug, appSlug] of Object.entries(appPaths)) {
      const onboarding = await readFile(
        join(CONTENT_DIR, 'agents', agentSlug, 'ONBOARDING.md'),
        'utf8',
      )
      expect(onboarding).toContain(`APP_PATH="$AGENT_DIR/apps/${appSlug}"`)
      expect(onboarding).toContain('--data-urlencode "path=$APP_PATH"')
      expect(onboarding).toContain("--data-urlencode 'scope=exact'")
      expect(onboarding).toContain("--data-urlencode 'limit=1'")
      expect(onboarding).toContain("jq -er '.items[0].port'")
      expect(onboarding).not.toContain('.apps[]')
    }
  })

  test('paragraph one stays store copy, not the start of the prompt', async () => {
    /* It is lifted as the listing summary and rendered under a three-line
       clamp on the card. An author who opens with a heading or a bullet gets
       a listing that cannot describe itself. */
    for (const agent of officialSeedAgents) {
      const agentsMd = await readFile(join(CONTENT_DIR, agent.path, 'AGENTS.md'), 'utf8')
      const summary = agentsMd.trim().split(/\n\s*\n/)[1]
      expect(summary).toBeDefined()
      expect(summary!.startsWith('#')).toBe(false)
      expect(summary!.startsWith('-')).toBe(false)
      expect(summary!.length).toBeLessThanOrEqual(200)
    }
  })
})

describe('derived listing metadata', () => {
  /* The catalog card renders an agent's skills as chips and its detail page
     renders the changelog. Official agents ship both and the sync used to
     hardcode them empty, so the flagship listings were the emptiest rows in
     the catalog. Deriving from the authored bytes is the fix; asserting a
     named skill is what stops it silently regressing to `[]` again. */
  test('an official agent derives its real skills and changelog from its own bytes', () => {
    const origins = officialListingOrigins()
    const origin = origins.get('writer')
    expect(origin).toBeDefined()

    const derived = deriveListingMetadata(origin!)
    expect(derived).not.toHaveProperty('error')
    const metadata = derived as Exclude<typeof derived, { error: string }>

    expect(metadata.skills).toContain('editorial-pass')
    expect(metadata.changelog).toContain('Initial release.')
    expect(metadata.title).toBe('Writer')
    expect(metadata.summary.length).toBeGreaterThan(0)
  })

  test('every manifest agent derives metadata without a refusal', () => {
    const origins = officialListingOrigins()
    for (const agent of officialSeedAgents) {
      const origin = origins.get(agent.slug)
      expect(origin).toBeDefined()
      // A missing description paragraph is a typed refusal rather than a
      // throw, and an official agent must never be the listing that trips it.
      expect(deriveListingMetadata(origin!)).not.toHaveProperty('error')
    }
  })

  test('the derived tags reach the plan the sync actually sends', () => {
    const origins = officialListingOrigins()
    for (const agent of buildOfficialSyncPlan().agents) {
      const origin = origins.get(agent.slug)!
      expect([...agent.derived.tags].sort()).toEqual(
        [...JSON.parse(origin.agentJson ?? '{}').tags].sort(),
      )
    }
  })
})

describe('tag coverage across the catalog', () => {
  /* A filter chip that matches nothing is a dead end in the UI, so the roster
     and the vocabulary have to stay in step. This fails loudly while the
     catalog is small and incomplete — which is the point: it is the reminder
     that a tag without an agent should be cut rather than shipped empty. */
  test('every tag in the vocabulary has at least one official agent', () => {
    const covered = new Set(buildOfficialSyncPlan().agents.flatMap(agent => agent.derived.tags))
    expect([...AGENT_TAGS].filter(tag => !covered.has(tag))).toEqual([])
  })
})

describe('sync plan scoping', () => {
  // Every file under content/ already sits beneath a manifest root, so the
  // scope filter is unobservable against real content and would rot silently.
  // These synthetic paths are the only thing that proves it does anything.
  const managed = { path: 'agents/fixture-owned-agent' }

  test('a folder absent from the manifest is excluded, and a prefix twin is not mistaken for it', () => {
    const kept = { path: `${managed.path}/AGENTS.md` }
    const scoped = scopeToManifest(
      [
        kept,
        { path: 'agents/hub-only-agent/AGENTS.md' },
        // `agents/<slug>-extra` shares a string prefix with a managed root but
        // is a different folder: segment-safe scoping must drop it.
        { path: `${managed.path}-extra/AGENTS.md` },
      ],
      [managed],
    )

    expect(scoped).toEqual([kept])
  })

  test('the plan carries every managed agent, dot-directories included', () => {
    // Built SYNCHRONOUSLY from the generated module — the signature is the
    // guard. Reading content/ from disk is async, so a disk walk cannot hide in
    // here without changing this call site. That matters because serverless
    // packaging prunes dot-directories and the staging seed once shipped
    // without .agents/**.
    const plan = buildOfficialSyncPlan()

    // The plan is the manifest plus what the agent's own bytes say about it —
    // every managed agent, each carrying derived catalog metadata rather than
    // leaving the mutation to invent it.
    expect(plan.agents.map(agent => agent.slug)).toEqual(officialSeedAgents.map(a => a.slug))
    expect(plan.files.some(file => file.path.includes('/.agents/'))).toBe(true)
    for (const agent of plan.agents) {
      expect(plan.files.some(file => file.path === `${agent.path}/AGENTS.md`)).toBe(true)
      expect(agent.derived.summary.length).toBeGreaterThan(0)
      for (const app of agent.apps ?? []) {
        expect(plan.files.some(file => file.path.startsWith(`${app.path}/`))).toBe(true)
      }
    }
  })
})

async function authoredPaths(root: string): Promise<string[]> {
  const paths: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const path = relative(root, absolute).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        paths.push(`${path}/`)
        await visit(absolute)
      } else paths.push(path)
    }
  }
  await visit(root)
  return paths.sort()
}

test('the generated content module matches the authored tree', async () => {
  // Runtime code loads the generated module (bundler-proof: serverless
  // packaging pruned dot-directories from the on-disk asset tree and the
  // staging seed shipped without .agents/**). Regenerate with
  // `bun run codegen` after editing content/.
  const fromDisk = await readOfficialSeedFilesFromDisk()
  const fromModule = loadOfficialSeedFiles()
  expect(fromModule.map(file => [file.path, file.sha256])).toEqual(
    fromDisk.map(file => [file.path, file.sha256]),
  )
  expect(fromModule.some(file => file.path.includes('/.agents/'))).toBe(true)
})
