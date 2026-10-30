import { VERTICALS } from '@/components/landing/for/verticals-spec'
import { HOME_COPY } from '@/components/landing/landers/home-copy'
import { getUseCaseJobs, getUseCasePersonas } from '@/components/landing/use-cases/use-cases-spec'
import { getComparisons } from '@/components/landing/vs/vs-spec'
import { getAllGuides, getAllPosts } from '@/lib/blog/content'
import { listingCopy, pricingCopy } from '@/lib/i18n/page-copy'
import {
  PUBLIC_SUBSCRIPTION_PLANS,
  PUBLIC_TIERS,
  SUPPORT_EMAIL,
  TRIAL_DAYS,
} from '@/lib/public-site-config'
import { agentInstallText } from '@/src/install-copy'
import { siteConfig } from '@/src/site-config'

import { faqSection, linkList, section } from './markdown'

/**
 * The pages whose copy lives in JSX rather than in a spec or an MDX file.
 *
 * Each entry frames the page in a line or two and then derives its substance
 * from the same owner the page itself reads — the verticals spec, the
 * use-case spec, the listing copy, the pricing contract. Restating a price or
 * a plan name here would put a second copy of a product fact on a public URL,
 * which is the drift `lib/public-site-config.ts` exists to prevent.
 *
 * Legal pages are the deliberate exception: their body is the legal text, it
 * is not a product explanation, and paraphrasing it would be worse than
 * pointing at it.
 */
export type StaticPage = {
  title: string
  description: string
  body: () => string
}

export const STATIC_PAGES: Record<string, StaticPage> = {
  '/': {
    title: HOME_COPY.en.title,
    description: HOME_COPY.en.description,
    body: () =>
      [
        HOME_COPY.en.hero.sub,
        section(
          HOME_COPY.en.outcomes.title,
          HOME_COPY.en.outcomes.pillars.map(p => `- **${p.title}.** ${p.body}`).join('\n'),
        ),
        section(HOME_COPY.en.setup.after.title, HOME_COPY.en.setup.after.body),
        section(
          HOME_COPY.en.platform.title,
          Object.values(HOME_COPY.en.platform.primitives)
            .map(p => `- **${p.title}.** ${p.body}`)
            .join('\n'),
        ),
        faqSection(HOME_COPY.en.faq.title, HOME_COPY.en.faq.items),
      ].join('\n\n'),
  },

  '/pricing': {
    title: pricingCopy.en.title,
    description: pricingCopy.en.description,
    body: () =>
      [
        `${pricingCopy.en.h1Lead} ${pricingCopy.en.h1Trail}`,
        pricingCopy.en.subhead,
        section(
          'Monthly plans',
          PUBLIC_SUBSCRIPTION_PLANS.map(
            plan =>
              `- **${plan.id}** — ${plan.monthlyPrice}/month, with a ${plan.bonusPercent}% credit bonus.`,
          ).join('\n'),
        ),
        section(
          'Model tiers',
          [
            'You pick a quality level, not a model name. Duet routes each task to the strongest model for it and the rate is flat whichever model answers.',
            ...PUBLIC_TIERS.map(tier => `- **${tier.label}** — ${tier.description}`),
          ].join('\n\n'),
        ),
        `Every plan starts with a ${TRIAL_DAYS}-day free trial and no card. Credits reset each period.`,
      ].join('\n\n'),
  },

  '/blog': {
    title: listingCopy.blog.en.title,
    description: listingCopy.blog.en.description,
    body: () =>
      [
        listingCopy.blog.en.body,
        section(
          'Posts',
          linkList(getAllPosts('en').map(post => ({ path: `/blog/${post.slug}`, ...post }))),
        ),
      ].join('\n\n'),
  },

  '/guides': {
    title: listingCopy.guides.en.title,
    description: listingCopy.guides.en.description,
    body: () =>
      [
        listingCopy.guides.en.body,
        section(
          'Guides',
          linkList(getAllGuides('en').map(guide => ({ path: `/guides/${guide.slug}`, ...guide }))),
        ),
      ].join('\n\n'),
  },

  '/for': {
    title: 'Duet by industry',
    description:
      'How Duet works for a specific trade or practice — the leads it chases, the paperwork it drafts, and the follow-up it never forgets.',
    body: () =>
      section(
        'Industries',
        linkList(
          VERTICALS.map(vertical => ({
            path: `/for/${vertical.slug}`,
            title: vertical.audience,
            description: vertical.metaDescription,
          })),
        ),
      ),
  },

  '/vs': {
    title: 'Duet comparisons',
    description:
      'Honest, monthly-refreshed comparisons of Duet against the coding agents and AI app builders people cross-shop it with.',
    body: () =>
      section(
        'Comparisons',
        linkList(
          getComparisons().map(comparison => ({
            path: `/vs/${comparison.slug}`,
            title: `Duet vs ${comparison.competitor}`,
            description: comparison.metaDescription,
          })),
        ),
      ),
  },

  '/use-cases': {
    title: 'Duet by role',
    description:
      'What an AI coworker does for small business owners, founders, agencies, operations, and sales teams.',
    body: () =>
      section(
        'Roles',
        linkList(
          getUseCasePersonas().map(persona => ({
            path: `/use-cases/${persona.slug}`,
            title: persona.name,
            description: persona.metaDescription,
          })),
        ),
      ),
  },

  '/use-cases/by-job': {
    title: 'Duet by job',
    description:
      'The individual workflows an AI coworker can own end to end, from inbox triage to invoicing to SEO.',
    body: () =>
      section(
        'Jobs',
        linkList(
          getUseCaseJobs().map(job => ({
            path: `/use-cases/by-job/${job.slug}`,
            title: job.title,
            description: job.metaDescription,
          })),
        ),
      ),
  },

  '/install': {
    title: 'Connect an agent to Duet',
    description:
      'Install the duet CLI, sign in with human approval, and point an MCP client at the hosted Duet server.',
    body: () => agentInstallText(siteConfig()),
  },

  '/terms': legalPage(
    'Terms of Service',
    'The contract governing use of Duet, including acceptable use, billing, and termination.',
  ),
  '/privacy-policy': legalPage(
    'Privacy Policy',
    'What data Duet collects, how it is used, and the choices you have over it.',
  ),
  '/data-protection': legalPage(
    'Data Protection',
    'How Duet isolates, stores, and processes customer data, including subprocessors and DPA terms.',
  ),
}

function legalPage(title: string, description: string): StaticPage {
  return {
    title,
    description,
    body: () =>
      [
        description,
        `The controlling text is the page itself — it is a legal document, and a summary of it is not the agreement. Read it in full at the URL above, or write to ${SUPPORT_EMAIL} with questions.`,
      ].join('\n\n'),
  }
}
