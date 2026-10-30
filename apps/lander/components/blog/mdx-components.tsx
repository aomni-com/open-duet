import type { MDXComponents } from 'mdx/types'
import Image from 'next/image'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@repo/ui/components/shadcn/accordion'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/shadcn/alert'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/shadcn/collapsible'
import { cn } from '@repo/ui/lib/utils'

import { Link } from '@/i18n/navigation'
import { productHref } from '@/src/config/origins'

import { AnswerBox } from './answer-box'
import { Callout } from './callout'
import { CodeHighlight } from './code-highlight'
import { DuetCTA } from './duet-cta'
import { GuideTOC } from './guide-toc'
import { ResourcesCTA } from './resources-cta'
import { ThemedImage } from './themed-image'
import { Video } from './video'
import { YouTubeEmbed } from './youtube-embed'

// Pre component that extracts code and passes to CodeHighlight
const PreComponent = (props: React.ComponentProps<'pre'>) => {
  const codeElement = props.children as React.ReactElement<{
    className?: string
    children?: string
  }>
  const codeString = String(codeElement?.props?.children ?? '')

  if (!codeElement || !codeString) {
    return (
      <pre className="my-6 overflow-x-auto rounded-lg border border-lv2-line bg-[color:var(--lv2-code-bg)] p-4 text-[color:var(--lv2-code-fg)]">
        {props.children}
      </pre>
    )
  }

  // Extract language from className (e.g., "language-javascript" or "lang-javascript")
  const className = codeElement?.props?.className ?? ''
  const language = className.replace('language-', '').replace('lang-', '').trim() || undefined

  return <CodeHighlight code={codeString} language={language} />
}

// Inline code component with explicit no-backticks styling
const InlineCode = ({ children }: { children?: React.ReactNode }) => (
  <code
    className={cn(
      'relative rounded bg-muted px-[0.3rem] py-[0.2rem]',
      'font-mono text-sm',
      'before:content-none after:content-none',
    )}
  >
    {children}
  </code>
)

function LinkedInPostPreview({
  href,
  src,
  alt,
  caption,
}: {
  href: string
  src: string
  alt: string
  caption: string
}) {
  return (
    <figure className="my-6">
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        <Image
          src={src}
          alt={alt}
          width={504}
          height={542}
          className="mx-auto h-auto w-full max-w-[504px] rounded-lg border border-lv2-line"
        />
      </a>
      <figcaption className="mt-2 text-center text-sm text-muted-foreground">{caption}</figcaption>
    </figure>
  )
}

function ProductLink({
  path,
  children,
  paragraph = false,
}: {
  path: string
  children?: ReactNode
  paragraph?: boolean
}) {
  const meaningfulChildren = Children.toArray(children).filter(
    child => typeof child !== 'string' || child.trim() !== '',
  )
  const onlyChild = meaningfulChildren.length === 1 ? meaningfulChildren[0] : undefined
  const linkChildren =
    paragraph && isValidElement(onlyChild)
      ? (onlyChild as ReactElement<{ children?: ReactNode }>).props.children
      : children
  const link = (
    <a
      href={productHref(path)}
      className="text-primary underline underline-offset-4 transition-colors hover:text-primary/80"
    >
      {linkChildren}
    </a>
  )
  return paragraph ? <p className="leading-7 [&:not(:first-child)]:mt-4">{link}</p> : link
}

// Components object for use with next-mdx-remote
export const mdxComponents: MDXComponents = {
  h1: ({ children, id }) => (
    <h1 id={id} className="scroll-mt-24 text-4xl font-bold mt-8 mb-4 tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children, id }) => (
    <h2
      id={id}
      className="scroll-mt-24 text-2xl font-semibold mt-10 mb-4 pb-2 border-b border-white/10"
    >
      {children}
    </h2>
  ),
  h3: ({ children, id }) => (
    <h3 id={id} className="scroll-mt-24 text-xl font-semibold mt-8 mb-3">
      {children}
    </h3>
  ),
  h4: ({ children, id }) => (
    <h4 id={id} className="scroll-mt-24 text-lg font-semibold mt-6 mb-2">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="leading-7 [&:not(:first-child)]:mt-4">{children}</p>,
  a: ({ href, children }) => {
    const target = href ?? '#'
    const linkClasses =
      'text-primary underline underline-offset-4 hover:text-primary/80 transition-colors'
    // External URLs and in-page anchors bypass locale routing — only
    // internal pathnames (`/...`) should get the locale prefix.
    if (!target.startsWith('/')) {
      return (
        <a href={target} className={linkClasses}>
          {children}
        </a>
      )
    }
    return (
      <Link href={target} className={linkClasses}>
        {children}
      </Link>
    )
  },
  ul: ({ children }) => <ul className="my-4 ml-6 list-disc [&>li]:mt-2">{children}</ul>,
  ol: ({ children }) => <ol className="my-4 ml-6 list-decimal [&>li]:mt-2">{children}</ol>,
  li: ({ children }) => <li className="leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mt-6 border-l-4 border-primary/50 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  img: ({ src, alt }) => (
    <Image
      src={src ?? ''}
      alt={alt ?? ''}
      width={1200}
      height={630}
      unoptimized={src?.toLowerCase().endsWith('.gif')}
      className="my-6 h-auto w-full rounded-lg border border-lv2-line"
    />
  ),
  HeroImage: ({ src, alt }: { src: string; alt?: string }) => (
    // ThemedImage auto-swaps to the `-dark` variant of the same path
    // (e.g. cover.png -> cover-dark.png) when the dark theme is active.
    // Falls back to the light image in both modes if the dark file is
    // missing, so legacy guides without a -dark variant still render.
    <ThemedImage
      src={src}
      alt={alt ?? ''}
      width={1200}
      height={630}
      className="w-full h-auto rounded-lg mb-8"
      priority
    />
  ),
  pre: PreComponent,
  code: InlineCode,
  table: ({ children }) => (
    <div className="my-6 w-full overflow-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-white/10 px-4 py-2 text-left font-semibold bg-muted/50">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-white/10 px-4 py-2">{children}</td>,
  hr: () => <hr className="my-8 border-white/10" />,
  // Custom components available in MDX
  AnswerBox,
  Callout,
  DuetCTA,
  GuideTOC,
  LinkedInPostPreview,
  ProductLink,
  ResourcesCTA,
  Video,
  YouTubeEmbed,
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Alert,
  AlertTitle,
  AlertDescription,
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...mdxComponents,
    ...components,
  }
}
