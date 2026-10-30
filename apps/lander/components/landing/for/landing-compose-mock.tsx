import { type Icon as PhosphorIcon } from '@phosphor-icons/react'
import {
  BrainIcon,
  CaretDownIcon,
  CheckIcon,
  CurrencyDollarIcon,
  LightningIcon,
} from '@phosphor-icons/react/dist/ssr'
import Image from 'next/image'

import { cn } from '@repo/ui/lib/utils'

import { PrimaryCta } from '@/components/landing/landing-cta'

type Props = {
  /** Pre-filled text shown inside the compose bar as if the user typed
   * it. If absent, the placeholder ("Tell me what to build") shows
   * instead. Used on /for/<vertical> pages to surface the kickoff
   * prompt inside a product-realistic UI mock. */
  value?: string
  /** Href the "Try this prompt now" CTA in the footer points to. */
  signupHref: string
  className?: string
}

type ModelOption = {
  name: string
  description: string
  /** Inline-color hex for the provider dot — kept literal so it
   * survives the .landing-v2 white-token remap. */
  dotColor: string
  /** Single-letter badge shown in the closed pill when this is the
   * active model. */
  badge: string
}

// Mirrors the model lineup shown in the real product. Keep
// "Balanced" first; it's the default auto-routing preset.
const MODELS: readonly ModelOption[] = [
  {
    name: 'Balanced',
    description: 'Auto-routes to the best model for each task',
    dotColor: 'linear-gradient(135deg,#3b82f6,#8b5cf6)',
    badge: 'A',
  },
  {
    name: 'Claude Sonnet 4.6',
    description: 'Reasoning, code, long context',
    dotColor: '#CC785C',
    badge: 'C',
  },
  {
    name: 'GPT-5',
    description: 'Strong all-rounder, writing and code',
    dotColor: '#10A37F',
    badge: 'G',
  },
  {
    name: 'Gemini 2.5 Pro',
    description: 'Long context, document analysis',
    dotColor: '#4285F4',
    badge: 'G',
  },
  {
    name: 'Grok 4',
    description: 'Realtime web search, fast',
    dotColor: '#0F0F0F',
    badge: 'G',
  },
]

/**
 * Static, non-interactive (except the model dropdown) visual mock of
 * the in-product compose bar. Lives on the marketing /for/<vertical>
 * landers so the "Day one" section reads like a screenshot of the real
 * product.
 *
 * The model selector uses a native <details>/<summary> so the dropdown
 * works without any client-side JavaScript.
 */
export function LandingComposeMock({ value, signupHref, className }: Props) {
  const active = MODELS[0]!
  return (
    <div className={cn('relative mx-auto w-full max-w-2xl', className)}>
      {/* Compose card. No overflow-hidden on the outer surface so the
          model dropdown can extend below the card without being
          clipped; the dial strip rounds its own top corners via
          `rounded-t-2xl` to keep the gradient flush. */}
      <div className="relative z-10 rounded-2xl border border-foreground/10 bg-background shadow-[0_24px_64px_-24px_rgba(0,0,0,0.25)]">
        {/* Top dial strip — model selector + capability dials. The
            blue/violet gradient mirrors the real product chrome.
            Colors use arbitrary-value white tokens (text-[#fff],
            bg-[rgb(255_255_255/0.2)]) because the global .landing-v2
            scope remaps `text-white` / `bg-white/*` to the foreground
            token, which would flip them dark in light mode. The dial
            strip needs to stay white-on-purple in both themes. */}
        <div className="relative flex items-center justify-between gap-3 rounded-t-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 px-4 py-2.5 text-[#fff]">
          {/* Model dropdown (native <details>). */}
          <details className="group relative">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <span className="opacity-80">Model:</span>
              <span className="inline-flex size-5 items-center justify-center rounded-md bg-[rgb(255_255_255/0.2)] text-[11px] font-bold">
                {active.badge}
              </span>
              <span>{active.name}</span>
              <CaretDownIcon
                weight="bold"
                className="size-3 opacity-70 transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="absolute left-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-foreground/10 bg-background p-1.5 text-foreground shadow-[0_24px_56px_-18px_rgba(0,0,0,0.35)]">
              {MODELS.map((m, i) => (
                <button
                  key={m.name}
                  type="button"
                  tabIndex={-1}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                    i === 0 ? 'bg-foreground/[0.04]' : 'hover:bg-foreground/[0.04]',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="mt-1 inline-block size-2.5 shrink-0 rounded-full ring-1 ring-foreground/10"
                    style={{ background: m.dotColor }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold leading-tight">{m.name}</span>
                      {i === 0 && (
                        <CheckIcon
                          weight="bold"
                          aria-hidden="true"
                          className="size-3.5 text-foreground/60"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs leading-snug text-foreground/55">
                      {m.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </details>

          {/* Capability dials — fixed-state visualization mirroring the
              real selector's speed / intelligence / cost meters. */}
          <div className="hidden items-center gap-4 sm:flex">
            <Dial Icon={LightningIcon} filled={4} total={5} />
            <Dial Icon={BrainIcon} filled={4} total={5} />
            <Dial Icon={CurrencyDollarIcon} filled={3} total={5} />
          </div>
        </div>

        {/* Input area. Renders either the pre-filled value or a muted
            placeholder so the card stays useful even with no copy. */}
        <div className="min-h-[110px] px-5 pt-5 pb-3 text-left">
          {value ? (
            <p className="text-base leading-relaxed text-foreground/85">{value}</p>
          ) : (
            <p className="text-base text-foreground/40">Tell me what to build</p>
          )}
        </div>

        {/* Footer — only carries the "Try this prompt now" CTA at the
            right. The puzzle / paperclip / waveform / channel pill /
            send button from the real bar are irrelevant on a landing
            and would distract from the action. Padding + text are
            tightened past the default `size="sm"` so the pill fits
            inside the footer height instead of dominating it. */}
        <div className="flex items-center justify-end px-3 pb-3">
          <PrimaryCta
            href={signupHref}
            size="sm"
            magnetic={false}
            className="px-3.5 py-1.5 text-xs"
          >
            Try this prompt now
          </PrimaryCta>
        </div>
      </div>

      {/* Peeking blue mascot to the right of the compose card. Hidden
          on small screens where it'd overlap the card. Source is
          196x218; rendered close to native size and pinned vertically
          to the card's middle. */}
      <Image
        src="/landing/for/day-one-mascot.png"
        alt=""
        aria-hidden="true"
        width={196}
        height={218}
        priority={false}
        className="pointer-events-none absolute -right-28 top-1/2 hidden h-auto w-40 -translate-y-1/2 select-none lg:block xl:-right-36 xl:w-48"
      />
    </div>
  )
}

function Dial({ Icon, filled, total }: { Icon: PhosphorIcon; filled: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon weight="bold" className="size-3.5" />
      <div className="flex gap-1">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'size-1.5 rounded-full ring-1 ring-inset',
              // Arbitrary white values to bypass the .landing-v2
              // text-white/bg-white-alpha remap (see dial-strip comment
              // above). Filled: solid white. Unfilled: low-alpha white.
              i < filled
                ? 'bg-[#fff] ring-[rgb(255_255_255/0.6)]'
                : 'bg-[rgb(255_255_255/0.3)] ring-[rgb(255_255_255/0.5)]',
            )}
          />
        ))}
      </div>
    </div>
  )
}
