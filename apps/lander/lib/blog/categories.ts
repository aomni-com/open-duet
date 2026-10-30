import type { AppLocale } from '@/lib/i18n/locales'

import type { CategorySlug } from './types'

type LocalizedCategory = {
  name: Record<AppLocale, string>
  description: Record<AppLocale, string>
  slug: CategorySlug
  color: string
}

export const CATEGORY_CONFIG: Record<CategorySlug, LocalizedCategory> = {
  productivity: {
    name: {
      en: 'Productivity',
      'es-419': 'Productividad',
    },
    description: {
      en: 'Tips and strategies for team productivity',
      'es-419': 'Consejos y estrategias para la productividad del equipo',
    },
    slug: 'productivity',
    color: 'bg-blue-500',
  },
  ai: {
    name: {
      en: 'AI & Automation',
      'es-419': 'AI y automatización',
    },
    description: {
      en: 'AI features and automation workflows',
      'es-419': 'Funciones de AI y flujos de automatización',
    },
    slug: 'ai',
    color: 'bg-purple-500',
  },
  integrations: {
    name: {
      en: 'Integrations',
      'es-419': 'Integraciones',
    },
    description: {
      en: 'Connect your favorite tools with Duet',
      'es-419': 'Conecta tus herramientas favoritas con Duet',
    },
    slug: 'integrations',
    color: 'bg-green-500',
  },
  guides: {
    name: {
      en: 'Guides',
      'es-419': 'Guías',
    },
    description: {
      en: 'In-depth tutorials and how-tos',
      'es-419': 'Tutoriales detallados y guías prácticas',
    },
    slug: 'guides',
    color: 'bg-orange-500',
  },
  updates: {
    name: {
      en: 'Product Updates',
      'es-419': 'Novedades del producto',
    },
    description: {
      en: 'Latest features and improvements',
      'es-419': 'Últimas funciones y mejoras',
    },
    slug: 'updates',
    color: 'bg-cyan-500',
  },
}

export function getCategoryConfig(slug: CategorySlug) {
  return CATEGORY_CONFIG[slug]
}

export function getAllCategories() {
  return Object.values(CATEGORY_CONFIG)
}

export function getCategoryName(slug: CategorySlug, locale: AppLocale): string {
  return CATEGORY_CONFIG[slug].name[locale]
}

export function getCategoryDescription(slug: CategorySlug, locale: AppLocale): string {
  return CATEGORY_CONFIG[slug].description[locale]
}
