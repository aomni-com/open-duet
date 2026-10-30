'use client'

import { CaretDown } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/shadcn/collapsible'
import { cn } from '@repo/ui/lib/utils'

import { groupHeadingsBySections } from '@/lib/blog/toc'
import type { TocHeading } from '@/lib/blog/types'
import { useActiveHeading } from '@/lib/blog/use-active-heading'

type TocSidebarProps = {
  headings: TocHeading[]
}

export function TocSidebar({ headings }: TocSidebarProps) {
  const t = useTranslations('blogUi')
  const sections = groupHeadingsBySections(headings)
  const headingIds = headings.map(h => h.id)
  const activeId = useActiveHeading(headingIds)

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault()
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' })
      window.history.pushState(null, '', `#${id}`)
    }
  }

  if (sections.length === 0) {
    return null
  }

  return (
    <nav className="space-y-1">
      <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.25em] text-white/55">
        {t('onThisPage')}
      </p>
      {sections.map(section => {
        const isActive = activeId === section.id
        return (
          <Collapsible key={section.id} defaultOpen className="group/collapsible">
            <CollapsibleTrigger asChild>
              <button
                className={cn(
                  'relative flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors duration-200',
                  isActive ? 'text-white' : 'text-white/60 hover:bg-white/[0.04] hover:text-white',
                )}
              >
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-1.5 left-0 w-0.5 rounded-full"
                    style={{ background: 'hsl(214 65% 50%)' }}
                  />
                ) : null}
                <a
                  href={`#${section.id}`}
                  onClick={e => handleClick(e, section.id)}
                  className="flex-1 truncate text-left"
                >
                  {section.text}
                </a>
                {section.children.length > 0 && (
                  <CaretDown
                    className={cn(
                      'ml-2 h-4 w-4 shrink-0 transition-transform duration-200',
                      'group-data-[state=open]/collapsible:rotate-180',
                    )}
                  />
                )}
              </button>
            </CollapsibleTrigger>
            {section.children.length > 0 && (
              <CollapsibleContent>
                <div className="ml-3 mt-1 space-y-1 border-l border-white/10 pl-3">
                  {section.children.map(child => {
                    const childActive = activeId === child.id
                    return (
                      <a
                        key={child.id}
                        href={`#${child.id}`}
                        onClick={e => handleClick(e, child.id)}
                        className={cn(
                          'block rounded-lg px-3 py-1.5 text-sm transition-colors duration-200',
                          childActive
                            ? 'text-white'
                            : 'text-white/45 hover:bg-white/[0.04] hover:text-white',
                        )}
                      >
                        {child.text}
                      </a>
                    )
                  })}
                </div>
              </CollapsibleContent>
            )}
          </Collapsible>
        )
      })}
    </nav>
  )
}
