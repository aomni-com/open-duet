import type { AppLocale } from '@/lib/i18n/locales'
import { TRIAL_DAYS } from '@/lib/public-site-config'

export const listingCopy = {
  blog: {
    en: {
      title: 'Blog | Duet',
      headingEyebrow: 'Writing from Duet',
      headingLead: 'Notes on running your business',
      headingTrail: 'with AI.',
      description:
        'Writing from Duet on running your business with AI — playbooks, product updates, and deep dives.',
      body: 'Playbooks, product updates, and deep dives on using Duet to run the workflows that actually make money.',
      empty: 'No posts yet. Check back soon.',
      ctaLead: 'Stop reading about it.',
      ctaTrail: 'Start running it.',
      ctaDescription: `Hire Duet — your always-on AI. Start with a ${TRIAL_DAYS}-day free trial, no card required.`,
      primary: 'Start free',
      secondary: 'Browse guides',
    },
    'es-419': {
      title: 'Blog de Duet | Notas para operar tu negocio con AI',
      headingEyebrow: 'Notas de Duet',
      headingLead: 'Ideas para operar tu negocio',
      headingTrail: 'con AI.',
      description:
        'Notas de Duet sobre cómo operar tu negocio con AI: playbooks, novedades de producto y análisis prácticos.',
      body: 'Playbooks, novedades de producto y análisis para usar Duet en los workflows que realmente generan ingresos.',
      empty: 'Aún no hay publicaciones. Vuelve pronto.',
      ctaLead: 'Deja de leer sobre esto.',
      ctaTrail: 'Empieza a ejecutarlo.',
      ctaDescription: `Contrata a Duet, tu AI siempre activa. Empieza con una prueba gratis de ${TRIAL_DAYS} días, sin tarjeta.`,
      primary: 'Comenzar gratis',
      secondary: 'Ver guías',
    },
  },
  guides: {
    en: {
      title: 'Guides for running your business with AI | Duet',
      description:
        'Practical guides for Claude Code, MCP, agent skills, and agentic workflows. From beginner setup to running your entire business with AI.',
      eyebrow: 'Guides',
      headingLead: 'Run your business',
      headingTrail: 'with Duet.',
      body: 'Step-by-step playbooks for Claude Code, MCP, agent skills, and agentic workflows — from first setup to running every function of your business through one AI hire.',
      empty: 'Guides coming soon. Check back later.',
      ctaLead: 'Turn these guides',
      ctaTrail: 'into live workflows.',
      ctaDescription: `Hire Duet — your always-on AI with memory of your brand, your tools, and your past work. Start with a ${TRIAL_DAYS}-day free trial, no card required.`,
      primary: 'Start free',
      secondary: 'Read the blog',
      label: 'Guide',
    },
    'es-419': {
      title: 'Guías para operar tu negocio con AI | Duet',
      description:
        'Guías prácticas sobre Claude Code, MCP, skills de agentes y workflows agentic. Desde la primera configuración hasta operar tu negocio con AI.',
      eyebrow: 'Guías',
      headingLead: 'Opera tu negocio',
      headingTrail: 'con Duet.',
      body: 'Playbooks paso a paso para Claude Code, MCP, skills de agentes y workflows agentic: desde la primera configuración hasta operar cada función de tu negocio con un compañero de AI.',
      empty: 'Las guías llegan pronto. Vuelve más tarde.',
      ctaLead: 'Convierte estas guías',
      ctaTrail: 'en workflows vivos.',
      ctaDescription: `Contrata a Duet: AI siempre activa con memoria de tu marca, tus herramientas y tu trabajo. Empieza con una prueba gratis de ${TRIAL_DAYS} días, sin tarjeta.`,
      primary: 'Comenzar gratis',
      secondary: 'Leer el blog',
      label: 'Guía',
    },
  },
} as const

export type PricingCopy = {
  title: string
  description: string
  eyebrow: string
  h1Lead: string
  h1Trail: string
  subhead: string
  trust: string[]
}

export const pricingCopy = {
  en: {
    title: 'Pricing — Duet',
    description: `Monthly plans for your AI hire, from Starter to Max. Begin with a ${TRIAL_DAYS}-day free trial; included credits reset each month.`,
    eyebrow: 'Start small. Let us earn the next month.',
    h1Lead: 'A plan for the work',
    h1Trail: "you're ready to hand off.",
    subhead: `Take ${TRIAL_DAYS} days free, then choose the monthly plan that fits. Credits reset each period; your paid reserve keeps overage moving.`,
    trust: ['Private cloud', 'Outcome-based AI tiers', 'Data enrichment', '10K+ integrations'],
  },
  'es-419': {
    title: 'Precios — Duet',
    description: `Planes mensuales para tu compañero de AI, de Starter a Max. Empieza con una prueba gratis de ${TRIAL_DAYS} días; los créditos incluidos se reinician cada mes.`,
    eyebrow: 'Empieza en pequeño. Déjanos ganarnos el próximo mes.',
    h1Lead: 'Un plan para el trabajo',
    h1Trail: 'que ya quieres delegar.',
    subhead: `Prueba ${TRIAL_DAYS} días gratis y elige el plan mensual que encaje. Los créditos se reinician cada período; tu reserva pagada cubre el uso adicional.`,
    trust: [
      'Nube privada',
      'Niveles de AI por resultado',
      'Enriquecimiento de datos',
      '10K+ integraciones',
    ],
  },
} satisfies Record<AppLocale, PricingCopy>
