import { type Icon } from '@phosphor-icons/react'
import {
  CalendarCheckIcon,
  CameraIcon,
  ClipboardTextIcon,
  ClockCountdownIcon,
  CloudLightningIcon,
  HeartIcon,
  ImagesSquareIcon,
  LightningIcon,
  PawPrintIcon,
  PillIcon,
  ShieldCheckIcon,
  SparkleIcon,
  StarIcon,
} from '@phosphor-icons/react/dist/ssr'

/**
 * Single source of truth for the /for/<vertical> landing pages.
 *
 * Adding a new vertical = appending one config object here. The
 * [vertical]/page.tsx template, the /for hub, and the sitemap scan
 * all pick it up automatically.
 *
 * Copy rules so the pages don't read like AI slop:
 * - Outcome titles are concrete jobs ("Storm-chase canvass list"),
 *   not vague benefits.
 * - Outcome descriptions are one line, present tense, name the
 *   tool/channel/integration the work happens on.
 * - The kickoff prompt is something an actual owner would type into
 *   Duet on day one, not a marketing line.
 * - FAQs answer real objections (pricing, integrations, what happens
 *   if the agent screws up), not "what is AI?".
 * - Avoid emdashes. Use periods, commas, or restructure the sentence.
 */

export type VerticalOutcome = {
  title: string
  body: string
  Icon: Icon
}

export type VerticalFaq = {
  q: string
  /** Plain text. Renders as a <p> on the page and as FAQPage JSON-LD,
   * so no markdown links. */
  a: string
}

export type VerticalAccent = {
  /** Tailwind class. Used as the hero glow tint. */
  glow: string
  /** Tailwind class. Used as the eyebrow text color in the hero. */
  eyebrow: string
  /** Tailwind class. Used as the kickoff-prompt accent border/bg. */
  card: string
}

export type VerticalSpec = {
  /** URL slug under /for/. Keep stable; this is the public URL. */
  slug: string
  /** Plural display name ("Roofers"). */
  audience: string
  /** Short eyebrow above the H1 ("For roofing contractors"). */
  eyebrow: string
  /** First half of the H1. */
  heroLead: string
  /** Highlighted half of the H1 (rendered in serif italic). */
  heroHighlight: string
  /** 1-2 sentence subhead under the H1. */
  heroSubhead: string
  /** Accent treatment for the hero. */
  accent: VerticalAccent
  /** Optional hero scene image rendered in a rounded card on the
   * right of the hero. `aspect` controls the card's aspect ratio
   * (Tailwind class) so each vertical can match its source image's
   * native ratio without cropping the subject. Defaults to a wide
   * `aspect-[16/10]` if not provided. */
  heroImage?: { src: string; alt: string; aspect?: string }
  /** 3-6 outcome cards. */
  outcomes: VerticalOutcome[]
  /** Sample message a real owner in this vertical would send Duet on
   * day one. Rendered inside a fake chat bubble. */
  kickoffPrompt: string
  /** 5-7 FAQ items, used both on-page and in FAQPage JSON-LD. */
  faqs: VerticalFaq[]
  /** <= 60 chars; "AI for X: Benefit, Benefit | Duet". */
  metaTitle: string
  /** 140-160 chars. */
  metaDescription: string
  /** ISO date (YYYY-MM-DD). Surfaces in the sitemap as <lastmod>. */
  lastUpdated: string
}

