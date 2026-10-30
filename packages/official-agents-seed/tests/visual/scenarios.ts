import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, type Page } from '@playwright/test'

import type { ControlledOfficialAppEdge, OfficialAppKey } from './drivers'

export interface OfficialAppVisualScenario {
  id: string
  app: OfficialAppKey
  theme: 'light' | 'dark'
  arrange(input: { appUrl: URL; directory: string; edge: ControlledOfficialAppEdge }): Promise<void>
  /** Page-level state a user reaches by clicking, not by calling the app's API. */
  interact?(page: Page): Promise<void>
  assertReady(page: Page): Promise<void>
}

type ArrangeInput = Parameters<OfficialAppVisualScenario['arrange']>[0]

const accountBoardEmpty = scene({
  id: 'agent-app-account-board-empty',
  app: 'account-researcher/account-board',
  assert: async page => {
    await heading(page, 'Account Board')
    await expect(page.getByText('No researched accounts yet.')).toBeVisible()
    await expect(page.getByText('0 tracked')).toBeVisible()
  },
})

const accountBoardPopulated = scene({
  id: 'agent-app-account-board-populated',
  app: 'account-researcher/account-board',
  arrange: arrangeAccountBoard,
  assert: assertAccountBoardPopulated,
})

const accountBoardViewOpen = scene({
  id: 'agent-app-account-board-view-open',
  app: 'account-researcher/account-board',
  arrange: async input => {
    await arrangeAccountBoard(input)
    await json(input.appUrl, '/api/accounts/northstar-systems/views/abm-plan', 'PUT', {
      type: 'abm-plan',
      title: 'Northstar ABM Plan',
      content: ABM_PLAN_MARKDOWN,
      generatedAt: '2026-08-09',
    })
  },
  interact: async page => {
    await page.locator('summary', { hasText: 'Northstar ABM Plan' }).click()
  },
  assert: assertAbmPlanRendered,
})

const dossierBoardEmpty = scene({
  id: 'agent-app-dossier-board-empty',
  app: 'people-researcher/dossier-board',
  assert: async page => {
    await heading(page, 'Dossier Board')
    await expect(page.getByText('No one researched yet.')).toBeVisible()
    await expect(page.getByText('0 researched')).toBeVisible()
  },
})

const dossierBoardPopulated = scene({
  id: 'agent-app-dossier-board-populated',
  app: 'people-researcher/dossier-board',
  arrange: arrangeDossierBoard,
  assert: assertDossierBoardPopulated,
})

