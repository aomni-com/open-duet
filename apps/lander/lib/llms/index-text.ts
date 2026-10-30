import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { BRAND_NAME } from '@/lib/brand-copy'
import {
  PUBLIC_FRONTIER_MODELS,
  PUBLIC_SUBSCRIPTION_PLANS,
  PUBLIC_TIERS,
} from '@/lib/public-site-config'
import { productHref } from '@/src/config/origins'
import { siteConfig } from '@/src/site-config'

import { absoluteUrl, bullets, heading, linkList, section, steps } from './markdown'
import { mdTwinPath } from './md-url'
import { getLlmsPages, type LlmsPage } from './pages'
import { getLlmsRoutes, type LlmsRouteKind } from './routes'

/**
 * `/llms.txt` and `/llms-full.txt`.
 *
 * The index is not only a table of contents. `app/robots.ts` closes the site
 * to AI crawlers except for the reviewed editorial trees, so a model that
 * obeys robots.txt reaches these two URLs and little else — a bare list of
 * links it is not allowed to follow would teach it nothing. So the index
 * carries the product explanation inline, and every fact in it is read from
 * `@repo/contract` through `lib/public-site-config.ts` rather than restated.
 */

/** The index's sections, in reading order. */
const SECTIONS: Array<{ kind: LlmsRouteKind; title: string }> = [
  { kind: 'overview', title: 'Start here' },
  { kind: 'marketing', title: 'Product' },
  { kind: 'use-case', title: 'By role and job' },
  { kind: 'vertical', title: 'By industry' },
  { kind: 'comparison', title: 'Compared with alternatives' },
  { kind: 'editorial', title: 'Guides and writing' },
]

export async function buildLlmsIndex(): Promise<string> {
  const pages = await getLlmsPages()
  const kindByPath = new Map((await getLlmsRoutes()).map(route => [route.path, route.kind]))

  return [
    heading(BRAND_NAME),
    `> ${HOME_COPY.en.description}`,
    whatDuetIs(),
    authentication(),
    pricingAndSubscribing(),
    ...SECTIONS.map(({ kind, title }) =>
      section(title, linkList(pages.filter(page => kindByPath.get(page.path) === kind))),
    ),
    section(
      'Optional',
      [
        `- [Full text](${absoluteUrl('/llms-full.txt')}): every page above as one markdown document.`,
        '- Every link above is a page’s plain-markdown twin: the same content without navigation or calls to action, and the form an AI crawler is allowed to fetch anywhere on the site.',
      ].join('\n'),
    ),
    '',
  ].join('\n\n')
}

function whatDuetIs(): string {
  return [
    section(
      'What Duet is',
      [
        'Duet is one subscription that puts every kind of state-of-the-art AI in reach of people who would rather not assemble it themselves. It includes the leading models for writing, images, video, and voice, plus agents that browse the web, work in 3,000+ connected apps, research people and companies, run on a schedule, and publish what they build at real links. Nothing has to be installed or configured: you talk to it in plain language.',
        'Each subscription is a workspace: one always-on cloud machine whose disk holds the agents, their files, the shared memory they read and write, and the apps they host. An agent is plain files in a folder, so it is shared like a folder. Agents, files, and apps can each be shared with anyone: invite people into the workspace, share a folder by email, publish a public link, or call an agent from other software through the open API. Agents already on your computer, such as Claude Code or Codex, can connect through the Duet CLI or MCP to use the same models, services, and agents.',
        `Duet routes each task to the strongest model for it rather than asking the customer to pick one, drawing on ${PUBLIC_FRONTIER_MODELS.join(', ')}. The rate is flat whichever model answers.`,
      ].join('\n\n'),
    ),
    section(
      'What it costs',
      [
        `Start at ${productHref('/sign-in')} with a 7-day free trial. After the trial, choose a monthly plan; each workspace carries one plan whose included credits reset each period.`,
        PUBLIC_SUBSCRIPTION_PLANS.map(
          plan =>
            `- **${plan.id}** — ${plan.monthlyPrice}/month, ${plan.bonusPercent}% credit bonus`,
        ).join('\n'),
        'Work is priced by quality tier, not by model name:',
        PUBLIC_TIERS.map(tier => `- **${tier.label}** — ${tier.description}`).join('\n'),
      ].join('\n\n'),
    ),
  ].join('\n\n')
}

/**
 * How an agent with no browser signs its human in. Written for a stranger’s
 * coding agent that has fetched this file and is allowed to fetch almost
 * nothing else, so the transcript, the refusals, and the custody rules are all
 * here rather than behind a link.
 */
