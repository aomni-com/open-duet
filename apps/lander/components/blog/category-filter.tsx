'use client'

import { useLocale, useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'

import { cn } from '@repo/ui/lib/utils'

import { Link } from '@/i18n/navigation'
import { getAllCategories } from '@/lib/blog/categories'
import type { CategorySlug } from '@/lib/blog/types'
import type { AppLocale } from '@/lib/i18n/locales'

type CategoryFilterProps = {
  currentCategory?: CategorySlug
}

function pillClasses(active: boolean) {
  return cn(
    'rounded-full border px-4 py-1.5 text-xs font-medium uppercase tracking-[0.18em] transition-colors',
    active
      ? 'border-[hsl(214_65%_50%/0.4)] bg-[hsl(214_65%_50%/0.15)] text-[hsl(214_65%_50%)]'
      : 'border-white/10 bg-white/[0.03] text-white/65 hover:border-white/20 hover:text-white',
  )
}

export function CategoryFilter({ currentCategory }: CategoryFilterProps) {
  const pathname = usePathname()
  const locale = useLocale() as AppLocale
  const t = useTranslations('blogUi')
  const categories = getAllCategories()
  const isAllActive = (pathname === '/blog' || pathname === '/es/blog') && !currentCategory

  return (
    <div className="flex flex-wrap gap-2">
      <Link href="/blog" className={pillClasses(isAllActive)}>
        {t('all')}
      </Link>
      {categories.map(category => (
        <Link
          key={category.slug}
          href={`/blog/category/${category.slug}`}
          className={pillClasses(currentCategory === category.slug)}
        >
          {category.name[locale]}
        </Link>
      ))}
    </div>
  )
}
