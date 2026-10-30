import { getAllCampaignSlugs } from '@/components/landing/campaign/campaign-spec'
import { getAllVerticalSlugs } from '@/components/landing/for/verticals-spec'
import {
  getAllJobParams,
  getAllPersonaLeafParams,
} from '@/components/landing/use-cases/use-cases-spec'
import { getAllComparisonParams } from '@/components/landing/vs/vs-spec'
import {
  getAllGuides,
  getAllPosts,
  getAllTags,
  getTranslatedLocalesForPost,
} from '@/lib/blog/content'
import { BLOG_CATEGORIES } from '@/lib/blog/types'
import type { AppLocale } from '@/lib/i18n/locales'
import { publicRedirectTarget } from '@/lib/i18n/path-classification'

const BILINGUAL_STATIC_PATHS = [
  '/',
  '/blog',
  '/data-protection',
  '/for',
  '/guides',
  '/pricing',
  '/privacy-policy',
  '/terms',
  '/use-cases',
  '/use-cases/agencies',
  '/use-cases/by-job',
  '/use-cases/founders',
  '/use-cases/operations',
  '/use-cases/sales-teams',
  '/use-cases/small-businesses',
  '/vs',
] as const

export type PublicRoute = {
  publicPath: string
  prerenderPath: string
  kind: 'marketing' | 'editorial' | 'campaign' | 'preserved'
}

export function getPublicRouteManifest(): PublicRoute[] {
  const routes: PublicRoute[] = []
  const localized = (
    pathname: string,
    locale: AppLocale,
    kind: PublicRoute['kind'],
    prerenderPathname = pathname,
  ) => {
    routes.push({
      publicPath: localizePublic(pathname, locale),
      prerenderPath: localizeInternal(prerenderPathname, locale),
      kind,
    })
  }

  for (const pathname of BILINGUAL_STATIC_PATHS) {
    localized(pathname, 'en', 'marketing')
    localized(pathname, 'es-419', 'marketing')
  }
  for (const post of getAllPosts('en')) {
    for (const locale of getTranslatedLocalesForPost('blog', post.slug)) {
      localized(`/blog/${post.slug}`, locale, 'editorial')
    }
  }
  for (const guide of getAllGuides('en')) {
    for (const locale of getTranslatedLocalesForPost('guides', guide.slug)) {
      localized(`/guides/${guide.slug}`, locale, 'editorial')
    }
  }
  for (const category of BLOG_CATEGORIES) {
    localized(`/blog/category/${category}`, 'en', 'editorial')
    localized(`/blog/category/${category}`, 'es-419', 'editorial')
  }
  for (const locale of ['en', 'es-419'] as const) {
    for (const tag of getAllTags(locale)) {
      localized(`/blog/tag/${encodeURIComponent(tag)}`, locale, 'editorial', `/blog/tag/${tag}`)
    }
  }
  for (const vertical of getAllVerticalSlugs()) {
    localized(`/for/${vertical}`, 'en', 'marketing')
  }
  for (const { persona, leaf } of getAllPersonaLeafParams()) {
    localized(`/use-cases/${persona}/${leaf}`, 'en', 'marketing')
    localized(`/use-cases/${persona}/${leaf}`, 'es-419', 'marketing')
  }
  for (const { slug } of getAllJobParams()) {
    localized(`/use-cases/by-job/${slug}`, 'en', 'marketing')
    localized(`/use-cases/by-job/${slug}`, 'es-419', 'marketing')
  }
  for (const { slug } of getAllComparisonParams()) {
    localized(`/vs/${slug}`, 'en', 'marketing')
    localized(`/vs/${slug}`, 'es-419', 'marketing')
  }
  for (const slug of getAllCampaignSlugs()) {
    // Campaign landers: EN-only, noindexed, never sitemapped — but still part
    // of the closed world so the build and visual gates verify them.
    localized(`/l/${slug}`, 'en', 'campaign')
  }
  for (const publicPath of ['/install'] as const) {
    routes.push({ publicPath, prerenderPath: publicPath, kind: 'preserved' })
  }

  return [...new Map(routes.map(route => [route.publicPath, route])).values()].sort((a, b) =>
    a.publicPath.localeCompare(b.publicPath),
  )
}

export const PUBLIC_ROUTE_MANIFEST = getPublicRouteManifest()

export type DeployedPublicRoute = {
  path: string
  kind: PublicRoute['kind']
  status: 200 | 308
  redirectTo?: string
}

export const DEPLOYED_PUBLIC_ROUTE_MANIFEST: DeployedPublicRoute[] = PUBLIC_ROUTE_MANIFEST.map(
  route => {
    const redirectTo = publicRedirectTarget(route.publicPath)
    return {
      path: route.publicPath,
      kind: route.kind,
      status: redirectTo === null ? 200 : 308,
      ...(redirectTo === null ? {} : { redirectTo }),
    }
  },
)

function localizeInternal(pathname: string, locale: AppLocale): string {
  const suffix = pathname === '/' ? '' : pathname
  return `/${locale}${suffix}`
}

function localizePublic(pathname: string, locale: AppLocale): string {
  if (locale === 'en') return pathname
  return pathname === '/' ? '/es' : `/es${pathname}`
}
