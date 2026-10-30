import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type BrowserContext } from '@playwright/test'

import { WhoamiResponseSchema } from '@repo/contract'
import { buildOfficialSyncPlan } from '@repo/official-agents-seed'

import { createApiApp } from '../../../apps/api/src/index.ts'
import appEn from '../../../apps/web/messages/en/app.json'
import { getOnboardingGoal } from '../../../apps/web/spa/onboarding/onboarding-goals.ts'
import { composePurpose } from '../../../apps/web/spa/onboarding/onboarding-purpose.ts'
import { convexDev, type ConvexDevFixture } from './convex-dev.ts'
import { generateAuthKeys, signInWithMagicLink, uniqueEmail } from './convex-testing.ts'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const BACKEND_DIR = join(ROOT_DIR, 'packages/backend')
const WEB_DIR = join(ROOT_DIR, 'apps/web')
const NEXT_BIN = join(ROOT_DIR, 'node_modules/next/dist/bin/next')
const INTERNAL_KEY = 'local-onboarding-e2e-internal-key'
const AUTH_CODE = '0123456789abcdef0123456789abcdef'
const ASSISTANT_NAME = 'Milo'
const GOAL_ID = 'grow-business'
const GOAL_TILE_LABEL = 'Grow my business'
/**
 * Read from the shipped catalog, not written down: the walk presses Continue
 * once per question the goal actually asks. A constant here would either
 * strand the walk on a question it never advanced past, or press into the
 * next step and count that press as a follow-up.
 */
const FOLLOW_UP_COUNT = getOnboardingGoal(GOAL_ID).questions.length
const PROCESS_TIMEOUT_MS = 600_000
const BROWSER_TIMEOUT_MS = 180_000

/**
 * The purpose the walk below must store: the picked goal composed with every
 * smart default, through the same composer and English catalog copy the app
 * ships. The walk types nothing on the follow-ups, so this IS the no-typing
 * guarantee's output.
 */
const EXPECTED_PURPOSE = composePurpose({ goalId: GOAL_ID }, key => {
  let node: unknown = (appEn as { duetOnboarding: unknown }).duetOnboarding
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') break
    node = (node as Record<string, unknown>)[part]
  }
  if (typeof node !== 'string') throw new Error(`Missing duetOnboarding message: ${key}`)
  return node
})

export interface LocalOnboardingE2eResult {
  email: string
  workspaceSlug: string
  duetName: string
  onboardedAt: number
}

