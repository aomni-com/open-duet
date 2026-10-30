import { type ButtonHTMLAttributes, type ComponentProps, forwardRef, type ReactNode } from 'react'

import { cn } from '@repo/ui/lib/utils'

import { MagneticButton } from '@/components/landing/magnetic-button'
import { Link } from '@/i18n/navigation'

type Size = 'sm' | 'md' | 'lg'

const PRIMARY_SIZE_CLASSES: Record<Size, string> = {
  sm: 'gap-2 px-5 py-2.5 text-sm',
  md: 'gap-2.5 px-10 py-4 text-[15px]',
  lg: 'gap-3 px-12 py-5 text-base',
}

const SECONDARY_SIZE_CLASSES: Record<Size, string> = {
  sm: 'gap-2 px-4 py-2 text-sm',
  md: 'gap-2 px-7 py-3.5 text-[15px]',
  lg: 'gap-2.5 px-9 py-[18px] text-base',
}

/**
 * Shared class string for the brand-blue pill — the "Start free" button in
 * the nav, used as the primary CTA across the marketing surface. Exposed so
 * non-Link consumers (form submits, magnetic wrappers, etc.) can pin the
 * same visual treatment without duplicating shadow/ring strings.
 *
 * `no-underline` overrides the Tailwind Typography `.prose a { underline }`
 * rule when these CTAs render inside an MDX article body. `text-[hsl(0_0%_100%)]`
 * sidesteps the legacy `text-white` remap in `landing-styles.css` so the
 * pill stays white-on-blue in both themes.
 */
export function primaryCtaClassName(size: Size = 'lg', className?: string): string {
  return cn(
    'group lv2-shine inline-flex items-center justify-center rounded-full no-underline',
    'font-medium text-[hsl(0_0%_100%)]',
    // Light: confident brand blue. Dark: lifted to ~62% lightness so the
    // pill glows against the night canvas; same hue family, no new brand
    // color. Hover deepens on light, brightens further on dark.
    'bg-[hsl(214_65%_50%)] dark:bg-[hsl(214_75%_62%)]',
    'shadow-[0_0_0_1px_hsl(218_75%_38%/0.55)_inset,0_1px_0_hsl(210_100%_94%/0.45)_inset,0_14px_32px_-10px_hsl(214_65%_50%/0.55),0_2px_4px_hsl(218_50%_28%/0.18)]',
    'dark:shadow-[0_0_0_1px_hsl(214_55%_45%)_inset,0_1px_0_hsl(210_100%_94%/0.35)_inset,0_18px_44px_-8px_hsl(214_85%_65%/0.7),0_8px_18px_hsl(216_70%_2%/0.65)]',
    'transition-[transform,box-shadow,background-color] duration-200 ease-out',
    'hover:-translate-y-0.5 hover:bg-[hsl(214_70%_44%)] dark:hover:bg-[hsl(214_82%_68%)]',
    'hover:shadow-[0_0_0_1px_hsl(218_75%_38%/0.6)_inset,0_1px_0_hsl(210_100%_94%/0.55)_inset,0_22px_44px_-10px_hsl(214_65%_50%/0.7),0_4px_10px_hsl(218_50%_28%/0.22)]',
    'dark:hover:shadow-[0_0_0_1px_hsl(214_55%_50%)_inset,0_1px_0_hsl(210_100%_94%/0.45)_inset,0_28px_60px_-8px_hsl(214_85%_70%/0.8),0_10px_22px_hsl(216_70%_2%/0.7)]',
    'active:translate-y-0 active:brightness-95',
    'disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0',
    'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[hsl(214_75%_70%)] dark:focus-visible:outline-[hsl(214_90%_80%)]',
    'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
    PRIMARY_SIZE_CLASSES[size],
    className,
  )
}

/**
 * Shared class string for the porcelain pill — the "Pricing / Guides / Blog"
 * style in the nav, used as the secondary CTA. Stays white-surface with
 * deep navy text in both themes (matching `.lv2-nav-chip`), so it reads
 * as a consistent branded element no matter what sits underneath.
 */