function authentication(): string {
  const api = siteConfig().apiBaseUrl
  return section(
    'Authentication',
    [
      `An agent with no browser can sign its human in and receive one identity key. Current workspace membership and role determine access; choosing a workspace does not change the login. Two calls to \`${api}\` — the origin every endpoint named in this file is served from — with one code the human reads out of their email in between.`,
      steps([
        {
          title: 'Start',
          body: `\`POST /v1/auth/email/start\` with \`{"email": "casey@example.com", "client_name": "Claude Code"}\`. \`client_name\` is optional and appears in the email, so the human can see which agent asked. The reply is \`202 {"request_id": "req_…", "expires_in": <seconds>}\`, and it is identical whether or not that address already has an account — read nothing into it.`,
        },
        {
          title: 'Ask the human to read the code back',
          body: 'Duet emails them an eight-character code shaped `XXXX-XXXX`. You cannot read their mail and there is no endpoint that returns the code: ask, and wait for them to type it to you. It dies `expires_in` seconds after `start`.',
        },
        {
          title: 'Verify',
          body: '`POST /v1/auth/email/verify` with `{"request_id": "req_…", "code": "XXXX-XXXX"}`, adding `name` and `workspace_name` if this may be their first Duet signup. Success is `200 {"access_token": "…", "token_type": "bearer", "workspace": {"slug", "name"}, "created": true|false}`. Send the token as `Authorization: Bearer <access_token>`; `created` says whether the call had to make them a workspace rather than bind to one they already had.',
        },
      ]),
      bullets([
        '`name` and `workspace_name` are used **only when this sign-in has to create a workspace** — a first signup, in practice. An address that already belongs to one is signed straight into it: the account keeps the name it has, and `workspace_name` is silently ignored. It never renames anything.',
        '`409 {"error": "workspace_ambiguous", "workspaces": [{"slug", "name", "role"}]}` means the human belongs to more than one workspace. The code survives it — ask which workspace they want, then repeat `verify` with the same `request_id` and `code` plus `workspace_slug`.',
        'The other refusals: `400 {"error": "invalid_code", "attempts_remaining": n}` (mistyped; that many guesses left before the code dies), `403 {"error": "forbidden"}` (the `workspace_slug` you named is not one of theirs), `410 {"error": "expired"}` (start again), and `429 {"error": "rate_limited", "retryAfterSeconds": n}` (wait that long — `start` is limited per address as well as per network).',
        'The key is the human’s credential, not yours. Hold it the way you hold their other secrets — an owner-only file, or the OS keychain — and never print it, log it, paste it into a transcript, or commit it. It does not expire on its own.',
        `Manage named keys at ${productHref('/settings/api-keys')} or through \`GET /v1/user/api-keys\` and \`DELETE /v1/user/api-keys/{keyId}\`. Revocation stops that login; it does not change a computer's separate sync identity.`,
        `Device pairing is the other front door and an equal one: \`duet login\` prints a code the human approves in a browser tab (${absoluteUrl(mdTwinPath('/install'))}). Install Bun 1.3.14 and Node 22 or newer, then \`npm install -g @duetso/agent\`. Email sign-in is the one that needs no browser at any point.`,
      ]),
    ].join('\n\n'),
  )
}

/**
 * Who pays, and the actionable billing and workspace-creation refusals.
 * The payer split leads because it is the fact an agent cannot infer: the
 * human it just signed in may not be the human who can fix a billing failure.
 */
function pricingAndSubscribing(): string {
  return section(
    'Pricing and subscribing',
    [
      'Before a refusal ever arrives, `GET /v1/whoami` already carries the answer: each entry in `workspaces` has a `funding` block — `{"plan", "active", "trialEndsAt"}` — describing **that workspace’s payer**, not the human holding the key. `active: false` is the one to act on. Read it and you can warn your human before their trial ends rather than after a request fails.',
      'A plan belongs to a person, not to a workspace. Every workspace has exactly one payer — the human who created it, unless an owner has since handed the role to another owner — and that payer’s plan is what funds it. Everyone else in the workspace pays nothing. So the human you just signed in is not necessarily the human who can resolve a billing refusal: `GET /v1/user/billing` returns the workspaces this human personally funds, and a workspace missing from that list is somebody else’s to pay for.',
      `Creating a workspace checks the creator’s plan against all their current live workspace memberships, regardless of role or payer: ${PUBLIC_SUBSCRIPTION_PLANS.map(plan => `${plan.id} ${plan.workspaceLimit}`).join(', ')}. Joining an existing workspace and changing its payer have no plan-capacity check. Full pricing is at ${absoluteUrl(mdTwinPath('/pricing'))}.`,
      'Two refusals need a change before retrying:',
      bullets([
        '`402 {"error": "subscription_required", "code": "subscription_required", "billingUrl": "…"}` — the trial is over and no active plan is funding the work.',
        '`402 {"error": "workspace_limit_reached", "plan": "…", "limit": n}` — the creator already belongs to at least the number of live workspaces their plan allows for creation. Leave or delete workspaces, or upgrade the creator’s own plan. Archived workspaces still count. Joining and payer changes remain allowed.',
      ]),
      'For a funding refusal, `POST /v1/user/billing/subscription/checkout` with `{"workspaceSlug": "…", "plan": "…"}` returns a Stripe Checkout URL bound to that payer’s account; if the human you signed in is not that workspace’s payer it refuses with `403 {"error": "payer_required"}`, and no endpoint will name the payer for you — ask your human who pays. Hand a URL you do get to the human — it is theirs to complete, and it expires, so mint a fresh one rather than reusing an old one. `POST /v1/user/billing/subscription/plan` changes or cancels a subscription that already exists. User billing routes accept the same human login and act on that person’s payer account; card entry and hosted payment completion remain on Stripe.',
    ].join('\n\n'),
  )
}

export async function buildLlmsFullText(): Promise<string> {
  const pages = await getLlmsPages()
  return [
    heading(`${BRAND_NAME}: full site text`),
    `> ${HOME_COPY.en.description}`,
    `Every public English page of ${absoluteUrl('/')}, as markdown, rendered from the same sources the pages themselves render from. The index of these pages is at ${absoluteUrl('/llms.txt')}.`,
    ...pages.map(pageBlock),
    '',
  ].join('\n\n')
}

function pageBlock(page: LlmsPage): string {
  return `---\n\nSource: ${absoluteUrl(page.path)}\n\n${page.markdown}`
}
