import { PUBLIC_FRONTIER_MODELS } from '@/lib/public-site-config'

/**
 * Copy for the platform lander at `/l/platform`.
 *
 * Kept out of the components because non-visual callers read it — the
 * lander's metadata, and the campaign registry that names every `/l/` slug —
 * and importing a component to reach a string pulls the whole landing chrome
 * (and its image and video dependencies) into a text pipeline.
 */

/** The hero's rotating bracket. The first word is the static fallback for
 * reduced motion, no-JS, and SEO snapshots. */
export const PLATFORM_HERO_WORDS = ['team', 'customers', 'business'] as const

export const PLATFORM_TITLE = 'Duet — Create and share AI agents with your team'

export const PLATFORM_DESCRIPTION =
  'Duet is the platform for building agents you own — every frontier model, a real always-on computer, a browser of its own, and the tools your business runs on. The memory, the skills, the apps: yours to share with anyone, or sell as your own product.'

export const PLATFORM_FAQS = [
  {
    q: 'We already use ChatGPT Work or Codex. Why would we add Duet?',
    a: 'You don’t switch — you connect. Duet plugs directly into ChatGPT Work and Codex and runs on the token quota you already pay for. They bring the horsepower; Duet is where the agent you build lives — and everything it becomes stays yours.',
  },
  {
    q: 'What is an agent here, actually?',
    a: 'Files you own, in a workspace you control: the instructions that define it, the memory it accumulates, the skill files that teach it your methods, the apps it builds and hosts. Nothing hides in a proprietary format — which is exactly why an agent can be shared like a folder or sold like a product.',
  },
  {
    q: 'Who owns what I build?',
    a: 'You do — fully. The agents, their memories, their skill files, the apps they ship: all of it lives as plain files in your workspace. Take it with you any time; there is no proprietary runtime to reverse-engineer and nothing held hostage.',
  },
  {
    q: 'Can I sell an agent I’ve built?',
    a: 'Yes. Publish it to the marketplace, set your price, and customers hire your agent. They get the results; your method — the skills and memory that make it yours — stays under the hood, with your name on the work.',
  },
  {
    q: 'How does sharing work for a team or company?',
    a: 'Like file sharing, because it is file sharing. Share an agent — or a whole folder of them — and every teammate works with the same one: same context, same rules, same memory. What it learns helping one person, it knows for the next.',
  },
  {
    q: 'Which AI models does Duet run on?',
    a: `All the best ones — ${PUBLIC_FRONTIER_MODELS.join(', ')} — and you never have to choose between them. Duet routes every task to the model that is strongest at it and re-decides as the work changes. You pick a quality level, not a model name, and the rate is flat whichever model answers.`,
  },
  {
    q: 'Does this replace the AI tools my team already uses?',
    a: 'No — it connects them. Your team keeps the agents they love; Duet is the layer where what those agents learn and build accumulates into something you own, instead of evaporating seat by seat.',
  },
  {
    q: 'Is my data private?',
    a: 'Every workspace runs in your own dedicated environment with its own memory and files. Your data — and everything your agents learn from it — is never pooled with other customers, and you control which agents and people can reach each folder.',
  },
] as const