export function secondaryCtaClassName(size: Size = 'lg', className?: string): string {
  return cn(
    'group inline-flex items-center justify-center rounded-full font-medium no-underline',
    // Light: porcelain pill with deep navy text. Dark: inverted to a
    // dark glass pill with cream text so it reads as a proper dark-mode
    // secondary instead of a stark white disc against the night canvas.
    // (Deliberately diverges from `.lv2-nav-chip`, which stays porcelain
    // in both modes because the nav chip is a branded constant.)
    'bg-[hsl(210_30%_99%)] text-[hsl(218_30%_26%)]',
    'border border-[hsl(218_42%_14%/0.08)]',
    'shadow-[0_2px_8px_-2px_hsl(218_50%_28%/0.18)]',
    'dark:bg-[hsl(216_28%_16%/0.7)] dark:text-[hsl(40_28%_94%)]',
    'dark:border-[hsl(40_28%_94%/0.12)]',
    'dark:backdrop-blur-md dark:backdrop-saturate-[1.2]',
    'dark:shadow-[0_2px_14px_-2px_hsl(216_70%_2%/0.6),0_0_0_1px_hsl(40_28%_94%/0.06)_inset]',
    'transition-[background-color,border-color,box-shadow,color,transform] duration-200 ease-out',
    'hover:-translate-y-0.5 hover:bg-[hsl(214_30%_93%)] hover:text-[hsl(218_42%_14%)] hover:border-[hsl(218_42%_14%/0.14)]',
    'hover:shadow-[0_4px_14px_-2px_hsl(218_50%_28%/0.22)]',
    'dark:hover:bg-[hsl(216_28%_22%/0.8)] dark:hover:text-[hsl(40_28%_98%)]',
    'dark:hover:border-[hsl(40_28%_94%/0.2)]',
    'dark:hover:shadow-[0_6px_20px_-2px_hsl(216_70%_2%/0.7),0_0_0_1px_hsl(40_28%_94%/0.1)_inset]',
    'active:translate-y-0',
    'disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0',
    'focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[hsl(214_75%_70%)] dark:focus-visible:outline-[hsl(214_90%_80%)]',
    'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
    SECONDARY_SIZE_CLASSES[size],
    className,
  )
}

type PrimaryCtaProps = Omit<ComponentProps<typeof Link>, 'children'> & {
  children: ReactNode
  /** Render a pulsing halo behind the button. Use on the hero + final CTA. */
  halo?: boolean
  /** Disable the magnetic-cursor wrapper. Use in dense areas like the nav. */
  magnetic?: boolean
  size?: Size
}

/**
 * Landing primary CTA — the brand-blue pill used as "Start free" in the
 * nav and as the primary action on every marketing surface. Wraps a
 * `<Link>`; for `<button>` use cases (form submits, click handlers) use
 * `PrimaryButton`.
 *
 * An `/api/` target is never prefetched: the campaign landers point this at
 * a signup action, a GET that mints attribution and starts a journey, so a
 * router prefetch would fire the conversion for a visitor who never clicked
 * — and, when Convex is unreachable, log a 502 for a request nobody made.
 * Deciding it from the href means no lander has to remember a prop.
 */
export function PrimaryCta({
  children,
  className,
  halo = false,
  magnetic = true,
  size = 'lg',
  ...linkProps
}: PrimaryCtaProps) {
  const buttonClasses = primaryCtaClassName(size, className)
  const mintsOnGet = typeof linkProps.href === 'string' && linkProps.href.startsWith('/api/')
  const props = mintsOnGet ? { ...linkProps, prefetch: false as const } : linkProps
  const button = magnetic ? (
    <MagneticButton {...props} className={buttonClasses}>
      {children}
    </MagneticButton>
  ) : (
    <Link {...props} className={buttonClasses}>
      {children}
    </Link>
  )

  if (!halo) return button

  return (
    <div className="relative inline-flex">
      <span
        aria-hidden="true"
        className="lv2-halo-pulse pointer-events-none absolute inset-0 -z-10 rounded-full bg-[radial-gradient(ellipse_at_center,hsl(214_75%_60%/0.55),transparent_65%)] blur-2xl dark:bg-[radial-gradient(ellipse_at_center,hsl(214_85%_72%/0.55),transparent_65%)]"
      />
      {button}
    </div>
  )
}

type PrimaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: Size
}

/**
 * `<button>` variant of `PrimaryCta`. Same brand-blue pill, but for form
 * submits or click handlers (e.g., the newsletter subscribe button).
 */
export const PrimaryButton = forwardRef<HTMLButtonElement, PrimaryButtonProps>(
  function PrimaryButton({ children, className, size = 'lg', type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} className={primaryCtaClassName(size, className)} {...rest}>
        {children}
      </button>
    )
  },
)

type SecondaryCtaProps = Omit<ComponentProps<typeof Link>, 'children'> & {
  children: ReactNode
  size?: Size
}

/**
 * Landing secondary CTA — porcelain pill matching the nav chips
 * ("Pricing / Guides / Blog"). Wraps a `<Link>`; for `<button>` use
 * cases use `SecondaryButton`.
 */
export function SecondaryCta({
  children,
  className,
  size = 'lg',
  ...linkProps
}: SecondaryCtaProps) {
  return (
    <Link {...linkProps} className={secondaryCtaClassName(size, className)}>
      {children}
    </Link>
  )
}

type SecondaryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: Size
}

/**
 * `<button>` variant of `SecondaryCta`. Same porcelain pill, for click
 * handlers (e.g., the "Contents" sheet trigger on guide pages).
 */
export const SecondaryButton = forwardRef<HTMLButtonElement, SecondaryButtonProps>(
  function SecondaryButton({ children, className, size = 'lg', type = 'button', ...rest }, ref) {
    return (
      <button ref={ref} type={type} className={secondaryCtaClassName(size, className)} {...rest}>
        {children}
      </button>
    )
  },
)