export const VERTICALS: readonly VerticalSpec[] = [
  {
    slug: 'roofers',
    audience: 'Roofers',
    eyebrow: 'For roofing contractors',
    heroLead: 'Run the roof business while you',
    heroHighlight: 'run the jobs.',
    heroSubhead:
      'Duet is an AI coworker for roofing contractors. It works storm leads, replies to Angi Leads the second they drop, drafts insurance supplements that recover Xactimate underpays, chases recoverable depreciation, and keeps your Google profile humming. You stay at the supply house and on jobs, not at the desk past 10 p.m.',
    accent: {
      glow: 'from-orange-500/30 via-amber-500/20 to-transparent',
      eyebrow: 'text-orange-500 dark:text-orange-300',
      card: 'border-orange-500/30 bg-orange-500/5',
    },
    heroImage: {
      src: '/landing/for/roofers-hero.webp',
      alt: 'Duet mascots on a sunny flower meadow. A yellow mascot in a hard hat lays bricks on a ladder, a blue mascot on a wooden chair works at a laptop with a roofing dashboard.',
      aspect: 'aspect-[16/10]',
    },
    outcomes: [
      {
        title: 'Angi Leads + Networx speed-to-lead',
        body: "Replies to Angi Leads, Networx, and Thumbtack inquiries in under 60 seconds with a real, personalized message. With Angi's homeowner-choice model now live, the contractor who replies first wins the consult, not the one in rotation.",
        Icon: LightningIcon,
      },
      {
        title: 'Storm-chase canvass list',
        body: 'Pulls verified hail and wind swaths from HailTrace, Interactive Hail Maps, and NOAA storm reports. Ranks neighborhoods in your service area by damage freshness and carrier mix, and drops the canvass list before your competition leaves the parking lot.',
        Icon: CloudLightningIcon,
      },
      {
        title: 'Insurance supplement + depreciation chaser',
        body: 'Reads the adjuster scope, flags every commonly-omitted line against Xactimate (starter course, ridge cap, step flashing, code upgrades, R&R decking), drafts the supplement letter, and tracks recoverable depreciation until the final check clears.',
        Icon: ShieldCheckIcon,
      },
      {
        title: 'Final-check + balance-due collections',
        body: 'Chases recoverable depreciation releases from the carrier and balance-due reminders from the homeowner until the money lands. The cash-flow killer most owner-operators do themselves at midnight.',
        Icon: ClockCountdownIcon,
      },
      {
        title: 'Google review monitor + auto-reply',
        body: "Catches every new Google review within minutes and drafts a reply that sounds like you wrote it. Reviews drive roughly 20% of your map-pack ranking, so missing them costs you the bread-and-butter 'roofer near me' calls.",
        Icon: StarIcon,
      },
      {
        title: 'CompanyCam to IG and Facebook',
        body: 'Pulls the cleanest paired shots from CompanyCam or your phone, writes a caption with the neighborhood and roof system, and queues it for Instagram and Facebook so your marketing keeps moving on jobsite days.',
        Icon: ImagesSquareIcon,
      },
    ],
    kickoffPrompt:
      'Every morning at 6:30, pull HailTrace and NOAA storm reports for our service area, cross-reference our customer list, and text me the top 10 neighborhoods to canvass today. Include cross streets, age-of-roof guess, and the carriers most common on each block.',
    faqs: [
      {
        q: 'Does Duet replace my CRM (JobNimbus, AccuLynx, Roofr)?',
        a: 'No. Duet sits on top of your CRM and works inside it. It reads and writes jobs, contacts, and quotes through the CRM API. Your system of record stays the same. Your coworker just stops being you.',
      },
      {
        q: 'How does it handle storm tracking?',
        a: 'Duet pulls verified hail and wind swaths from HailTrace and Interactive Hail Maps, layers NOAA storm reports for additional ground truth, scopes them to your service area, and cross-references against your customer list. You see fresh neighborhoods before competitors hit the doors.',
      },
      {
        q: 'Will the Google review replies sound like a bot?',
        a: 'No. Duet learns your voice from prior replies and approved templates. The owner approves each reply with one tap before it posts, so nothing goes public without you signing off.',
      },
      {
        q: 'What does it cost compared to hiring an ops person?',
        a: 'A managed VA for these tasks runs $1,500 to $3,500 a month, more if you want someone US-based who can speak to insurance adjusters. Duet offers monthly plans with included credits and reserve overage, and the work happens 24/7 on a schedule instead of only during business hours.',
      },
      {
        q: 'How long until it pays for itself?',
        a: 'Most operators see payback in 30 to 60 days. One extra storm-job close recovered from faster Angi Leads or Networx response typically nets $8,000 to $18,000, which covers a year of Duet by itself.',
      },
      {
        q: 'Can I start with just one workflow?',
        a: 'Yes. Most owners start with either review auto-reply or the storm canvass list, then layer in supplement chasing and final-check collections once they trust the agent.',
      },
    ],
    metaTitle: 'AI for Roofers: Storm Leads, Reviews, Supplements | Duet',
    metaDescription:
      'Duet is an AI coworker for roofing contractors. Storm-chase canvassing, instant Angi Leads response, supplement letters, depreciation collections, and Google review replies on autopilot.',
    lastUpdated: '2026-05-27',
  },
  {
    slug: 'med-spas',
    audience: 'Med spas',
    eyebrow: 'For med spa owners',
    heroLead: 'The AI coworker for',
    heroHighlight: 'a fully booked med spa.',
    heroSubhead:
      "Duet is built for med spa owners who'd rather see patients than answer IG DMs at 11 p.m. It replies to leads in five minutes, fills cancelled slots from your waitlist, runs review requests after every visit, and keeps your membership and GLP-1 programs from leaking revenue.",
    accent: {
      glow: 'from-pink-500/30 via-fuchsia-500/20 to-transparent',
      eyebrow: 'text-pink-500 dark:text-pink-300',
      card: 'border-pink-500/30 bg-pink-500/5',
    },
    heroImage: {
      src: '/landing/for/med-spas-hero.webp',
      alt: 'Duet mascots posed as a med spa scene.',
      aspect: 'aspect-square',
    },
    outcomes: [
      {
        title: 'Lead response in 5 minutes',
        body: 'Replies to IG DMs, web form inquiries, and missed calls in your front-desk voice, qualifies the consult, and books it straight into Boulevard, Mangomint, or Aesthetic Record. The leads you used to lose between Friday evening and Monday morning.',
        Icon: LightningIcon,
      },
      {
        title: 'No-show + cancellation recovery',
        body: 'The second a slot opens, Duet texts your waitlist in priority order with a real conversational message. Fills most cancellations same-day from clients who already wanted in.',
        Icon: CalendarCheckIcon,
      },
      {
        title: 'GLP-1 program operations',
        body: 'Monthly check-in scheduling, dose-step reminders, refill prompts, and progress-photo requests for every patient on your weight-loss track. Built for the fastest-growing line on the P&L.',
        Icon: PillIcon,
      },
      {
        title: 'Review generation engine',
        body: 'After every visit, drafts a personalized Google review request that names the treatment and the provider. Layers in Yelp or RealSelf for the visits where it will actually convert. Practices typically see review volume 2 to 3x in the first 90 days.',
        Icon: StarIcon,
      },
      {
        title: 'Membership growth + retention',
        body: 'Spots clients who would save money on a membership and drafts the pitch in your front-desk voice. Flags members showing churn signals (skipped month, no rebook) before they cancel, so your front desk can save the relationship.',
        Icon: SparkleIcon,
      },
      {
        title: 'IG + TikTok content engine',
        body: 'A week of on-brand IG and TikTok content drafted from your treatment menu and current promos: captions, hashtags, hooks. You approve in one tap.',
        Icon: CameraIcon,
      },
    ],
    kickoffPrompt:
      'Pull every appointment that no-showed or cancelled in the last 30 days, prioritize by lifetime value and last treatment, and draft a one-touch rebook message for each one in our front-desk voice. Hold them in a draft channel for me to approve before sending.',
    faqs: [
      {
        q: 'Does Duet integrate with my booking system (Boulevard, Mangomint, Aesthetic Record, PatientNow, Vagaro)?',
        a: "Yes. Duet reads and writes appointments through your booking provider, either via the official API or, where there isn't one, via a structured email or form connector. The booking system stays the source of truth, and we don't claim to replace it.",
      },
      {
        q: 'How does it handle HIPAA?',
        a: "Duet operates under a Business Associate Agreement on the business plan. PHI stays inside HIPAA-eligible model endpoints, we don't train on it, and we don't ship it to consumer model APIs. Don't put PHI into any tool that hasn't signed a BAA.",
      },
      {
        q: 'Will the social content look generic?',
        a: 'No. Duet trains on your existing top-performing posts, your brand voice, and your treatment menu. You approve each post before it goes live, so nothing publishes without your eye on it.',
      },
      {
        q: 'How does it actually recover no-shows?',
        a: 'Duet watches your booking calendar for cancellations or no-shows, instantly drafts a personalized text to the next best client (waitlist, prior membership, recent inquiry), and waits for your one-tap approval. Most slots fill same-day.',
      },
      {
        q: 'Is this just another AI receptionist?',
        a: "No. AI receptionists answer the phone. Duet handles the higher-leverage marketing and operations work: lead response in IG DMs, retention, reviews, membership and GLP-1 program ops, and content. They're complementary, not competitive.",
      },
      {
        q: 'Can I trial it on just one workflow first?',
        a: 'Yes. Most med spas start with lead response or review generation, the two workflows with the fastest, most measurable lift.',
      },
    ],
    metaTitle: 'AI for Med Spas: Lead Response, Rebooking, Reviews | Duet',
    metaDescription:
      'Duet is an AI coworker for med spa owners. Five-minute lead response, no-show recovery, review generation, GLP-1 program ops, and membership retention on autopilot.',
    lastUpdated: '2026-05-27',
  },
  {
    slug: 'vet-practices',
    audience: 'Independent vet practices',
    eyebrow: 'For independent vet practices',
    heroLead: 'The AI coworker for the',
    heroHighlight: 'independent veterinary practice.',
    heroSubhead:
      'Duet is the operations teammate independent small-animal hospitals never had. It reactivates lapsed clients, recovers no-shows, surfaces wellness-plan candidates, nudges Rx refills, onboards new puppy and kitten families, and replies to reviews. Your front desk stops drowning and your DVMs focus on medicine.',
    accent: {
      glow: 'from-emerald-500/30 via-teal-500/20 to-transparent',
      eyebrow: 'text-emerald-500 dark:text-emerald-300',
      card: 'border-emerald-500/30 bg-emerald-500/5',
    },
    heroImage: {
      src: '/landing/for/vet-practices-hero.webp',
      alt: 'Duet mascots posed as an independent vet practice scene.',
      aspect: 'aspect-square',
    },
    outcomes: [
      {
        title: 'No-show recovery',
        body: "Detects cancellations and no-shows in real time, drafts a same-day rebook message with an optional deposit link, and follows up at 24 and 72 hours if the client doesn't respond. Recovers 25 to 60% of missed appointments.",
        Icon: CalendarCheckIcon,
      },
      {
        title: 'Lapsed-client reactivation',
        body: 'Finds every patient overdue for an annual or vaccine, drafts a warm, species-specific outreach, and routes it to the channel the client prefers (text, email, postcard).',
        Icon: HeartIcon,
      },
      {
        title: 'Rx refill reminders',
        body: 'Tracks every active prescription, predicts the refill date, and nudges the client 7 days out with a one-tap reorder link. Reduces compliance gaps and front-desk call volume in one move.',
        Icon: PillIcon,
      },
      {
        title: 'Wellness plan recommender',
        body: "Identifies clients already spending enough that a plan would break even, and drafts the conversation for your front desk, personalized to the pet's care history and your in-house plan.",
        Icon: ClipboardTextIcon,
      },
      {
        title: 'New-puppy + new-kitten onboarding',
        body: 'A 12-week onboarding sequence per new patient: vaccine schedule, training tips, food guidance, and check-in reminders, all branded as your practice.',
        Icon: PawPrintIcon,
      },
      {
        title: 'Review monitor + board-compliant reply',
        body: "Catches every Google, Facebook, and Nextdoor review the moment it lands and drafts an empathetic reply that respects client confidentiality under your state's veterinary practice act. Your practice owner approves with one tap.",
        Icon: StarIcon,
      },
    ],
    kickoffPrompt:
      "Pull every patient who hasn't been in for 14+ months, group by species and last visit reason, and draft a warm reactivation message per group. Hold them in drafts for me. I want to review tone before any of these go out.",
    faqs: [
      {
        q: 'Does Duet integrate with my PIMS (AVImark, Cornerstone, ezyVet, Pulse, Provet Cloud, Shepherd, Vetspire, Digitail)?',
        a: "Yes. Duet reads and writes through your PIMS API where one exists, and through a structured export or reminder workflow where it doesn't. Your PIMS stays the system of record.",
      },
      {
        q: 'HIPAA, vet boards, and client privacy: what actually applies?',
        a: "HIPAA does not apply to veterinary practices. It covers human protected health info, and animals are not 'persons' under the statute. What does apply: your state's veterinary practice act, the AVMA Principles of Veterinary Medical Ethics, state breach-notification laws for owner PII, and PCI-DSS if you store card data. Duet drafts every public-facing reply to comply: no patient details, no diagnoses, no records exposure.",
      },
      {
        q: 'Will Duet practice medicine?',
        a: 'No. Duet drafts. Your DVM decides. Anything clinical (triage, refill approval, treatment plan) is held as a draft for a licensed clinician to approve before it goes to the client.',
      },
      {
        q: 'How does it compare to PetDesk (now including Vetstoria), Weave, Otto, and Digitail?',
        a: 'Those are bookable reminder and messaging tools, narrow and single-purpose. Duet is broader: reactivation, no-show recovery, wellness-plan candidates, refill nudges, onboarding sequences, and review replies all from one workspace, written in your voice instead of a templated script.',
      },
      {
        q: 'How long does setup take?',
        a: 'Most practices are live on their first workflow (usually no-show recovery or lapsed-client reactivation) within a week. The full playbook lands inside the first month.',
      },
      {
        q: 'Can I start with one workflow?',
        a: 'Yes. Most independents start with either no-show recovery or lapsed-client reactivation, the two workflows that pay back fastest.',
      },
    ],
    metaTitle: 'AI for Vet Practices: Reactivation, No-Shows, Refills | Duet',
    metaDescription:
      'Duet is an AI coworker for independent vet practices. Lapsed-client reactivation, no-show recovery, wellness-plan candidates, Rx refill nudges, and board-compliant review replies.',
    lastUpdated: '2026-05-27',
  },
]

export function getVertical(slug: string): VerticalSpec | undefined {
  return VERTICALS.find(v => v.slug === slug)
}

export function getAllVerticalSlugs(): string[] {
  return VERTICALS.map(v => v.slug)
}