const dossierBoardPhoneFound = scene({
  id: 'agent-app-dossier-board-phone-found',
  app: 'people-researcher/dossier-board',
  arrange: async input => {
    await arrangeDossierBoard(input)
    await json(input.appUrl, '/api/people/jordan-hale/phone', 'POST')
    await settlePhone(
      input.appUrl,
      '/api/people/jordan-hale',
      person => person.phone.state === 'found',
    )
  },
  assert: async page => {
    await heading(page, 'Dossier Board')
    await expect(page.getByText('+1 415 555 0134')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Enrich phone' })).toHaveCount(0)
  },
})

const dossierBoardPhoneRunning = scene({
  id: 'agent-app-dossier-board-phone-running-dark',
  app: 'people-researcher/dossier-board',
  theme: 'dark',
  arrange: async input => {
    input.edge.phoneLookup = { pending: true }
    await arrangeDossierBoard(input)
    await json(input.appUrl, '/api/people/jordan-hale/phone', 'POST')
  },
  assert: async page => {
    await heading(page, 'Dossier Board')
    await expect(page.getByRole('button', { name: 'Looking up…' })).toBeDisabled()
  },
})

const contentBoardEmpty = scene({
  id: 'agent-app-content-board-empty',
  app: 'seo-specialist/content-board',
  assert: async page => {
    await heading(page, 'Content board')
    await expect(page.getByText(/No cards yet/)).toBeVisible()
  },
})

const contentBoardPopulated = scene({
  id: 'agent-app-content-board-populated',
  app: 'seo-specialist/content-board',
  arrange: arrangeContentBoard,
  assert: async page => {
    await heading(page, 'Content board')
    await expect(
      page.getByRole('heading', { name: 'Answer engine optimization guide' }),
    ).toBeVisible()
    await expect(page.getByRole('region', { name: /keywords — 1 cards/ })).toBeVisible()
    await expect(page.getByText('new', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Opportunity verdict/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add card' })).toHaveCount(0)
    await expect(page.getByRole('combobox')).toHaveCount(0)
  },
})

const contentBoardReviewWaiting = scene({
  id: 'agent-app-content-board-review-waiting',
  app: 'seo-specialist/content-board',
  arrange: arrangeContentBoardReview,
  assert: async page => {
    await heading(page, 'Content board')
    await expect(page.getByText('This draft is waiting for you.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve and continue' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /Feedback for/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send feedback' })).toBeVisible()
    await expect(page.getByRole('combobox')).toHaveCount(0)
  },
})

const contentBoardArtifactOpen = scene({
  id: 'agent-app-content-board-artifact-open',
  app: 'seo-specialist/content-board',
  arrange: arrangeContentBoard,
  interact: async page => {
    await page.getByRole('button', { name: /Opportunity verdict/ }).click()
  },
  assert: async page => {
    await expect(page.getByRole('region', { name: 'Artifact reader' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Verdict: NEW' })).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Strong' })).toBeVisible()
  },
})

const reposDisconnected = scene({
  id: 'agent-app-connect-repos-disconnected',
  app: 'code-reviewer/connect-repos',
  assert: async page => {
    await heading(page, 'The projects your code reviewer watches')
    await expect(page.getByText('Not connected yet')).toBeVisible()
    await expect(page.getByText(/Once GitHub is authorized, your projects/)).toBeVisible()
  },
})

const reposConnected = scene({
  id: 'agent-app-connect-repos-connected',
  app: 'code-reviewer/connect-repos',
  arrange: arrangeReposConnected,
  assert: async page => {
    await heading(page, 'The projects your code reviewer watches')
    await expect(page.getByText('Connected as acme-hq')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /acme\/platform/ })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /acme\/storefront/ })).toBeVisible()
  },
})

const reposCompleted = scene({
  id: 'agent-app-connect-repos-completed',
  app: 'code-reviewer/connect-repos',
  arrange: async input => {
    await arrangeReposConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', { repoIds: ['acme/platform'] })
    await json(input.appUrl, '/api/complete', 'POST')
  },
  assert: async page => {
    await heading(page, 'The projects your code reviewer watches')
    await expect(page.getByText(/All set.*watching 1 project/)).toBeVisible()
    await expect(page.getByLabel('acme/platform')).toBeChecked()
  },
})

const reposDegraded = scene({
  id: 'agent-app-connect-repos-degraded-dark',
  app: 'code-reviewer/connect-repos',
  theme: 'dark',
  arrange: async input => {
    await arrangeReposConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', { repoIds: ['acme/platform'] })
    await json(input.appUrl, '/api/complete', 'POST')
    input.edge.reposProbe = { ok: false, reason: 'The GitHub grant was revoked.' }
    await json(input.appUrl, '/api/connection/check', 'POST')
  },
  assert: async page => {
    await heading(page, 'The projects your code reviewer watches')
    await expect(page.getByText('Not connected yet')).toBeVisible()
    await expect(page.getByText('The GitHub grant was revoked.')).toBeVisible()
  },
})

const searchDisconnected = onboardingScene({
  id: 'agent-app-connect-search-console-disconnected',
  app: 'seo-specialist/connect-search-console',
  heading: 'The site your SEO specialist works on',
  empty: /Once Search Console is connected, your sites/,
})

const searchConnected = onboardingScene({
  id: 'agent-app-connect-search-console-connected',
  app: 'seo-specialist/connect-search-console',
  heading: 'The site your SEO specialist works on',
  arrange: arrangeSearchConnected,
  visible: ['acme.example', 'https://blog.acme.example/'],
})

const searchCompleted = onboardingScene({
  id: 'agent-app-connect-search-console-completed',
  app: 'seo-specialist/connect-search-console',
  heading: 'The site your SEO specialist works on',
  arrange: async input => {
    await arrangeSearchConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', {
      ids: ['google_search_console:site:sc-domain:acme.example'],
    })
  },
  visible: ['All set. Your agent will work on the site you picked below.'],
})

const searchDegraded = onboardingScene({
  id: 'agent-app-connect-search-console-degraded-dark',
  app: 'seo-specialist/connect-search-console',
  theme: 'dark',
  heading: 'The site your SEO specialist works on',
  arrange: async input => {
    await arrangeSearchConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', {
      ids: ['google_search_console:site:sc-domain:acme.example'],
    })
    input.edge.connections = []
    await json(input.appUrl, '/api/refresh', 'POST')
  },
  empty: /Once Search Console is connected, your sites/,
})

