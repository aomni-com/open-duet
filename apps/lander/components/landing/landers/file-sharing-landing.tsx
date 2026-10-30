import { HeroVideo } from '@/components/landing/hero-video'
import { InkMark } from '@/components/landing/ink-mark'
import {
  AccessControlSection,
  ProblemSection,
  ShareCascadeSection,
  ValuePropsSection,
} from '@/components/landing/landers/file-sharing-sections'
import { FinalCta, FundraiseChip, LanderHero } from '@/components/landing/landers/hero-and-close'
import { FaqsSection } from '@/components/landing/landers/sections'
import { TrainSection } from '@/components/landing/landers/train-section'
import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { LandingNavFrost } from '@/components/landing/landing-nav-frost'
import { TrustedBy } from '@/components/landing/trusted-by'

const FILE_SHARING_FAQS = [
  {
    q: 'How is this different from Dropbox or Google Drive?',
    a: 'It looks and works the same for people: folders, files, drag and drop, a share button. The difference is that your AI agents are first-class citizens of it too. When you share a folder, the people you shared with can open it and so can their agents, under the same rules. Dropbox shares files to eyes; this shares them to eyes and machines alike.',
  },
  {
    q: 'What does it mean that agents can \u201cuse\u201d the files?',
    a: 'Your agents don\u2019t work off a stale copy. They read and write the real files in the shared folder, with every change signed and versioned. A research agent can drop findings into the folder, a spreadsheet agent can add a row, and the version everyone else sees updates in real time.',
  },
  {
    q: 'How do permissions work for agents?',
    a: 'An agent inherits the exact access of the person who runs it. Grant a teammate edit access and their agent can edit; move them to view-only and their agent goes read-only; revoke access and both lose it in the same instant. There is nothing extra to configure per agent.',
  },
  {
    q: 'Which agents can read and write the files?',
    a: 'Any of them. Claude, Codex, Duet\u2019s own agents, or your own scripts. If it can read and write files, it can work in a shared folder. There is no proprietary framework and no per-agent integration to build.',
  },
  {
    q: 'Can I move our existing files over?',
    a: 'Yes. Import from Google Drive or Dropbox and keep your folder structure. Your team keeps working the way they already do, and their agents gain access to the same files on day one.',
  },
  {
    q: 'Is my data private?',
    a: 'Every workspace runs in your own dedicated environment. Your files are not pooled with other customers, and you control exactly which people and which agents can reach each folder, with every access logged.',
  },
] as const

/** The file-sharing lander (`/l/file-sharing`): sharing works like file
 * sharing because it is file sharing, and the agents are on the invite. Its
 * title and description live with the rest of the `/l/` lineup in
 * `campaign-spec.ts`. */
export function FileSharingLanding() {
  return (
    <LandingChrome noAmbient>
      {/* Sticky nav at the page level — transparent over the hero, gains a
          frosted-glass background on scroll. The hero wrapper below pulls
          itself up under the nav with -mt-20 so the hero video bleeds
          behind, mirroring the agent-drive lander. */}
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
      <AccessControlSection />
      <ShareCascadeSection />
      <TrustedBy />
      <FaqsSection items={FILE_SHARING_FAQS} />
      <FinalCta
        eyebrow="File sharing built for people and their agents"
        title={
          <>
            Share a folder. <InkMark>Everyone, and every agent, is in.</InkMark>
          </>
        }
        sub={
          <>
            Move your team&rsquo;s files onto a drive that shares to people and their agents alike,
            under one set of rules.
          </>
        }
        kicker="Dropbox shares files to people. Duet shares them to their agents too."
        bullets={['15-minute call', 'No credit card', 'Import from Drive']}
      />
      <LandingFooter />
    </LandingChrome>
  )
}

function Hero() {
  return (
    <LanderHero
      chip={<FundraiseChip>to make file sharing work for agents too</FundraiseChip>}
      headline={
        <>
          Share a folder. Your whole team,{' '}
          <span className="lv2-hero-ink-soft italic">and their agents</span>, get it.
        </>
      }
      sub="It looks and feels like Dropbox or Drive, but the files you share are readable and writable by every agent too, under the same permissions. Share once, and every person and every agent you shared with gets the same files, instantly."
    />
  )
}
