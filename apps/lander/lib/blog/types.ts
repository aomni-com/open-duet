import { z } from 'zod'

export const BLOG_CATEGORIES = ['productivity', 'ai', 'integrations', 'guides', 'updates'] as const

export type CategorySlug = (typeof BLOG_CATEGORIES)[number]

export const AuthorZod = z.object({
  name: z.string(),
  avatar: z.string().optional(),
  role: z.string().optional(),
  link: z.union([z.url(), z.string().startsWith('/')]).optional(),
})

const HowToStepZod = z.object({
  name: z.string(),
  text: z.string(),
})

const HowToZod = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(HowToStepZod).min(2),
})

const RelatedRefZod = z.union([
  z.string(),
  z.object({
    slug: z.string(),
    context: z.string().optional(),
  }),
])

/**
 * Per-post CTA copy. Used by the inline mid-article injection AND the
 * trailing CTA at the end of the post. Authors should write copy that
 * speaks to what the reader just learned — generic "Run this workflow"
 * fallback exists but always under-converts. All fields optional so a
 * post can override just the bits that matter (e.g., new button label
 * but inherit the default href).
 */
const CtaCopyZod = z.object({
  title: z.string().max(140).optional(),
  subtitle: z.string().max(280).optional(),
  buttonText: z.string().max(40).optional(),
  /**
   * Where the button goes, as a path — never an origin. A lander route stays
   * relative, a product path (see `PRODUCT_CTA_PATHS`) is resolved against the
   * product origin, and an in-page anchor is left alone. Anything that is
   * none of the three fails `verify-public-content`.
   */
  href: z
    .string()
    .regex(/^[/#]/, 'must be a lander path, a product path, or an in-page anchor')
    .optional(),
})

export const PostFrontmatterZod = z.object({
  title: z.string(),
  metaTitle: z.string().optional(),
  description: z.string().max(200),
  date: z.string(),
  updatedAt: z.string().optional(),
  author: AuthorZod,
  category: z.enum(BLOG_CATEGORIES),
  tags: z.array(z.string()),
  image: z.string().optional(),
  draft: z.boolean().default(false),
  type: z.enum(['article', 'guide']).default('article'),
  howTo: HowToZod.optional(),
  relatedPosts: z.array(RelatedRefZod).optional(),
  boostRelated: z.boolean().default(false),
  cta: CtaCopyZod.optional(),
  locale: z.enum(['en', 'es-419']).default('en'),
  translationKey: z.string().optional(),
})

export type PostFrontmatter = z.infer<typeof PostFrontmatterZod>
export type RelatedRef = z.infer<typeof RelatedRefZod>
export type CtaCopy = z.infer<typeof CtaCopyZod>

export type TocHeading = {
  id: string
  text: string
  level: 2 | 3
}

export type Post = PostFrontmatter & {
  slug: string
  content: string
  readingTime: string
  headings: TocHeading[]
}

export type RelatedItem = Post & {
  relatedContext?: string
}

export type Author = z.infer<typeof AuthorZod>
