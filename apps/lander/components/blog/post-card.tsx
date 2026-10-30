import Image from 'next/image'

import { cn } from '@repo/ui/lib/utils'

import { serifStyle } from '@/components/landing/landing-styles'
import { Link } from '@/i18n/navigation'
import { getCategoryName } from '@/lib/blog/categories'
import type { Post } from '@/lib/blog/types'

import { ThemedImage } from './themed-image'

type PostCardProps = {
  post: Post
  variant?: 'default' | 'featured'
  context?: string
}

export function PostCard({ post, variant = 'default', context }: PostCardProps) {
  const categoryName = getCategoryName(post.category, post.locale)
  const isFeatured = variant === 'featured'
  const basePath = post.type === 'guide' ? '/guides' : '/blog'
  const description = context ?? post.description

  return (
    <article
      className={cn(
        'liquid-glass group relative flex flex-col overflow-hidden rounded-2xl transition-transform duration-300 hover:-translate-y-0.5',
        isFeatured && 'md:flex-row',
      )}
    >
      {post.image && (
        <Link
          href={`${basePath}/${post.slug}`}
          className={cn(
            'relative aspect-video overflow-hidden',
            isFeatured ? 'md:aspect-auto md:w-1/2' : 'w-full',
          )}
        >
          <ThemedImage
            src={post.image}
            alt={post.title}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to top, color-mix(in oklab, var(--lv2-bg) 70%, transparent), transparent 60%)',
            }}
          />
        </Link>
      )}
      <div className={cn('flex flex-col p-6', isFeatured && 'md:w-1/2 md:p-8')}>
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-full border border-[hsl(214_65%_50%/0.25)] bg-[hsl(214_65%_50%/0.1)] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-[hsl(214_65%_50%)]">
            {categoryName}
          </span>
          <span className="text-xs text-white/55">{post.readingTime}</span>
        </div>
        <Link href={`${basePath}/${post.slug}`} className="group/title">
          <h3
            className={cn(
              'font-normal leading-[1.08] tracking-[-0.5px] text-white transition-colors group-hover/title:text-white',
              isFeatured ? 'mb-3 text-3xl md:text-4xl' : 'mb-2 text-xl',
            )}
            style={serifStyle}
          >
            {post.title}
          </h3>
        </Link>
        <p
          className={cn(
            'line-clamp-2 text-white/70',
            isFeatured ? 'mb-4 text-base' : 'mb-3 text-sm',
          )}
        >
          {description}
        </p>
        <div className="mt-auto flex items-center gap-3 pt-2">
          {post.author.avatar && (
            <Image
              src={post.author.avatar}
              alt={post.author.name}
              width={28}
              height={28}
              className="rounded-full ring-2 ring-white/10"
            />
          )}
          <div className="flex flex-col">
            <span className="text-sm text-white/85">{post.author.name}</span>
            <time className="text-xs text-white/55">
              {new Date(post.date).toLocaleDateString(post.locale === 'es-419' ? 'es' : 'en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </time>
          </div>
        </div>
      </div>
    </article>
  )
}
