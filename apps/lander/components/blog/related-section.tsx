'use client'

import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@repo/ui/components/shadcn/carousel'

import { serifStyle } from '@/components/landing/landing-styles'
import type { RelatedItem } from '@/lib/blog/types'

import { PostCard } from './post-card'

type RelatedSectionProps = {
  title: string
  items: RelatedItem[]
}

export function RelatedSection({ title, items }: RelatedSectionProps) {
  if (items.length === 0) return null

  const useCarousel = items.length > 3

  return (
    <section className="border-t border-white/10 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2
          className="mb-10 text-3xl font-normal leading-[1.05] tracking-[-0.75px] text-white md:text-4xl"
          style={serifStyle}
        >
          {title}
        </h2>

        {useCarousel ? (
          <Carousel opts={{ align: 'start', loop: false }} className="w-full" aria-label={title}>
            <CarouselContent className="-ml-4">
              {items.map(item => (
                <CarouselItem key={item.slug} className="pl-4 basis-full sm:basis-1/2 lg:basis-1/3">
                  <PostCard post={item} context={item.relatedContext} />
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious className="hidden sm:flex" />
            <CarouselNext className="hidden sm:flex" />
          </Carousel>
        ) : (
          <div className="grid md:grid-cols-3 gap-6">
            {items.map(item => (
              <PostCard key={item.slug} post={item} context={item.relatedContext} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