export async function runLocalOnboardingE2e(): Promise<LocalOnboardingE2eResult> {
  const webPort = await reserveLocalPort()
  const apiPort = await reserveLocalPort()
  const webUrl = `http://localhost:${webPort}`
  const apiUrl = `http://localhost:${apiPort}`
  const email = uniqueEmail('local-onboarding')
  let convex: ConvexDevFixture | undefined
  let apiServer: ReturnType<typeof Bun.serve> | undefined
  let webServer: ManagedProcess | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined

  try {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_APP_URL: webUrl,
        DUET_API_URL: apiUrl,
        DUET_VM_TOKEN_DERIVE_SECRET: 'local-onboarding-e2e-vm-secret',
        DUET_TEST_AUTH_CODE: AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        AUTH_GOOGLE_ID: 'local-onboarding-google-id',
        AUTH_GOOGLE_SECRET: 'local-onboarding-google-secret',
      },
      readyTimeoutMs: 180_000,
      reset: true,
    })

    const seedStartedAt = Date.now()
    await seedOfficialCatalog(convex)
    console.log(`[local-onboarding-e2e] official catalog seeded in ${Date.now() - seedStartedAt}ms`)

    const api = createApiApp({
      convexUrl: convex.url,
      internalKey: INTERNAL_KEY,
      appUrl: webUrl,
      waitUntil: promise => {
        promise.catch(() => undefined)
      },
    })
    apiServer = Bun.serve({ hostname: '127.0.0.1', port: apiPort, fetch: api.fetch })
    await waitForHttp(`${apiUrl}/`, undefined)

    const nextEnvironment = localNextEnvironment({
      convexUrl: convex.url,
      apiUrl,
      webUrl,
    })
    await runProcess('Next.js production build', ['node', NEXT_BIN, 'build'], nextEnvironment)
    webServer = startProcess(
      'Next.js production server',
      ['node', NEXT_BIN, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)],
      nextEnvironment,
    )
    await waitForHttp(`${webUrl}/sign-in`, webServer)

    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS)

    await page.goto(`${webUrl}/sign-in?returnTo=%2F`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
    const [magicLinkIntent] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'POST' && url.pathname === '/api/auth/magic-link'
      }),
      page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click(),
    ])
    if (magicLinkIntent.status() !== 204) {
      throw new Error(
        [
          `magic-link intent returned ${magicLinkIntent.status()}`,
          `page=${page.url()}`,
          `request=${magicLinkIntent.request().url()}`,
          `origin=${magicLinkIntent.request().headers().origin ?? 'missing'}`,
          `body=${await magicLinkIntent.text()}`,
        ].join('\n'),
      )
    }

    const intentCookie = (await context.cookies(webUrl)).find(
      cookie => cookie.name === 'duet_magic_link_intent',
    )
    assert(intentCookie?.httpOnly, 'magic-link intent was not stored in an HttpOnly cookie')
    await page.goto(
      `${webUrl}/auth/magic-link/callback?returnTo=%2F&intent=${intentCookie.value}&code=${AUTH_CODE}`,
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForURL(url => url.pathname.endsWith('/onboarding'))
    const workspaceSlug = new URL(page.url()).pathname.split('/')[2]
    assert(workspaceSlug, 'workspace slug was absent before onboarding')

    await page.goto(`${webUrl}/w/${encodeURIComponent(workspaceSlug)}/files?path=launch`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForURL(url => url.pathname === `/w/${workspaceSlug}/onboarding`)
    assert.equal(new URL(page.url()).search, '', 'onboarding gate retained a deep return route')

    const onboarding = page.locator('[data-onboarding-step]')
    assert.equal(await onboarding.getAttribute('data-onboarding-step'), 'identity')
    assert.equal(await page.locator('[data-drive-shell="true"]').count(), 0)

    await onboarding
      .getByRole('textbox', { name: 'Assistant name', exact: true })
      .fill(ASSISTANT_NAME)
    await onboarding.locator('header').getByText(ASSISTANT_NAME, { exact: true }).waitFor()

    await onboarding.getByRole('button', { name: 'Continue', exact: true }).click()

    // Goal: a tile tap sets the goal and advances into the follow-ups.
    await waitForOnboardingStep(onboarding, 'goal')
    await onboarding.getByRole('button', { name: GOAL_TILE_LABEL, exact: true }).click()

    // The transition into team fires exactly one recommendations request.
    // Local Convex has no AI_GATEWAY_API_KEY, so this e2e permanently
    // exercises the fallback path: the endpoint still answers 200, with an
    // empty list, and the flow must not block on it.
    const recommendationsResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return (
        response.request().method() === 'POST' &&
        url.pathname.endsWith('/onboarding/recommendations')
      )
    })

    /* Follow-ups: every question the picked goal asks, each opening with
       exactly one chip already selected (the smart default). One Continue per
       question, typing nothing. */
    for (let question = 0; question < FOLLOW_UP_COUNT; question += 1) {
      const followUpIndex = String(question)
      await waitForOnboardingStep(onboarding, 'follow-ups')
      await page.waitForFunction(
        expected =>
          document.querySelector('[data-onboarding-step]')?.getAttribute('data-followup-index') ===
          expected,
        followUpIndex,
      )
      const preSelected = onboarding.locator('[data-onboarding-chip-row] [aria-pressed="true"]')
      await preSelected.first().waitFor()
      assert.equal(
        await preSelected.count(),
        1,
        `follow-up ${followUpIndex} did not pre-select exactly one chip`,
      )
      await onboarding.getByRole('button', { name: 'Continue', exact: true }).click()
    }

    await waitForOnboardingStep(onboarding, 'team')
    const degradedRecommendations = await recommendationsResponse
    assert.equal(
      degradedRecommendations.status(),
      200,
      'the recommendations endpoint must degrade to 200, never surface an error',
    )
    assert.deepEqual(
      await degradedRecommendations.json(),
      { recommendations: [] },
      'local Convex has no gateway key, so recommendations must fall back to empty',
    )

    // The fixture seeds the official catalog, so the team step must render the
    // real verified agent cards — and with no recommendations, no rail and no
    // skeleton may remain once the request has settled.
    const officialAgentCards = onboarding.locator('[data-marketplace-state]')
    await officialAgentCards.first().waitFor()
    assert(
      (await officialAgentCards.count()) > 0,
      'team step rendered no official agent cards despite the seeded catalog',
    )
    assert.equal(
      await onboarding.locator('[data-onboarding-recommendations]').count(),
      0,
      'the picked-for-you rail must be absent on the fallback path',
    )

    // The minimum-3 floor against the seeded catalog: disabled at 0 and 2
    // selections (with the pick-more hint), enabled at 3.
    const teamContinue = onboarding.getByRole('button', { name: 'Continue', exact: true })
    assert(await teamContinue.isVisible(), 'team Continue was not visible')
    assert.equal(
      await teamContinue.isEnabled(),
      false,
      'Continue was enabled with zero selections despite the healthy catalog',
    )
    const agentCheckboxes = onboarding.getByRole('checkbox')
    await agentCheckboxes.nth(0).click()
    await agentCheckboxes.nth(1).click()
    await onboarding.getByText('Pick 1 more agent to continue', { exact: true }).waitFor()
    assert.equal(
      await teamContinue.isEnabled(),
      false,
      'Continue was enabled at 2 of 3 required selections',
    )
    await agentCheckboxes.nth(2).click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button[type="submit"]')].some(
        button => !(button as HTMLButtonElement).disabled,
      ),
    )
    await teamContinue.click()

    await waitForOnboardingStep(onboarding, 'ready')

    const [completion] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().method() === 'POST' && url.pathname.endsWith('/onboarding')
      }),
      onboarding.getByRole('button', { name: 'Enter your workspace', exact: true }).click(),
    ])
    assert.equal(completion.status(), 200, 'workspace onboarding completion failed')
    const completionBody = completion.request().postDataJSON() as {
      duetName: string
      selectedNames?: string[]
      skip?: boolean
      purpose?: string
      goal?: string
    }
    assert.equal(completionBody.duetName, ASSISTANT_NAME)
    assert.equal(completionBody.purpose, EXPECTED_PURPOSE)
    assert.equal(completionBody.goal, GOAL_ID)
    assert(!('skip' in completionBody), 'the zero-select skip path fired despite three selections')
    assert.equal(
      completionBody.selectedNames?.length,
      3,
      'completion must carry exactly the three selected agents',
    )
    const completionResult = (await completion.json()) as {
      results: Array<{ name: string; ok: boolean }>
      pullError?: string
    }
    assert.deepEqual(
      completionResult.results.filter(result => !result.ok),
      [],
      'every selected agent must install successfully',
    )
    assert.deepEqual(
      completionResult.results.map(result => result.name).sort(),
      [...completionBody.selectedNames!].sort(),
      'install results must cover exactly the selected agents',
    )
    // Local Convex has no VM to apply the installed agents onto, so the
    // completion deterministically reports pull_failed and the UI degrades to
    // the install warning. That is this fixture's environment, pinned on
    // purpose: the degraded path must still hand the user their workspace on
    // the next click.
    assert.equal(
      completionResult.pullError,
      'pull_failed',
      'local completion should report the VM pull as failed',
    )
    await onboarding.getByText(/one or more optional agents could not be installed/).waitFor()
    await onboarding
      .getByRole('button', { name: 'Continue to your workspace', exact: true })
      .click()

    await page.waitForURL(url => /\/w\/[^/]+\/agents$/.test(url.pathname))
    await page.locator('[data-drive-shell="true"]').waitFor()
    await page.getByRole('tablist', { name: 'Workspace sections', exact: true }).waitFor()
    await page.locator('aside').getByText(ASSISTANT_NAME, { exact: true }).first().waitFor()

    const identityResult = await page.evaluate(async () => {
      const response = await fetch('/api/duet/whoami')
      return { status: response.status, body: await response.json() }
    })
    assert.equal(identityResult.status, 200, 'browser whoami failed after onboarding')
    const identityWorkspace = WhoamiResponseSchema.parse(identityResult.body).workspaces.find(
      workspace => workspace.slug === workspaceSlug,
    )
    assert.equal(identityWorkspace?.duetName, ASSISTANT_NAME)
    assert.equal(typeof identityWorkspace?.onboardedAt, 'number')

    const rawWorkspaces = (await convex.query('testing/workspaces:rawWorkspacesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ slug: string; duetName?: string; purpose?: string; onboardedAt?: number }>
    const rawWorkspace = rawWorkspaces.find(workspace => workspace.slug === workspaceSlug)
    assert.equal(rawWorkspace?.duetName, ASSISTANT_NAME)
    assert.equal(rawWorkspace?.purpose, EXPECTED_PURPOSE, 'composed purpose was not stored')
    assert.equal(rawWorkspace?.onboardedAt, identityWorkspace?.onboardedAt)

    await page.goto(`${webUrl}/w/${encodeURIComponent(workspaceSlug)}/onboarding`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForURL(url => url.pathname === `/w/${workspaceSlug}/agents`)
    assert.equal(await page.locator('[data-onboarding-step]').count(), 0)
    await page.locator('aside').getByText(ASSISTANT_NAME, { exact: true }).first().waitFor()

    return {
      email,
      workspaceSlug,
      duetName: ASSISTANT_NAME,
      onboardedAt: identityWorkspace!.onboardedAt!,
    }
  } finally {
    await context?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
    await webServer?.stop()
    await apiServer?.stop(true)
    await convex?.stop()
  }
}

/**
 * Seed the official agent listings into the fresh deployment, mirroring the
 * proven orchestration in `packages/backend/src/official-hub-seed.test.ts`:
 * an internal admin (`@duet.so`) drives `beginSync`/`completeSync` with the
 * full manifest plan, and the hub owner is a separate ordinary account so the
 * seed never depends on the owner's billing state. Both mutations are
 * idempotent, and `createWorkspaceRow`'s VM scheduling tolerates a local
 * Convex with no VM backend — the same way the e2e user's own signup does.
 */
async function seedOfficialCatalog(convex: ConvexDevFixture): Promise<void> {
  const admin = await signInWithMagicLink<{ _id: string }>(
    convex,
    uniqueEmail('local-onboarding-admin').replace(/@[^@]+$/, '@duet.so'),
    'Onboarding Seed Admin',
    AUTH_CODE,
  )
  const ownerEmail = uniqueEmail('local-onboarding-hub-owner')
  await signInWithMagicLink(convex, ownerEmail, 'Official Hub Owner', AUTH_CODE)
  const provenance = {
    internalKey: INTERNAL_KEY,
    actorId: admin.user._id,
    requestId: 'local-onboarding-e2e-seed',
    reason: 'Seed the official catalog for the local onboarding e2e',
  }
  await convex.mutation('domains/internalAdmin/officialHub:beginSync', {
    ...provenance,
    ownerEmail,
    now: Date.now(),
  })
  await convex.mutation('domains/internalAdmin/officialHub:completeSync', {
    ...provenance,
    agents: buildOfficialSyncPlan().agents,
    now: Date.now(),
  })
}

async function waitForOnboardingStep(
  onboarding: import('@playwright/test').Locator,
  step: string,
): Promise<void> {
  await onboarding
    .page()
    .waitForFunction(
      expected =>
        document.querySelector('[data-onboarding-step]')?.getAttribute('data-onboarding-step') ===
        expected,
      step,
    )
}

function localNextEnvironment(args: {
  convexUrl: string
  apiUrl: string
  webUrl: string
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_CONVEX_URL: args.convexUrl,
    DUET_API_URL: args.apiUrl,
    DUET_APP_URL: args.webUrl,
  }
  delete environment.CONVEX_DEPLOYMENT
  delete environment.NEXT_PUBLIC_POSTHOG_KEY
  delete environment.NEXT_PUBLIC_POSTHOG_HOST
  delete environment.VERCEL
  return environment
}

interface ManagedProcess {
  output(): string
  stop(): Promise<void>
  child: ChildProcessWithoutNullStreams
}

function startProcess(
  label: string,
  command: string[],
  environment: NodeJS.ProcessEnv,
): ManagedProcess {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: WEB_DIR,
    env: environment,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = `[${label}]\n`
  const append = (chunk: Buffer | string) => {
    log = `${log}${chunk.toString()}`.slice(-40_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.on('error', append)
  return {
    child,
    output: () => log,
    async stop() {
      if (child.exitCode !== null || child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        Bun.sleep(10_000).then(() => {
          if (child.exitCode !== null || child.pid === undefined) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            child.kill('SIGKILL')
          }
        }),
      ])
    },
  }
}

async function runProcess(
  label: string,
  command: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const processHandle = startProcess(label, command, environment)
  const timeout = Bun.sleep(PROCESS_TIMEOUT_MS).then(() => 'timeout' as const)
  const completion = new Promise<'complete'>(resolve => {
    processHandle.child.once('exit', () => resolve('complete'))
  })
  const outcome = await Promise.race([timeout, completion])
  if (outcome === 'timeout') {
    await processHandle.stop()
    throw new Error(`${label} timed out\n${processHandle.output()}`)
  }
  if (processHandle.child.exitCode !== 0) {
    throw new Error(
      `${label} exited with ${processHandle.child.exitCode}\n${processHandle.output()}`,
    )
  }
}

async function waitForHttp(url: string, processHandle?: ManagedProcess): Promise<void> {
  const deadline = Date.now() + BROWSER_TIMEOUT_MS
  for (;;) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status < 500) return
    } catch {
      // Startup is eventually consistent.
    }
    if (processHandle?.child.exitCode !== null) {
      throw new Error(
        `Local server exited before ${url} became ready\n${processHandle?.output() ?? ''}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${url}\n${processHandle?.output() ?? ''}`)
    }
    await Bun.sleep(250)
  }
}

function reserveLocalPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a local port'))
        return
      }
      server.close(error => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}
