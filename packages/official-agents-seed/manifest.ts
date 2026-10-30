import type { AppDeclaration } from '@repo/contract'

export const OFFICIAL_AGENTS_WORKSPACE_SLUG = 'official-agents-hub'
export const OFFICIAL_AGENTS_HUB_PATH = 'agents'
export const OFFICIAL_AGENTS_PUBLISH_SLUG = 'official-agents'

/**
 * What the repo declares about an official agent. Everything a browser SEES —
 * summary, skills, changelog — is derived from the agent's own authored files
 * by `deriveListingMetadata`, not declared here: a description in two places
 * is a description that drifts, and AGENTS.md already had to carry it as its
 * first paragraph.
 */
export interface OfficialSeedAgent {
  slug: string
  name: string
  path: string
  /**
   * Optional, and currently unset everywhere: the platform's default artwork is
   * fine. Declared so a manifest entry can carry one without a schema change
   * later — the registration rail has always accepted an agent icon, and this
   * was the only place that could not express it.
   */
  icon?: string
  /**
   * Zero or more. Most agents have none — an app earns its place by doing
   * something the chat cannot, and one that only restates the agent's own
   * prose is a liability.
   *
   * A LIST rather than a single app because the two reasons to have one are
   * independent: a working surface (a board the agent drives) and an
   * onboarding picker (what the user must choose before the agent unlocks).
   * An agent can need both, and the marketplace rail has always enumerated
   * every app under an agent's folder — this was the only place that assumed
   * one.
   */
  apps?: readonly AppDeclaration[]
}

/* Annotated rather than `as const satisfies`. Under `as const` an entry that
   omits `app` has no such KEY, so `agent.app` fails to compile at every call
   site instead of reading as `undefined` — the optionality would be
   unusable. The annotation keeps the same compile-time checking of each
   entry and gives every consumer one uniform shape. */
export const officialSeedAgents: readonly OfficialSeedAgent[] = [
  {
    slug: 'account-researcher',
    name: 'Account Researcher',
    path: 'agents/account-researcher',
    apps: [
      {
        path: 'agents/account-researcher/apps/account-board',
        slug: 'account-board',
        name: 'Account Board',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        // The per-contact phone button is the user's spend, made from the app:
        // reaching FullEnrich through Duet's service proxy is what `services`
        // buys. Nothing else in this board talks to the platform.
        apiScopes: ['services'],
      },
    ],
  },
  {
    slug: 'brand-designer',
    name: 'Brand Designer',
    path: 'agents/brand-designer',
    apps: [
      {
        path: 'agents/brand-designer/apps/setup-brand',
        slug: 'setup-brand',
        name: 'Brand Setup',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        // `services` buys both the Firecrawl proxy and the model gateway;
        // `files:write` writes the kit and the logo into the agent's folder;
        // `agents` is what lets the app end its own onboarding.
        apiScopes: ['agents', 'files:write', 'services'],
      },
    ],
  },
  {
    slug: 'code-reviewer',
    name: 'Code Reviewer',
    path: 'agents/code-reviewer',
    apps: [
      {
        path: 'agents/code-reviewer/apps/connect-repos',
        slug: 'connect-repos',
        name: 'Connect Repos',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        apiScopes: [],
      },
    ],
  },
  {
    slug: 'community-manager',
    name: 'Community Manager',
    path: 'agents/community-manager',
  },
  {
    slug: 'competitive-analyst',
    name: 'Competitive Analyst',
    path: 'agents/competitive-analyst',
  },
  {
    slug: 'data-analyst',
    name: 'Data Analyst',
    path: 'agents/data-analyst',
  },
  {
    slug: 'hr-generalist',
    name: 'HR Generalist',
    path: 'agents/hr-generalist',
  },
  {
    slug: 'landing-page-builder',
    name: 'Landing Page Builder',
    path: 'agents/landing-page-builder',
  },
  {
    slug: 'operations-analyst',
    name: 'Operations Analyst',
    path: 'agents/operations-analyst',
  },
  {
    slug: 'people-researcher',
    name: 'People Researcher',
    path: 'agents/people-researcher',
    apps: [
      {
        path: 'agents/people-researcher/apps/dossier-board',
        slug: 'dossier-board',
        name: 'Dossier Board',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        // The phone button is the user's spend, made from the app: reaching
        // FullEnrich through Duet's service proxy is what `services` buys.
        apiScopes: ['services'],
      },
    ],
  },
  {
    slug: 'performance-marketer',
    name: 'Performance Marketer',
    path: 'agents/performance-marketer',
  },
  {
    slug: 'product-manager',
    name: 'Product Manager',
    path: 'agents/product-manager',
  },
  {
    slug: 'sales-coach',
    name: 'Sales Coach',
    path: 'agents/sales-coach',
  },
  {
    slug: 'sales-development-rep',
    name: 'Sales Development Rep',
    path: 'agents/sales-development-rep',
  },
  {
    slug: 'seo-specialist',
    name: 'SEO Specialist',
    path: 'agents/seo-specialist',
    apps: [
      {
        path: 'agents/seo-specialist/apps/content-board',
        slug: 'content-board',
        name: 'Content Board',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        // `agents` identifies the agent that owns this installed app;
        // `sessions` delivers review feedback to that agent's default session.
        apiScopes: ['agents', 'sessions'],
      },
      {
        path: 'agents/seo-specialist/apps/connect-search-console',
        slug: 'connect-search-console',
        name: 'Connect Search Console',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        apiScopes: ['integrations'],
      },
    ],
  },
  {
    slug: 'social-media-manager',
    name: 'Social Media Manager',
    path: 'agents/social-media-manager',
    apps: [
      {
        path: 'agents/social-media-manager/apps/connect-accounts',
        slug: 'connect-accounts',
        name: 'Connect Accounts',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        apiScopes: ['integrations'],
      },
    ],
  },
  {
    slug: 'support-agent',
    name: 'Support Agent',
    path: 'agents/support-agent',
    apps: [
      {
        path: 'agents/support-agent/apps/connect-helpdesk',
        slug: 'connect-helpdesk',
        name: 'Connect Helpdesk',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        apiScopes: ['integrations'],
      },
    ],
  },
  {
    slug: 'website-builder',
    name: 'Website Builder',
    path: 'agents/website-builder',
  },
  {
    slug: 'writer',
    name: 'Writer',
    path: 'agents/writer',
    apps: [
      {
        path: 'agents/writer/apps/setup-voice',
        slug: 'setup-voice',
        name: 'Voice Setup',
        icon: 'icon.png',
        command: 'bun run server.ts',
        installCommand: 'bun install',
        // `services` reaches the model gateway that reads the samples;
        // `files:write` puts the profile and the samples in the agent's folder;
        // `agents` is what lets the app end its own onboarding.
        apiScopes: ['agents', 'files:write', 'services'],
      },
    ],
  },
]
