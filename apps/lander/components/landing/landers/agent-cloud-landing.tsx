import { HeroVideo } from '@/components/landing/hero-video'
import { InkMark } from '@/components/landing/ink-mark'
import {
  ProblemSection,
  ValuePropsSection,
  WakeUpSection,
} from '@/components/landing/landers/agent-cloud-sections'
import { FinalCta, FundraiseChip, LanderHero } from '@/components/landing/landers/hero-and-close'
import { FaqsSection } from '@/components/landing/landers/sections'
import { TrainSection } from '@/components/landing/landers/train-section'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'
import { TrustedBy } from '@/components/landing/trusted-by'

/** The questions the heavy-usage power user asks first. */
const AGENT_CLOUD_FAQS = [
  {
    q: 'I already pay for Claude Max and a Codex plan. Why add this?',
    a: 'That is exactly who this is built for. You are getting outsized value from frontier models and hitting the same wall: they are amnesiac. Duet is the layer underneath that keeps their memory, files, and runtime, so the money you already spend goes further every session instead of re-paying to re-establish context.',
  },
  {
    q: 'How is this different from Dropbox or a vector database?',
    a: 'Dropbox stores files and waits. A vector store is one piece of memory with no place to work. Duet is the whole home: persistent memory next to your files, in a workspace your agents can actually run in and build on. Storage is the substrate; the work layer is the product.',
  },
  {
    q: 'Which agents can use it?',
    a: 'Any of them. Claude, Codex, your own scripts, whatever you run today. If it can read and write files, it has a home on Duet. There is no proprietary framework to adopt and no per-agent integration to build.',
  },
  {
    q: "What does 'a place to run' mean?",
    a: 'Long jobs keep running after you close the tab. Schedule an overnight digest, kick off a build, or leave an agent working through a backlog. It runs in the cloud with its memory attached and picks back up on the next wake.',
  },
  {
    q: 'Is my data private?',
    a: 'Every workspace runs in its own dedicated environment with its own memory and files. Your data is never pooled with other customers, and you control which agents and people can reach each folder.',
  },
  {
    q: 'How fast can I start?',
    a: 'One line to connect an agent. Point it at your workspace and it reads and writes memory and files from that moment on. Free to start, no credit card, works with the agents you already run.',
  },
] as const

/** The problem-first "agent cloud" lander (`/l/agent-cloud`): the frontier
 * models are brilliant but amnesiac, and Duet is the cloud that gives them
 * the memory, files, and runtime to compound. Its title and description live
 * with the rest of the `/l/` lineup in `campaign-spec.ts`. */
export function AgentCloudLanding() {
  return (
    <LandingChrome noAmbient>
      <LandingNavFrost>
        <LandingNav homeHref="/" />
      </LandingNavFrost>
      <div className="relative -mt-20 h-[100svh] overflow-hidden min-[950px]:h-[calc(100vh_+_5rem)]">
        <HeroVideo />
        <Hero />
      </div>
      <ProblemSection />
      <ValuePropsSection />
      <TrainSection
        band="bg-lv2-band-cool"
        eyebrow="Make it yours"
        title={
          <>
            Everyone gets the same AI.{' '}
            <span className="lv2-hero-ink-soft italic">You train yours.</span>
          </>
        }
        intro="Point it at how you actually work, and it stops answering like a stranger."
      />
      <WakeUpSection />
      <TrustedBy />
      <FaqsSection items={AGENT_CLOUD_FAQS} title="Questions power users ask first." />
      <FinalCta
        eyebrow="A home in the cloud for every agent you run"
        title={
          <>
            Stop paying twice for the <InkMark>same context.</InkMark>
          </>
        }
        sub="Give your agents memory, files, and a place to run. Their work starts compounding from the very next session."
        kicker="Your models are already brilliant. Give them a memory."
      />
      <LandingFooter />
    </LandingChrome>
  )
}

function Hero() {
  return (
    <LanderHero
      chip={<FundraiseChip>to give your agents a memory</FundraiseChip>}
      headline={
        <>
          Your agents are brilliant.{' '}
          <span className="lv2-hero-ink-soft italic">And they forget everything.</span>
        </>
      }
      sub="Duet is the cloud that gives your agents a memory. Their context, files, and running jobs persist between sessions, so their work compounds instead of resetting to zero."
    />
  )
}