const accountsDisconnected = onboardingScene({
  id: 'agent-app-connect-accounts-disconnected',
  app: 'social-media-manager/connect-accounts',
  heading: 'The accounts your social media manager may use',
  empty: /Once a platform is connected, its account/,
})

const accountsConnected = onboardingScene({
  id: 'agent-app-connect-accounts-connected',
  app: 'social-media-manager/connect-accounts',
  heading: 'The accounts your social media manager may use',
  arrange: arrangeAccountsConnected,
  visible: ['@acmesocial', 'LinkedIn account'],
})

const accountsCompleted = onboardingScene({
  id: 'agent-app-connect-accounts-completed',
  app: 'social-media-manager/connect-accounts',
  heading: 'The accounts your social media manager may use',
  arrange: async input => {
    await arrangeAccountsConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', { ids: ['twitter:account:twitter-visual'] })
  },
  visible: ['All set. Your agent can only post to the accounts you ticked below.'],
})

const accountsDegraded = onboardingScene({
  id: 'agent-app-connect-accounts-degraded-dark',
  app: 'social-media-manager/connect-accounts',
  theme: 'dark',
  heading: 'The accounts your social media manager may use',
  arrange: async input => {
    await arrangeAccountsConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', { ids: ['twitter:account:twitter-visual'] })
    input.edge.connections = []
    await json(input.appUrl, '/api/refresh', 'POST')
  },
  empty: /Once a platform is connected, its account/,
})

const helpdeskDisconnected = onboardingScene({
  id: 'agent-app-connect-helpdesk-disconnected',
  app: 'support-agent/connect-helpdesk',
  heading: 'The queue your support agent works',
  empty: /Once a helpdesk is connected, its inboxes/,
})

const helpdeskConnected = onboardingScene({
  id: 'agent-app-connect-helpdesk-connected',
  app: 'support-agent/connect-helpdesk',
  heading: 'The queue your support agent works',
  arrange: arrangeHelpdeskConnected,
  visible: ['Priority Support', 'Everything in Zendesk'],
})

const helpdeskCompleted = onboardingScene({
  id: 'agent-app-connect-helpdesk-completed',
  app: 'support-agent/connect-helpdesk',
  heading: 'The queue your support agent works',
  arrange: async input => {
    await arrangeHelpdeskConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', { ids: ['help_scout:inbox:121'] })
  },
  visible: ['All set. Your agent will only work what you chose below.'],
})

const helpdeskDegraded = onboardingScene({
  id: 'agent-app-connect-helpdesk-degraded-dark',
  app: 'support-agent/connect-helpdesk',
  theme: 'dark',
  heading: 'The queue your support agent works',
  arrange: async input => {
    await arrangeHelpdeskConnected(input)
    await json(input.appUrl, '/api/selection', 'PUT', { ids: ['help_scout:inbox:121'] })
    input.edge.connections = []
    await json(input.appUrl, '/api/refresh', 'POST')
  },
  empty: /Once a helpdesk is connected, its inboxes/,
})

const BRAND_HEADING = 'Your brand, read from your site'

/** One site's published system, as Firecrawl's `branding` format reports it. */
async function arrangeBrandRead(input: {
  appUrl: URL
  edge: { brandScrape: unknown; brandJudgment: string | null }
}): Promise<void> {
  ;(input.edge as { brandScrape: unknown }).brandScrape = {
    ok: true,
    branding: {
      colors: {
        primary: '#1c2b4a',
        accent: '#ff8b5c',
        background: '#fbf9f5',
        textPrimary: '#171520',
        link: '#3d5bd1',
      },
      typography: { fontFamilies: { heading: 'Fraunces', primary: 'Inter' } },
      images: { logo: 'https://cdn.visual.test/acme-logo.svg', logoAlt: 'Acme' },
      personality: { tone: 'confident, plain-spoken' },
    },
    markdown: '# Acme\nWe make the boring parts of logistics disappear.',
  }
  input.edge.brandJudgment = [
    '## Voice',
    '- Sentences run short — rarely past fifteen words.',
    '- States what the product does; never asks the reader a question.',
    '- Avoids "revolutionary", "seamless", "world-class".',
    '',
    '## Imagery',
    'Photographic and warm, people at work rather than empty product shots.',
    'No stock handshakes, no isolated objects on white.',
    '',
    '## Exclusions',
    '- Never recolour the mark or place it on a busy photograph.',
    '- Never use the accent as a page background.',
    '- Never stretch or add effects to the lockup.',
  ].join('\n')
  await json(input.appUrl, '/api/scan', 'POST', { site: 'acme.example' })
}

