import {
  PUBLIC_FRONTIER_MODELS,
  PUBLIC_MAX_STORAGE_GB,
  PUBLIC_MAX_VM_CPU_CORES,
  PUBLIC_MAX_VM_RAM_GB,
} from '@/lib/public-site-config'

/**
 * Copy for the shared lander sections that speak more than one language.
 *
 * The section components own layout, icons, and motion; the words live here
 * so a lander in another locale can pass its own without forking a component,
 * and so the homepage's copy module can read them without importing JSX. The
 * English values are each section's default, which is what every `/l/`
 * lander renders.
 */

export type CopyCard = { title: string; body: string }

/** The platform grid names its cards by key, so a translation cannot pair a
 * title with the wrong icon by landing in the wrong slot. */
export const PRIMITIVE_KEYS = [
  'models',
  'computer',
  'browser',
  'install',
  'services',
  'agents',
  'workspace',
  'schedules',
  'apps',
] as const
export type PrimitiveKey = (typeof PRIMITIVE_KEYS)[number]

export type PrimitivesCopy = {
  eyebrow: string
  title: string
  intro: string
  primitives: Record<PrimitiveKey, CopyCard>
  capstone: CopyCard
}

export type IntegrationsCopy = {
  eyebrow: string
  title: string
  intro: string
  /** The agents people already use, plugging in. A page for readers who have
   * never used one leaves it out and shows only the tools. */
  agents?: CopyCard & { trail: string }
  tools: CopyCard & { trail: string }
}

/** The setup a reader would otherwise do themselves, beside the one thing
 * they do instead. */
export type SetupCopy = {
  eyebrow: string
  title: string
  intro: string
  before: { label: string; items: readonly string[] }
  after: { label: string; title: string; body: string }
}

export type ShareCopy = {
  eyebrow: string
  title: string
  intro: string
  /** Two or three cards. The last sits on the inverted surface, so it is the
   * one the section is really about. */
  cards: readonly [
    CopyCard & { label: string },
    CopyCard & { label: string },
    ...(CopyCard & { label: string })[],
  ]
}

/** Non-breaking hyphens in model names (GPT‑5) so a name never splits. */
const MODEL_LIST = PUBLIC_FRONTIER_MODELS.join(', ').replaceAll('-', '‑')

/** The machine facts, joined with non-breaking spaces so a number never
 * strands its unit. "Up to", because the VM widens with the plan and one
 * sentence cannot name one size. The pricing cards state each plan's own. */
export const MACHINE = {
  cores: PUBLIC_MAX_VM_CPU_CORES,
  ram: `${PUBLIC_MAX_VM_RAM_GB} GB`,
  storage: `${PUBLIC_MAX_STORAGE_GB} GB`,
  models: MODEL_LIST,
} as const

export const PRIMITIVES_COPY_EN: PrimitivesCopy = {
  eyebrow: 'The platform',
  title: 'Everything a modern agent needs, built in.',
  intro:
    'You define the agent, who it is, what it knows, and how it works. The memory, skill files, and apps it builds up are yours. The platform brings the rest.',
  primitives: {
    models: {
      title: 'Every frontier model, one gateway',
      body: `${MACHINE.models}, behind one gateway. You pick a quality level, not a model name: the strongest model for each task, at one flat rate.`,
    },
    computer: {
      title: 'A real computer, not a sandbox',
      body: `Every workspace is an always-on machine with up to ${MACHINE.cores}\u00A0cores, ${MACHINE.ram} of RAM and ${MACHINE.storage} of storage. Files, memory, and running work persist, and keep going when you close your laptop.`,
    },
    browser: {
      title: 'A browser of its own',
      body: 'Your agents click, type, log in, and act on the real web: filling forms, pulling reports, running the errand, not just reading pages. Sign in once and stay signed in.',
    },
    install: {
      title: 'Install anything',
      body: 'It’s a full computer, so agents install and run what an employee would: WhatsApp, Slack, a CLI, whatever the job needs. No request queue, no allowlist.',
    },
    services: {
      title: 'Services on tap',
      body: 'Image and video generation, contact, email, and social data sources, and more, through one built‑in service gateway. One bill, no API keys to wrangle.',
    },
    agents: {
      title: 'A team of agents, all of them yours',
      body: 'Define as many agents as the work needs, each with its own memory, skill files, and instructions. Spin one up in a minute, and everything it learns belongs to you, not to a seat.',
    },
    workspace: {
      title: 'One workspace, everyone in it',
      body: 'Files and shared memory every agent reads and writes, with teammates in the same sessions. Every run visible, every edit attributed. Share a folder and its context comes with it.',
    },
    schedules: {
      title: 'Schedules and triggers',
      body: 'Agents run on a schedule, wake on events, and keep working while you sleep. The morning report is done before you sit down.',
    },
    apps: {
      title: 'Ships real apps',
      body: 'Whatever an agent builds goes live at a real URL, hosted from the workspace, the moment it’s finished. Dashboards, tools, whole sites: shipped, not parked.',
    },
  },
  capstone: {
    title: 'Self-driving',
    body: 'Agents hold the same platform API you do. They start their own sessions, spin up new agents, hand work to each other, set their own schedules, install their own skills. Anything you can do on the platform, your agents can do. You describe the outcome. The platform runs itself.',
  },
}

export const INTEGRATIONS_COPY_EN: IntegrationsCopy = {
  eyebrow: 'Plays well with others',
  title: 'Bring your agents. Connect your tools.',
  intro: 'Duet doesn’t replace the agents your team loves. It’s where they work.',
  agents: {
    title: 'Your agents plug in',
    body: 'Point the agents you already use at your workspace, with its files, memory, and skills included.',
    trail: '+ your own',
  },
  tools: {
    title: 'Your tools connect',
    body: '3,000+ integrations, so agents read, write, and act in the tools your business already runs on.',
    trail: '+ 3,000 more',
  },
}

export const SHARE_COPY_EN: ShareCopy = {
  eyebrow: 'Share',
  title: 'An agent worth building is worth handing over.',
  intro:
    'An agent is its instructions, skills, and memory, and all of it lives in the workspace. Sharing an agent is as simple as sharing a folder.',
  cards: [
    {
      label: 'With your team',
      title: 'Your whole team gets the same specialist',
      body: 'Share an agent with your team and everyone works with the same one. Same context, same rules, same memory. What it learns helping one person, it knows for the next.',
    },
    {
      label: 'With your customers',
      title: 'Package what you know, and sell it',
      body: 'Publish an agent to the marketplace and your expertise becomes a product: customers hire the agent, you keep the method. Verified publishers, your price.',
    },
  ],
}
