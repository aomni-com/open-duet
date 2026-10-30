import { PLATFORM_DESCRIPTION, PLATFORM_TITLE } from '@/components/landing/landers/platform-copy'

/**
 * Every `/l/<slug>` lander, and the copy for the ones the shared template
 * renders.
 *
 * Campaign landers are alternate main landers: EN-only, noindexed, never
 * sitemapped, and reached by paid or targeted traffic rather than by a
 * crawler. The slug doubles as the campaign identifier the CTA carries
 * through signup into onboarding, so the Convex campaign registry installs
 * the starter agents the lander promised and conversions attribute per
 * lander.
 *
 * Two kinds share the prefix, because the audience cannot tell them apart and
 * the wiring must not either:
 *
 * - **template** — an audience pitch expressed as copy. `CampaignVariant`
 *   below is the whole page; it changes daily without touching a component.
 * - **bespoke** — a lander with its own sections and its own animated proof.
 *   Too much page to express as copy, so the registry names it and
 *   `campaign-render-map.tsx` maps the slug to the component.
 *
 * `CAMPAIGN_LANDERS` is the closed world both kinds live in: the route
 * pre-renders exactly these slugs, and the public route manifest reads it to
 * put them in front of the build and visual gates.
 */

export type CampaignPillar = {
  title: string
  body: string
}

export type CampaignVariant = {
  slug: string
  /** <title> + meta description. */
  metaTitle: string
  metaDescription: string
  eyebrow: string
  /** H1 = lead + soft italic tail, matching the lander headline grammar. */
  h1Lead: string
  h1Italic: string
  sub: string
  pillarsEyebrow: string
  pillarsTitle: string
  pillarsIntro: string
  pillars: readonly CampaignPillar[]
  /** Optional shared proof section borrowed from the section library. */
  borrowed?: 'silos' | 'train' | 'share'
  closingEyebrow: string
  closingLead: string
  /** Ink-marked closing phrase. */
  closingMark: string
  closingSub: string
}

export type CampaignLander = {
  slug: string
  /** <title> + meta description. */
  metaTitle: string
  metaDescription: string
  /** Copy-only landers carry their page here; bespoke ones own a component. */
  variant?: CampaignVariant
}