const brandEmpty = onboardingScene({
  id: 'agent-app-setup-brand-empty',
  app: 'brand-designer/setup-brand',
  heading: BRAND_HEADING,
  empty: /Read your site and its brand appears here/,
})

const brandRead = onboardingScene({
  id: 'agent-app-setup-brand-read',
  app: 'brand-designer/setup-brand',
  heading: BRAND_HEADING,
  arrange: arrangeBrandRead,
  // The site's own one-word tone is replaced by the derived Voice section once
  // there is one, so the panel says the same thing once rather than twice.
  visible: ['Accent #ff8b5c', 'Fraunces · Inter', 'Sentences run short'],
})

const brandCompleted = onboardingScene({
  id: 'agent-app-setup-brand-completed',
  app: 'brand-designer/setup-brand',
  heading: BRAND_HEADING,
  arrange: async input => {
    await arrangeBrandRead(input)
    await json(input.appUrl, '/api/confirm', 'POST')
  },
  visible: ['All set. Your brand kit is saved and your designer is ready.'],
})

/* A site whose brand could not be read is its own state: the field stays, the
   page says so, and nothing pretends a kit exists. */
const brandUnreadable = onboardingScene({
  id: 'agent-app-setup-brand-unreadable-dark',
  app: 'brand-designer/setup-brand',
  theme: 'dark',
  heading: BRAND_HEADING,
  arrange: async input => {
    input.edge.brandScrape = { ok: false, status: 502 }
  },
  interact: async page => {
    await page.getByRole('textbox', { name: 'Your website address' }).fill('acme.example')
    await page.getByRole('button', { name: 'Read my site', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Read my site', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Use this brand' })).toBeDisabled()
  },
  empty: /Read your site and its brand appears here/,
  visible: ['That site could not be read. Check the address and try again.'],
})

const VOICE_HEADING = 'Teach your writer your voice'

const SAMPLE = [
  'The logistics stack is a museum. Every layer was added by someone solving',
  'yesterday. Nobody removed anything.',
  '',
  'We did the unglamorous thing. We read the invoices. All of them.',
  'Fourteen thousand lines, three weeks, two people and a spreadsheet nobody',
  'wants to inherit. What we found was not a pricing problem.',
  '',
  'It was a naming problem. Same pallet, four names, four prices.',
].join(' ')

async function arrangeVoiceRead(input: {
  appUrl: URL
  edge: { voiceProfile: string | null }
}): Promise<void> {
  input.edge.voiceProfile = [
    '## Register',
    'Written for operators who already know the domain. Plain, declarative, and',
    'unhurried; sentences swing from three words to thirty.',
    '',
    '## Preserve',
    '- The very short sentence used as a full stop on an argument — "All of them."',
    '- Deliberate fragments where a clause would be softer.',
    '- Concrete counts over adjectives: "fourteen thousand lines", not "many".',
    '- The dry aside in the middle of a serious point.',
    '',
    '## Tics to leave alone',
    '- Paragraphs that open with "We" and stay there.',
    '- Repeating a noun rather than reaching for a pronoun.',
  ].join('\n')
  const form = new FormData()
  form.append('sample', new File([SAMPLE.repeat(3)], 'the-invoices.md', { type: 'text/markdown' }))
  const response = await fetch(new URL('/api/samples', input.appUrl), {
    method: 'POST',
    body: form,
  })
  if (!response.ok) throw new Error(`samples ${response.status}`)
}

const voiceEmpty = onboardingScene({
  id: 'agent-app-setup-voice-empty',
  app: 'writer/setup-voice',
  heading: VOICE_HEADING,
  empty: /Nothing added yet/,
})

const voiceRead = onboardingScene({
  id: 'agent-app-setup-voice-read',
  app: 'writer/setup-voice',
  heading: VOICE_HEADING,
  arrange: arrangeVoiceRead,
  visible: ['the-invoices.md', 'Balanced'],
})

