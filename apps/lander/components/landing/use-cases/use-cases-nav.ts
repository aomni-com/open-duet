/**
 * Tiny client-safe list of persona nav entries used by the landing
 * navbar dropdown (desktop + mobile). Intentionally split out from
 * `use-cases-spec.ts` so the nav — which renders on every lander
 * page (home, pricing, guides, blog, use-cases) — doesn't pull the
 * full persona payload (long-form copy, prompts, FAQs) into the
 * client bundle for visitors who never open the menu.
 *
 * If you add a persona, update both this list and `USE_CASE_PERSONAS`
 * in `use-cases-spec.ts`. The persona-page renderer/hub still reads
 * from the spec; only the navbar reads from here.
 *
 * `leaves` is the long-tail sub-use-case set under a persona. The
 * navbar dropdown doesn't render leaves directly (we'd blow past the
 * cognitive budget of a single menu), but they're listed here so the
 * sitemap, the persona-page sub-use-cases grid, and any future
 * mega-menu can read the same source.
 */

import type { AppLocale } from '@/lib/i18n/locales'

export type UseCaseNavLeafEntry = {
  slug: string
  navLabel: Record<AppLocale, string>
}

export type UseCaseNavEntry = {
  slug: string
  navLabel: Record<AppLocale, string>
  /** Short subtitle shown below the title in the navbar dropdown. */
  navSubtitle: Record<AppLocale, string>
  /** Phosphor icon name (e.g. 'FileText') used in the dropdown left column. */
  navIcon: string
  /** Path to the preview image shown in the dropdown right column. */
  previewImage: string
  /** Headline shown in the dropdown right-panel preview. */
  previewHeadline: Record<AppLocale, string>
  /** One-liner shown below the headline in the dropdown right-panel. */
  previewBody: Record<AppLocale, string>
  leaves?: readonly UseCaseNavLeafEntry[]
}

export const USE_CASE_NAV_ENTRIES: readonly UseCaseNavEntry[] = [
  {
    slug: 'small-businesses',
    navLabel: { en: 'Small Businesses', 'es-419': 'Pequeños negocios' },
    navSubtitle: { en: 'AI for small business owners', 'es-419': 'IA para dueños de negocios' },
    navIcon: 'FileText',
    previewImage: '/use-cases/small-businesses.webp',
    previewHeadline: {
      en: 'AI for the people actually running the business.',
      'es-419': 'IA para quienes realmente dirigen el negocio.',
    },
    previewBody: {
      en: 'One coworker, one workspace, ten things off the to-do list by tomorrow.',
      'es-419': 'Un colaborador, un espacio de trabajo, diez tareas menos para mañana.',
    },
    leaves: [
      {
        slug: 'shopify-store',
        navLabel: { en: 'Shopify stores', 'es-419': 'Tiendas de Shopify' },
      },
      {
        slug: 'service-business-owner',
        navLabel: { en: 'Service businesses', 'es-419': 'Negocios de servicios' },
      },
    ],
  },
  {
    slug: 'agencies',
    navLabel: { en: 'Creative Agencies', 'es-419': 'Agencias creativas' },
    navSubtitle: { en: 'AI for creative agencies', 'es-419': 'IA para agencias creativas' },
    navIcon: 'PenNib',
    previewImage: '/use-cases/agencies.webp',
    previewHeadline: {
      en: 'Deliver more. Pitch faster. Keep clients happier.',
      'es-419': 'Entrega más. Cotiza más rápido. Clientes más felices.',
    },
    previewBody: {
      en: 'Duet handles the repeatable work so your team stays in creative flow.',
      'es-419': 'Duet se encarga del trabajo repetible para que tu equipo se mantenga creativo.',
    },
  },
  {
    slug: 'founders',
    navLabel: { en: 'Startup Founders', 'es-419': 'Founders de startups' },
    navSubtitle: { en: 'Learn how to use', 'es-419': 'Aprende a usarlo' },
    navIcon: 'User',
    previewImage: '/use-cases/founders.webp',
    previewHeadline: {
      en: 'Move like a team of ten. Stay lean.',
      'es-419': 'Muévete como un equipo de diez. Mantente ágil.',
    },
    previewBody: {
      en: "Research, write, build, and ship — without hiring before you're ready.",
      'es-419': 'Investiga, escribe, construye y lanza — sin contratar antes de estar listo.',
    },
  },
  {
    slug: 'sales-teams',
    navLabel: { en: 'Sales Teams', 'es-419': 'Equipos de ventas' },
    navSubtitle: { en: 'Learn how to use', 'es-419': 'Aprende a usarlo' },
    navIcon: 'Target',
    previewImage: '/use-cases/sales-teams.webp',
    previewHeadline: {
      en: 'More pipeline. Less busywork.',
      'es-419': 'Más pipeline. Menos trabajo tedioso.',
    },
    previewBody: {
      en: 'Prospect smarter, personalize at scale, and follow up without dropping the ball.',
      'es-419': 'Prospecta mejor, personaliza a escala y haz seguimiento sin perder el hilo.',
    },
  },
  {
    slug: 'operations',
    navLabel: { en: 'Operations Teams', 'es-419': 'Equipos de operaciones' },
    navSubtitle: { en: 'Learn how to use', 'es-419': 'Aprende a usarlo' },
    navIcon: 'Megaphone',
    previewImage: '/use-cases/operations.webp',
    previewHeadline: {
      en: "Run ops. Don't let ops run you.",
      'es-419': 'Dirige las operaciones. No dejes que te dirijan.',
    },
    previewBody: {
      en: 'Automate reports, monitor workflows, and keep every process on track.',
      'es-419': 'Automatiza reportes, supervisa flujos y mantén cada proceso en orden.',
    },
  },
] as const
