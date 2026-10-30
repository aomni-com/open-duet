'use client'

import { CountUp, Eyebrow, LiveDot } from '@/components/landing/atoms'
import { InkMark } from '@/components/landing/ink-mark'
import { SectionHeader } from '@/components/landing/landers/section-primitives'
import { serifStyle } from '@/components/landing/landing-styles'
import { TrustedBy } from '@/components/landing/trusted-by'

function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-foreground/10 bg-background/40 p-6">
      <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground/45">
        {label}
      </p>
      {children}
    </div>
  )
}

/** One page of the small shared atoms so the design grammar is reviewable in
 * a single shot: eyebrow, live dot, count-up, ink-marked headline, section
 * header, trust band. */
export function AtomsPlayground() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-16">
      <Specimen label="Eyebrow">
        <Eyebrow>The problem</Eyebrow>
      </Specimen>
      <Specimen label="LiveDot">
        <p className="flex items-center gap-3 text-sm text-foreground/80">
          <LiveDot /> An agent that is actually running
        </p>
      </Specimen>
      <Specimen label="CountUp">
        <p className="text-4xl font-semibold tabular-nums" style={serifStyle}>
          <CountUp to={4200} />
        </p>
      </Specimen>
      <Specimen label="InkMark">
        <h2 className="text-3xl font-semibold" style={serifStyle}>
          Give your agents <InkMark>one place to work.</InkMark>
        </h2>
      </Specimen>
      <Specimen label="SectionHeader">
        <SectionHeader
          eyebrow="What the workspace does"
          title="Not storage. A place where work compounds."
          intro="Shared memory next to your files, pipelines that keep data fresh, and hosting for whatever your agents build."
        />
      </Specimen>
      <Specimen label="TrustedBy">
        <TrustedBy />
      </Specimen>
    </div>
  )
}
