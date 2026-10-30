import { motion, useReducedMotion } from 'framer-motion'
import { useTranslations } from 'next-intl'

/**
 * What an empty chat has to say for itself: the mascot you hired, a
 * tracked-out "day one" label, and the consequence in italic serif.
 *
 * It is the thread's content, not a hero: it lives inside the scroller the
 * messages will fill, so the first message replaces it in place and the
 * composer never moves. The copy is the same one V1 uses at the top of an
 * empty channel — a person arriving at a new chat should read the same line
 * in both products.
 */
export function SessionIntro() {
  const t = useTranslations('duetApp.sessionProduct')
  /* A greeting is worth an entrance, but only for a reader who asked for
     motion. Opacity is the part that matters here: a reduced-motion reader
     still gets a mid-fade mascot if we only drop the spring, and the visual
     gate — which crushes durations but not opacity — photographs whatever
     frame it lands on, so the shot never settles on the same picture twice. */
  const reduceMotion = useReducedMotion()
  return (
    <div className="flex flex-col items-center gap-4 px-4 text-center md:px-6">
      <motion.img
        initial={reduceMotion ? false : { scale: 0.85, opacity: 0, y: 6 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={
          reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 200, damping: 14 }
        }
        src="/icons/duet-welcoming.png"
        width={88}
        height={88}
        alt=""
        draggable={false}
        // The tokens here are raw oklch channels, not HSL: an `hsl(var(--…))`
        // shadow copied from V1 parses to nothing and the mascot floats.
        className="select-none drop-shadow-[0_8px_18px_oklch(var(--foreground)/0.18)]"
      />
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          reduceMotion ? { duration: 0 } : { duration: 0.4, delay: 0.18, ease: [0.16, 1, 0.3, 1] }
        }
        className="flex flex-col items-center gap-1.5"
      >
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
          {t('dayOne')}
        </span>
        <span className="max-w-xs text-[15px] font-medium leading-snug text-foreground">
          <em className="font-serif italic text-brand">{t('letsGetToWork')}</em>
        </span>
      </motion.div>
    </div>
  )
}
