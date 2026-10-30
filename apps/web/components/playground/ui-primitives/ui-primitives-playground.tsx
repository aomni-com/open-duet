'use client'

import type { ReactNode } from 'react'

import { AnimationsDemos } from './animations-demos'
import { ButtonDemos } from './button-demos'
import { CardsDemos } from './cards-demos'
import { ContentDisplayDemos } from './content-display-demos'
import { DialogsDemos } from './dialogs-demos'
import { FormControlsDemos } from './form-controls-demos'
import { LayoutDemos } from './layout-demos'
import { UtilityDemos } from './utility-demos'

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="space-y-6 border-b border-border/50 pb-12 last:border-b-0">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/**
 * Hermetic showcase of the project's UI primitives — buttons, layout,
 * cards, form controls, content displays, animations, dialogs, and
 * miscellaneous utilities. Each section renders the same demo components
 * the original `/debug/ui` route used; no SPA chrome (header, navigation,
 * scroll-area shell) is wrapped around them so the playground can frame
 * the surface itself.
 *
 * Animations: every demo here either animates once on mount (framer-motion
 * `initial`/`animate`) or relies on CSS keyframes. The playground shell
 * forces `animation-duration` and `transition-duration` to ~0ms via
 * `[data-playground-shell]`, so loops settle on their final frame before
 * screenshots are taken. The interactive triggers (confetti, image modal,
 * confirm dialogs) all start closed and require user input, so the default
 * captured state is stable.
 */
export function UiPrimitivesPlayground() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-6 py-10">
      <Section id="buttons" title="Buttons">
        <ButtonDemos />
      </Section>
      <Section id="layout" title="Layout & Containers">
        <LayoutDemos />
      </Section>
      <Section id="cards" title="Cards & State">
        <CardsDemos />
      </Section>
      <Section id="forms" title="Form Controls">
        <FormControlsDemos />
      </Section>
      <Section id="content" title="Content Display">
        <ContentDisplayDemos />
      </Section>
      <Section id="animations" title="Animations">
        <AnimationsDemos />
      </Section>
      <Section id="dialogs" title="Dialogs & Modals">
        <DialogsDemos />
      </Section>
      <Section id="utilities" title="Utilities">
        <UtilityDemos />
      </Section>
    </div>
  )
}
