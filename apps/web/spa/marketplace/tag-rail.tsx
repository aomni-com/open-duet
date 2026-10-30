import { useTranslations } from 'next-intl'

import type { AgentTag } from '@repo/contract'

import type { TagSelection } from './tag-filter'

/** Message key per tag. Kept here so the vocabulary has one translation owner. */
const TAG_LABEL_KEY: Record<AgentTag, string> = {
  sales: 'tagSales',
  marketing: 'tagMarketing',
  engineering: 'tagEngineering',
  'customer-support': 'tagCustomerSupport',
  operations: 'tagOperations',
  people: 'tagPeople',
  product: 'tagProduct',
  personal: 'tagPersonal',
}

/**
 * The catalog's filter row. Single-select, because a browsing user is asking
 * "what does this do for me" — one job at a time — and multi-select would make
 * an empty result the normal outcome of two clicks.
 *
 * Selection is route state held by the caller, not a stored preference: a
 * filter that survives a reload leaves someone staring at a catalog that looks
 * broken because they filtered it last week.
 */
export function MarketplaceTagRail({
  tags,
  selected,
  onSelect,
}: {
  tags: readonly AgentTag[]
  selected: TagSelection
  onSelect: (selection: TagSelection) => void
}) {
  const t = useTranslations('duetApp.marketplace')
  // With one tag or none, the rail can only filter to what is already shown.
  if (tags.length < 2) return null

  const chip = (key: string, label: string, isSelected: boolean, select: () => void) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={isSelected}
      data-testid={`marketplace-tag-${key}`}
      onClick={select}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        isSelected
          ? 'border-foreground bg-foreground text-background'
          : 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div
      role="radiogroup"
      aria-label={t('filterByTag')}
      data-testid="marketplace-tag-rail"
      /* Centred to match the header above it and the card grid below. Left
         aligned, it reads as a stray control rather than part of the page. */
      className="mb-8 flex flex-wrap justify-center gap-2"
    >
      {chip('all', t('allTags'), selected === null, () => onSelect(null))}
      {tags.map(tag => chip(tag, t(TAG_LABEL_KEY[tag]), selected === tag, () => onSelect(tag)))}
    </div>
  )
}