const voiceCompleted = onboardingScene({
  id: 'agent-app-setup-voice-completed',
  app: 'writer/setup-voice',
  heading: VOICE_HEADING,
  arrange: async input => {
    await arrangeVoiceRead(input)
    await json(input.appUrl, '/api/confirm', 'POST')
  },
  visible: ['All set. Your writer knows your voice and is ready for a brief or a draft.'],
})

/* The licence is the one decision reading cannot make, so the picked state is
   worth a shot of its own — and dark is where a pressed chip is easiest to get
   wrong. */
const voiceFirm = onboardingScene({
  id: 'agent-app-setup-voice-firm-dark',
  app: 'writer/setup-voice',
  theme: 'dark',
  heading: VOICE_HEADING,
  arrange: async input => {
    await arrangeVoiceRead(input)
    await json(input.appUrl, '/api/licence', 'PUT', { licence: 'firm' })
  },
  visible: ['Firm'],
})

export const OFFICIAL_APP_VISUAL_SCENARIOS: readonly OfficialAppVisualScenario[] = [
  accountBoardEmpty,
  accountBoardPopulated,
  dark(accountBoardPopulated, 'agent-app-account-board-populated-dark'),
  accountBoardViewOpen,
  dark(accountBoardViewOpen, 'agent-app-account-board-view-open-dark'),
  dossierBoardEmpty,
  dossierBoardPopulated,
  dark(dossierBoardPopulated, 'agent-app-dossier-board-populated-dark'),
  dossierBoardPhoneFound,
  dossierBoardPhoneRunning,
  brandEmpty,
  brandRead,
  brandCompleted,
  brandUnreadable,
  voiceEmpty,
  voiceRead,
  voiceCompleted,
  voiceFirm,
  contentBoardEmpty,
  contentBoardPopulated,
  dark(contentBoardPopulated, 'agent-app-content-board-populated-dark'),
  contentBoardReviewWaiting,
  dark(contentBoardReviewWaiting, 'agent-app-content-board-review-waiting-dark'),
  contentBoardArtifactOpen,
  reposDisconnected,
  reposConnected,
  reposCompleted,
  reposDegraded,
  searchDisconnected,
  searchConnected,
  searchCompleted,
  searchDegraded,
  accountsDisconnected,
  accountsConnected,
  accountsCompleted,
  accountsDegraded,
  helpdeskDisconnected,
  helpdeskConnected,
  helpdeskCompleted,
  helpdeskDegraded,
]

function scene(input: {
  id: string
  app: OfficialAppKey
  theme?: 'light' | 'dark'
  arrange?: OfficialAppVisualScenario['arrange']
  interact?: OfficialAppVisualScenario['interact']
  assert: OfficialAppVisualScenario['assertReady']
}): OfficialAppVisualScenario {
  return {
    id: input.id,
    app: input.app,
    theme: input.theme ?? 'light',
    arrange: input.arrange ?? (async () => {}),
    interact: input.interact,
    assertReady: input.assert,
  }
}

function dark(source: OfficialAppVisualScenario, id: string): OfficialAppVisualScenario {
  return { ...source, id, theme: 'dark' }
}

function onboardingScene(input: {
  id: string
  app: OfficialAppKey
  heading: string
  theme?: 'light' | 'dark'
  arrange?: OfficialAppVisualScenario['arrange']
  interact?: OfficialAppVisualScenario['interact']
  empty?: RegExp
  visible?: string[]
}): OfficialAppVisualScenario {
  return scene({
    ...input,
    assert: async page => {
      await heading(page, input.heading)
      if (input.empty) await expect(page.getByText(input.empty)).toBeVisible()
      for (const text of input.visible ?? [])
        await expect(page.getByText(text).first()).toBeVisible()
    },
  })
}

async function heading(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
}