export const CAMPAIGN_VARIANTS: readonly CampaignVariant[] = [
  {
    slug: 'team',
    metaTitle: 'Duet — Your team’s AI, finally in one place',
    metaDescription:
      'Every seat runs its own AI and nothing it learns adds up. Duet centralizes the memories, skills, integrations, and internal apps in one workspace your whole team shares.',
    eyebrow: 'For teams running AI in every tab',
    h1Lead: 'Your team’s AI,',
    h1Italic: 'finally in one place.',
    sub: 'Every seat runs its own AI today — and nothing it learns adds up. Duet gives your team one workspace where the memories, skills, integrations, and internal apps live together, shared by every person and every agent.',
    pillarsEyebrow: 'The centralized repo',
    pillarsTitle: 'One home for everything your AI knows.',
    pillarsIntro:
      'Centralize it once and every seat — human or agent — works from the same source.',
    pillars: [
      {
        title: 'Shared memory',
        body: 'What one teammate’s agent learns, every agent knows: pricing rules, customer history, brand voice — accumulated in one place instead of trapped per seat.',
      },
      {
        title: 'Skill files',
        body: 'Your team’s methods, written once as skills every agent loads. The same playbook, whether it runs for sales or support.',
      },
      {
        title: 'Integrations',
        body: 'Gmail, Slack, Notion, Drive and the rest connect once — with one place to see and control what agents can reach.',
      },
      {
        title: 'Internal apps',
        body: 'The dashboards and tools your agents build are hosted in the same workspace, at real URLs the whole team shares.',
      },
    ],
    borrowed: 'silos',
    closingEyebrow: 'One workspace, every seat',
    closingLead: 'Bring your team’s AI',
    closingMark: 'under one roof.',
    closingSub:
      'One workspace for the memory, skills, integrations, and apps — shared by everyone you work with.',
  },
  {
    slug: 'business',
    metaTitle: 'Duet — Build the AI system that runs your business',
    metaDescription:
      'Everyone uses AI. Duet is where you build your own system: agents with memory, skills, and schedules that run marketing, sales, ops, and engineering on their own — and improve every week.',
    eyebrow: 'Beyond using AI',
    h1Lead: 'Everyone uses AI.',
    h1Italic: 'You build the system.',
    sub: 'Agents with memory, skills, and schedules that run marketing, sales, ops, and engineering on their own — and get sharper every week, in a workspace you own.',
    pillarsEyebrow: 'The system, not the tool',
    pillarsTitle: 'Most businesses use AI. Yours will run on it.',
    pillarsIntro: 'Four properties separate a system you own from a stack of chat tabs.',
    pillars: [
      {
        title: 'Runs by itself',
        body: 'Schedules and triggers instead of prompts: the report is done before you wake, follow-ups go out on time, and the pipeline moves without anyone pressing enter.',
      },
      {
        title: 'Improves itself',
        body: 'Every run writes back to shared memory and skill files, so the next run starts smarter. The gains compound in your workspace — not in a vendor’s model.',
      },
      {
        title: 'Covers every seat',
        body: 'Marketing, sales, ops, engineering: one agent per department, all reading the same memory — what sales learns, support already knows.',
      },
      {
        title: 'Owned by you',
        body: 'The memories, skills, and apps are assets that accumulate under your name. You’re not renting intelligence; you’re building equity in a system.',
      },
    ],
    borrowed: 'train',
    closingEyebrow: 'Systems compound',
    closingLead: 'Stop renting AI.',
    closingMark: 'Start building yours.',
    closingSub: 'A system that runs the business on its own — and is better every week you own it.',
  },
  {
    slug: 'sell',
    metaTitle: 'Duet — Package your expertise and sell it as agents',
    metaDescription:
      'Turn how you work into an agentic operating system — agents, skill files, memory, apps — and deploy it to the small businesses you serve. Your method stays yours.',
    eyebrow: 'For experts, agencies, and consultants',
    h1Lead: 'Package your expertise.',
    h1Italic: 'Sell it as agents.',
    sub: 'Turn how you work into an agentic operating system — agents, skill files, memory, apps — and deploy it to the small businesses you serve. Every client gets your best; the method stays yours.',
    pillarsEyebrow: 'Your practice, productized',
    pillarsTitle: 'Build it once. Sell it every week.',
    pillarsIntro:
      'The expertise you deliver by hand becomes a system you deploy — and a product that compounds.',
    pillars: [
      {
        title: 'Package it once',
        body: 'Teach agents your method in plain language: the skills, the checklists, the way you’d do it yourself. It becomes a system you can hand over.',
      },
      {
        title: 'Deploy it per client',
        body: 'Every business you sell to gets its own workspace running your system — their data isolated, your playbook installed.',
      },
      {
        title: 'Your name on it',
        body: 'Clients hire the results; the recipe stays under the hood. You set the price and keep the relationship.',
      },
      {
        title: 'Improve it everywhere',
        body: 'Sharpen a skill once and roll it into every deployment. Your product compounds like software, because it is software.',
      },
    ],
    borrowed: 'share',
    closingEyebrow: 'One system, many clients',
    closingLead: 'Sell what you know,',
    closingMark: 'a hundred times.',
    closingSub: 'One agentic operating system, deployed to every business you serve.',
  },
]

/**
 * The landers that own a component instead of a `CampaignVariant`: full pages
 * with their own sections and their own animated proof, too much page to
 * express as copy.
 *
 * Only `platform` reads its meta from the page's copy module, because its
 * description is also the hero's sub — one string, so the page and the search
 * result cannot disagree. The other two hero on a different sentence than
 * they sell on in a SERP, so their meta lives here and nowhere else.
 */
const BESPOKE_LANDERS: readonly CampaignLander[] = [
  {
    slug: 'platform',
    // The hero renders PLATFORM_DESCRIPTION too, so the page and its meta
    // description cannot drift apart.
    metaTitle: PLATFORM_TITLE,
    metaDescription: PLATFORM_DESCRIPTION,
  },
  {
    slug: 'agent-cloud',
    metaTitle: 'Duet: The Cloud That Gives Your Agents a Memory',
    metaDescription:
      'Your agents are brilliant, and they forget everything. Duet is the cloud that gives them persistent memory, files, and a place to run, so their work compounds session over session instead of resetting to zero.',
  },
  {
    slug: 'file-sharing',
    metaTitle: 'Duet: File Sharing Your Agents Can Actually Use',
    metaDescription:
      'Share a folder once and every person, plus every one of their AI agents, gets the same files, the same context, and the same permissions, instantly. File sharing rebuilt for the age of agents.',
  },
]

export const CAMPAIGN_LANDERS: readonly CampaignLander[] = [
  ...CAMPAIGN_VARIANTS.map(variant => ({
    slug: variant.slug,
    metaTitle: variant.metaTitle,
    metaDescription: variant.metaDescription,
    variant,
  })),
  ...BESPOKE_LANDERS,
]

export function getCampaignLander(slug: string): CampaignLander | undefined {
  return CAMPAIGN_LANDERS.find(lander => lander.slug === slug)
}

export function getAllCampaignSlugs(): string[] {
  return CAMPAIGN_LANDERS.map(lander => lander.slug)
}