async function arrangeAccountBoard({ appUrl }: ArrangeInput): Promise<void> {
  await json(appUrl, '/api/accounts', 'POST', {
    name: 'Northstar Systems',
    domain: 'northstar.example',
  })
  await json(appUrl, '/api/accounts/northstar-systems/dossier', 'PUT', {
    facts: [
      {
        label: 'Headcount',
        status: 'found',
        value: '1,240',
        retrievedAt: '2026-08-09',
        source: { title: 'Northstar company profile', url: 'https://northstar.example/company' },
      },
      {
        label: 'Current CRM',
        status: 'unfound',
        retrievedAt: '2026-08-09',
        note: 'No supported source named the CRM.',
      },
      {
        label: 'Funding',
        status: 'found',
        value: '$48M Series C',
        retrievedAt: '2026-08-09',
        source: {
          title: 'Northstar raises Series C',
          url: 'https://northstar.example/news/series-c',
        },
      },
    ],
  })
  await json(appUrl, '/api/accounts/northstar-systems/views/battlecard', 'PUT', {
    type: 'battlecard',
    title: 'Northstar Battlecard',
    content: '# Northstar Battlecard',
    generatedAt: '2026-08-09',
  })
  await json(appUrl, '/api/accounts/northstar-systems/views/abm-plan', 'PUT', {
    type: 'abm-plan',
    title: 'Northstar ABM Plan',
    content: '# Northstar ABM Plan',
    generatedAt: '2026-08-09',
  })
  await json(appUrl, '/api/accounts/northstar-systems/contacts', 'PUT', {
    contacts: [
      {
        id: 'jordan-hale',
        name: 'Jordan Hale',
        title: 'VP of Engineering',
        profileUrl: 'https://www.linkedin.com/in/jordan-hale',
        reason: 'Owns the platform team the Series C hiring plan is staffing [E-002].',
        roles: [
          { title: 'VP of Engineering', company: 'Northstar Systems', start: '2022-03' },
          { title: 'Director of Platform', company: 'Rivermark', start: '2019-07', end: '2022-02' },
        ],
        email: {
          status: 'found',
          address: 'jordan.hale@northstar.example',
          verification: 'DELIVERABLE',
          retrievedAt: '2026-08-09',
        },
      },
      {
        id: 'priya-raman',
        name: 'Priya Raman',
        title: 'Chief Financial Officer',
        profileUrl: 'https://www.linkedin.com/in/priya-raman',
        reason:
          'Signs infrastructure spend; named the cost of the migration on the Q2 call [E-005].',
        roles: [
          { title: 'Chief Financial Officer', company: 'Northstar Systems', start: '2021-01' },
        ],
        email: {
          status: 'unfound',
          retrievedAt: '2026-08-09',
          note: 'The provider returned no address for this domain.',
        },
      },
    ],
  })
  await putAvatar(
    appUrl,
    '/api/accounts/northstar-systems/contacts/jordan-hale/avatar',
    'linkedin',
    'https://www.linkedin.com/in/jordan-hale',
  )
  await json(appUrl, '/api/accounts/northstar-systems', 'PATCH', { status: 'ready' })
}

/**
 * One view written the way the seller-ready-views skill writes them: headings,
 * both list kinds, a table, a quote, evidence ids that are not links, and a
 * source that is one.
 */
const ABM_PLAN_MARKDOWN = `# Northstar ABM Plan
Generated 2026-08-09; evidence through 2026-08-09.

## Strategy & investment
Northstar is funding a **platform migration** with its $48M Series C and is
hiring against the plan published with the round [E-002].

## Challenges
1. Migration cost is under CFO scrutiny after the Q2 call [E-005].
2. Hiring trails the plan filed with the round [E-002].

## Competitor insights
- Runs \`Redshift\` today, per the engineering blog [E-007].
  - No replacement evaluation is retrieved; \`unfound\`.
- Evaluated Rivermark in 2025 [E-009].

> Account facts and seller recommendations stay visibly separate.

## Recommended angle
seller input needed — no seller capabilities were supplied.

| Section | State |
| --- | --- |
| Quantitative benefits | seller input needed |
| Relevant news | [Series C announcement](https://northstar.example/news/series-c) |
`

async function assertAbmPlanRendered(page: Page): Promise<void> {
  await heading(page, 'Account Board')
  await expect(page.getByRole('heading', { name: 'Strategy & investment' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Q2 call [E-005]' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Series C announcement' })).toHaveAttribute(
    'href',
    'https://northstar.example/news/series-c',
  )
  await expect(page.getByRole('cell', { name: 'Quantitative benefits' })).toBeVisible()
  await expect(page.getByText('**platform migration**')).toHaveCount(0)
  await expect(page.getByText('## Strategy & investment')).toHaveCount(0)
  // The card's own summary names the view; the artifact's title line is not
  // printed under it a second time.
  await expect(page.getByText('Northstar ABM Plan', { exact: true })).toHaveCount(1)
}

async function assertAccountBoardPopulated(page: Page): Promise<void> {
  await heading(page, 'Account Board')
  await expect(page.getByText('Northstar Systems', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('$48M Series C')).toBeVisible()
  await expect(page.getByText('Northstar Battlecard', { exact: true })).toBeVisible()
  await expect(page.getByText('1 tracked')).toBeVisible()
  await expect(page.getByText('jordan.hale@northstar.example')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enrich phone' })).toHaveCount(2)
}

async function arrangeDossierBoard({ appUrl }: ArrangeInput): Promise<void> {
  await json(appUrl, '/api/people', 'POST', {
    name: 'Jordan Hale',
    title: 'VP of Engineering',
    company: 'Northstar Systems',
    domain: 'northstar.example',
    location: 'Seattle, Washington',
  })
  await json(appUrl, '/api/people/jordan-hale/dossier', 'PUT', {
    identity: {
      profileUrl: 'https://www.linkedin.com/in/jordan-hale',
      confirmedBy: 'profile-url',
    },
    title: 'VP of Engineering',
    company: 'Northstar Systems',
    location: 'Seattle, Washington',
    summary:
      'Runs platform engineering, which the Series C hiring plan names as the team being doubled. Ownership of the data pipeline is read off the title and the reporting line, not stated anywhere retrieved.',
    roles: [
      { title: 'VP of Engineering', company: 'Northstar Systems', start: '2022-03' },
      { title: 'Director of Platform', company: 'Rivermark', start: '2019-07', end: '2022-02' },
      { title: 'Staff Engineer', company: 'Halcyon Data', start: '2016-04', end: '2019-06' },
    ],
    email: {
      status: 'found',
      address: 'jordan.hale@northstar.example',
      verification: 'DELIVERABLE',
      retrievedAt: '2026-08-09',
    },
    highlights: [
      {
        date: '2026-06-18',
        summary: 'Talked through their move off a single Postgres primary at ScaleConf.',
        url: 'https://scaleconf.example/2026/talks/northstar-platform',
      },
      {
        date: '2026-04-02',
        summary: 'Wrote about on-call load after the platform team reorganised.',
        url: 'https://northstar.example/blog/on-call-after-the-reorg',
      },
    ],
  })
  await putAvatar(
    appUrl,
    '/api/people/jordan-hale/avatar',
    'linkedin',
    'https://www.linkedin.com/in/jordan-hale',
  )
  await json(appUrl, '/api/people', 'POST', {
    name: 'Priya Raman',
    title: 'Chief Financial Officer',
    company: 'Northstar Systems',
  })
}

async function assertDossierBoardPopulated(page: Page): Promise<void> {
  await heading(page, 'Dossier Board')
  await expect(page.getByRole('heading', { name: 'Jordan Hale' })).toBeVisible()
  await expect(page.getByText('jordan.hale@northstar.example')).toBeVisible()
  await expect(page.getByText('DELIVERABLE', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enrich phone' })).toBeEnabled()
  await expect(page.getByText('Director of Platform')).toBeVisible()
  await expect(page.getByAltText(/Jordan Hale, from their LinkedIn profile/).first()).toBeVisible()
}

/**
 * A 48px PNG, embedded rather than read from disk so a scene arranges the same
 * way in the container as it does locally.
 */
const AVATAR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAnUlEQVR42u3Xuw2AQAwDUJesywSsyRB0LAA1cAfJKT9kKQM8yYUdTMuc6kAQQQRVAa37Fg86Ea0LAHU0IyYYadQm2Gl0JphqFKbiIIVGaiLozyC1RmRiZAT5glgdFds+4x7KuBgzbuqMX0fYXzZYq6Io4an5YoKz5tUEf03fVAdkqumYioAcNC1TBZCb5tFEkBTkrLmbCKoNCtFcTAfCUQnEuncSagAAAABJRU5ErkJggg=='

async function putAvatar(
  appUrl: URL,
  pathname: string,
  source: string,
  from: string,
): Promise<void> {
  const url = new URL(pathname, appUrl)
  url.searchParams.set('source', source)
  url.searchParams.set('from', from)
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from(AVATAR_PNG_BASE64, 'base64'),
  })
  if (!response.ok) throw new Error(`PUT ${pathname} failed (${response.status})`)
}

/**
 * The phone route answers 202 and settles in the background, so a scene that
 * screenshots the settled state has to wait for the app's own record of it
 * rather than for a fixed delay.
 */
async function settlePhone(
  appUrl: URL,
  pathname: string,
  done: (subject: { phone: { state: string } }) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(new URL(pathname, appUrl))
    const body = (await response.json()) as { person: { phone: { state: string } } }
    if (done(body.person)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${pathname} never reached the expected phone state`)
}

async function arrangeContentBoardReview({ appUrl }: ArrangeInput): Promise<void> {
  await json(appUrl, '/api/cards', 'POST', {
    slug: 'review-the-content-board',
    title: 'Review the content board',
    verdict: 'new',
    primaryKeyword: 'content workflow',
    note: 'The draft is ready for a human decision.',
  })
  await json(appUrl, '/api/cards/review-the-content-board', 'PATCH', { stage: 'review' })
}

async function arrangeContentBoard({ appUrl, directory }: ArrangeInput): Promise<void> {
  const artifactDirectory = path.join(directory, 'seo', 'answer-engine-optimization')
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    path.join(artifactDirectory, 'opportunity.md'),
    '# Verdict: NEW\n\nThe article has a distinct job and proven demand.\n\n| Signal | Value |\n| --- | --- |\n| Demand | **Strong** |\n',
  )

  await json(appUrl, '/api/cards', 'POST', {
    slug: 'answer-engine-optimization',
    title: 'Answer engine optimization guide',
    verdict: 'new',
    primaryKeyword: 'answer engine optimization',
    note: 'Strong product fit and a clear information gap.',
  })
  await json(appUrl, '/api/cards/answer-engine-optimization', 'PATCH', { stage: 'keywords' })
  await json(appUrl, '/api/cards/answer-engine-optimization/artifacts', 'POST', {
    stage: 'opportunity',
    file: 'seo/answer-engine-optimization/opportunity.md',
    summary: 'Opportunity verdict',
  })
  await json(appUrl, '/api/cards', 'POST', {
    slug: 'seo-audit-checklist',
    title: 'Technical SEO audit checklist',
    verdict: 'refresh',
    primaryKeyword: 'seo audit checklist',
  })
}

async function arrangeReposConnected({ appUrl, edge }: ArrangeInput): Promise<void> {
  edge.reposProbe = {
    ok: true,
    account: 'acme-hq',
    repos: [
      {
        id: 'acme/platform',
        description: 'Core API and workspace services',
        private: true,
        updatedAt: '2026-08-09T12:00:00.000Z',
      },
      {
        id: 'acme/storefront',
        description: 'Customer storefront',
        private: false,
        updatedAt: '2026-08-08T09:00:00.000Z',
      },
    ],
  }
  await json(appUrl, '/api/connection/check', 'POST')
}

async function arrangeSearchConnected({ appUrl, edge }: ArrangeInput): Promise<void> {
  edge.connections = [{ id: 'gsc-visual', integration: 'google_search_console', status: 'active' }]
  edge.executeResults.set('GOOGLE_SEARCH_CONSOLE_LIST_SITES', {
    siteEntry: [
      { siteUrl: 'sc-domain:acme.example', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://blog.acme.example/', permissionLevel: 'siteFullUser' },
    ],
  })
  await json(appUrl, '/api/refresh', 'POST')
}

async function arrangeAccountsConnected({ appUrl, edge }: ArrangeInput): Promise<void> {
  edge.connections = [
    { id: 'twitter-visual', integration: 'twitter', status: 'active' },
    { id: 'linkedin-visual', integration: 'linkedin', status: 'active' },
  ]
  edge.executeResults.set('TWITTER_USER_LOOKUP_ME', {
    data: { id: '99', name: 'Acme', username: 'acmesocial' },
  })
  await json(appUrl, '/api/refresh', 'POST')
}

async function arrangeHelpdeskConnected({ appUrl, edge }: ArrangeInput): Promise<void> {
  edge.connections = [
    { id: 'helpscout-visual', integration: 'help_scout', status: 'active' },
    { id: 'zendesk-visual', integration: 'zendesk', status: 'active' },
  ]
  edge.executeResults.set('HELP_SCOUT_LIST_INBOXES', {
    _embedded: {
      mailboxes: [{ id: 121, name: 'Priority Support', email: 'priority@acme.example' }],
    },
  })
  await json(appUrl, '/api/refresh', 'POST')
}

async function json(
  appUrl: URL,
  pathname: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(pathname, appUrl), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok)
    throw new Error(`${method} ${pathname} failed (${response.status}): ${await response.text()}`)
  return response.status === 204 ? undefined : await response.json()
}
