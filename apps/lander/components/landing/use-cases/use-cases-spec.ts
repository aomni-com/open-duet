import type { AppLocale } from '@/lib/i18n/locales'

/**
 * Single source of truth for the /use-cases section.
 *
 * Every persona page (/use-cases/[slug]) and the hub grid (/use-cases)
 * reads from this locale-keyed copy. Adding a sixth persona means appending
 * to both locale entries and everything downstream picks it up.
 *
 * Copy rules (so the pages don't read like AI slop):
 * - One verb per use case; concrete outcome ("ships in an afternoon"),
 *   not vague benefit ("be more productive").
 * - Prompts look like real Duet commands — imperatives a power user
 *   would actually type.
 * - Pain cards quote the persona in their own voice. Body sentence
 *   reframes the pain as a job Duet does.
 */

export type UseCasePersonaUseCase = {
  id: string
  /** H3 on the persona page — keyword-rich, scannable. */
  title: string
  /** Example Duet prompt the user could send. */
  prompt: string
  /** Concrete outcome / time saved chip text. */
  outcome: string
}

export type UseCasePersonaFaq = {
  q: string
  /** Plain text answer; the page renders it as a paragraph and as
   * FAQPage JSON-LD. Don't include markdown links here — the JSON-LD
   * has to ship clean. */
  a: string
}

export type UseCasePersonaPainCard = {
  title: string
  /** Short first-person quote — the user's own words. */
  quote: string
  body: string
}

export type UseCasePersonaHowItWorks = {
  step: number
  title: string
  body: string
}

/**
 * Leaf-level node under a persona. Each leaf becomes a long-tail SEO
 * page at /use-cases/<persona>/<leaf>. Shape is HowTo/FAQPage schema
 * bait — see `01-use-case-tree-ia.md` for the IA rationale.
 *
 * Copy rules for leaves:
 * - Title is a real long-tail query ("AI for Shopify store owners"),
 *   not a clever positioning line.
 * - Workflow steps must read like an actual playbook so the HowTo
 *   schema is honest — no "step 1: sign up".
 * - FAQ answers stay plain text (no markdown links) because the same
 *   strings ship into FAQPage JSON-LD on the leaf page.
 */
export type UseCasePersonaLeafStep = {
  /** 1-indexed; renders as the HowToStep position. */
  step: number
  /** Short imperative — "Connect your Shopify store". */
  title: string
  /** 1-3 sentences. The body of the HowToStep. */
  body: string
}

export type UseCasePersonaLeaf = {
  /** URL slug under /use-cases/<persona>/. Keep stable. */
  slug: string
  /** Display title — used in the sub-use-cases grid card and the H2
   * eyebrow on the leaf page. */
  title: string
  /** Long-form H1 on the leaf page. Long-tail keyword phrasing. */
  h1: string
  /** <= 60 chars meta title. */
  metaTitle: string
  /** 140-160 chars meta description. */
  metaDescription: string
  /** 1-2 sentence lede under the H1, also used as the card blurb on
   * the persona page's sub-use-cases grid. */
  intro: string
  /** 4-6 steps — the HowTo schema bait. */
  workflowSteps: UseCasePersonaLeafStep[]
  /** 5+ Q&A pairs — leaf-specific objection handling. */
  faqs: UseCasePersonaFaq[]
  /** Cross-axis links to /use-cases/by-job/<slug>. Empty array is
   * fine while the by-job branch hasn't been built yet — the leaf
   * page just hides the rail. */
  relatedJobs: string[]
  /** ISO date (YYYY-MM-DD) of the leaf's last meaningful content
   * edit. Surfaced as `<lastmod>` in the sitemap so the freshness
   * signal doesn't oscillate every build. */
  lastUpdated: string
}

export type UseCasePersona = {
  /** URL slug under /use-cases/. Keep stable — used as anchor for
   * cross-links, JSON-LD `@id`, and analytics. */
  slug: string
  /** Display name ("Small business owners"). */
  name: string
  /** Short label ("Small Businesses") used in the nav grid + hub card. */
  shortName: string
  /** <= 22 chars, used in navbar dropdown. */
  navLabel: string
  /** Eyebrow above H1. */
  eyebrow: string
  /** First half of H1. */
  h1Lead: string
  /** Highlighted half of H1 (rendered in serif italic). */
  h1Highlight: string
  /** <= 60 chars, format: "AI for X | Benefit | Duet". */
  metaTitle: string
  /** 140-160 chars. */
  metaDescription: string
  primaryKeyword: string
  /** 4-6 supporting keywords. */
  secondaryKeywords: string[]
  /** Plain-language lede shown under H1. */
  heroDescription: string
  /**
   * 2-3 sentence definitional answer to "What is an AI coworker for
   * <persona>?". Rendered as a bold H2 near the top of the persona
   * page to feed Google AI Overview / Perplexity definitional citations
   * (I/O 2026 adapt). Optional so older personas don't break.
   */
  definition?: string
  /** Exactly 3 pain cards. */
  painCards: UseCasePersonaPainCard[]
  /** Exactly 4 use cases. */
  useCases: UseCasePersonaUseCase[]
  comparison: {
    /** 4 bullets. */
    without: string[]
    /** 4 bullets. */
    with: string[]
  }
  /** Exactly 3 steps. */
  howItWorks: UseCasePersonaHowItWorks[]
  /** 5-6 questions. */
  faqs: UseCasePersonaFaq[]
  /** 2 other persona slugs to cross-link in the related section. */
  relatedSlugs: string[]
  /** Override for the hero CTA label. Defaults to "Start free" on the page. */
  primaryCtaLabel?: string
  /**
   * Leaf pages under this persona — the long-tail bottom of the
   * /use-cases tree. Empty array means no leaves shipped yet; the
   * persona page just skips the sub-use-cases grid.
   *
   * Each leaf becomes /use-cases/<persona>/<leaf> at build time via
   * generateStaticParams in the lander use-case leaf route.
   */
  leaves: UseCasePersonaLeaf[]
  /** ISO date (YYYY-MM-DD) of the persona's last meaningful content
   * edit. Surfaced as `<lastmod>` in the sitemap so the freshness
   * signal doesn't oscillate every build. */
  lastUpdated: string
}

const EN_USE_CASE_PERSONAS: UseCasePersona[] = [
  {
    slug: 'small-businesses',
    name: 'Small business owners',
    shortName: 'Small Businesses',
    navLabel: 'Small businesses',
    eyebrow: 'For small business owners',
    h1Lead: 'AI for the people',
    h1Highlight: 'actually running the business.',
    metaTitle: 'AI for Small Business | Hire One Today | Duet',
    metaDescription:
      'Duet is an always-on AI for small business owners. Build a website, run support, onboard customers, and ship internal tools — without hiring another role.',
    primaryKeyword: 'AI for small business',
    secondaryKeywords: [
      'AI assistant for small business',
      'AI for SMB',
      'small business automation',
      'AI virtual assistant',
      'AI for shop owners',
    ],
    heroDescription:
      "You're the founder, the marketer, the IT desk, and the bookkeeper. Duet is AI for small business owners who actually run the business — it builds the site, drafts the email, sets up the spreadsheet, and gets the first recurring workflow ready for review. One coworker, one workspace, the operating loop you kept meaning to systemize.",
    definition:
      'An AI coworker for small business owners is a persistent, cloud-based AI teammate that builds and runs the recurring work an owner usually does after hours — the website, the support inbox, the invoice tracker, the customer onboarding flow. Unlike a chatbot, it lives in its own workspace, remembers your business between sessions, and ships under your review rules so a one-person shop can operate like a small team.',
    painCards: [
      {
        title: 'The website you never finish',
        quote: '"I\'ve been meaning to redo our site since last year."',
        body: 'Duet builds a real, fast, indexable site from a short brief — copy, images, contact form, the lot — and hosts it on a Duet subdomain or your own. When you want a price tweak, a new product card, or a holiday banner, you ask in plain English and Duet can make the update from the same workspace.',
      },
      {
        title: 'Support email pile-up',
        quote: '"By Friday my inbox is a graveyard."',
        body: 'Duet reads every support thread, drafts a reply in your voice, flags the ones that need you, and labels the rest so review is fast. The inbox becomes a reviewed queue — not a graveyard — and the customers who actually need a human are sitting at the top.',
      },
      {
        title: 'Tools you can never afford to build',
        quote: '"We need a tiny dashboard, but no developer wants the job."',
        body: 'Duet writes the internal tool from scratch — invoice tracker, booking form, stock checker — and runs it on your workspace so you stop juggling spreadsheets. It comes with a real database, real authentication, and a real URL, so the people you want using it can just open the link.',
      },
    ],
    useCases: [
      {
        id: 'website',
        title: 'Build and ship your business website',
        prompt:
          'Build a 1-page site for Pine & Pour, a wine bar in Austin — menu, hours, reservations form, and an Instagram block. Deploy it to pineandpour.duet.so.',
        outcome: 'Ready for review from one brief',
      },
      {
        id: 'internal-apps',
        title: 'Create internal apps without an engineer',
        prompt:
          'Build me an invoice tracker. Pull customer data from our Google Sheet, let me mark invoices paid, and email a reminder on the follow-up date if unpaid.',
        outcome: 'Working app from a plain-English brief',
      },
      {
        id: 'support',
        title: 'Manage support emails and customer messages',
        prompt:
          'Read recent messages in support@, draft replies in our tone, and put the ones that need a refund into a "needs me" bucket.',
        outcome: 'Drafts prepared, exceptions escalated',
      },
      {
        id: 'onboarding',
        title: 'Onboard new customers with a reviewable workflow',
        prompt:
          'When a Stripe payment lands, generate a welcome email, create their Notion workspace from the template, and book a kickoff in my calendar.',
        outcome: 'Onboarding packet queued for review',
      },
    ],
    comparison: {
      without: [
        'Five tabs open, four half-finished tools, one website that never shipped.',
        'Recurring support backlog you clear outside work hours.',
        'Quotes for a "simple dashboard" that turn into a custom-project rabbit hole.',
        'New customer onboarding done from memory, in DMs.',
      ],
      with: [
        'One Duet workspace that builds, ships, and runs the work.',
        'Inbox triaged daily, drafts ready when you sit down.',
        'Internal apps written in plain English and hosted for you.',
        'A repeatable onboarding flow that runs when Stripe records a payment.',
      ],
    },
    howItWorks: [
      {
        step: 1,
        title: 'Point Duet at your business',
        body: 'Share your website, your inbox, and the tools you live in. Duet reads your brand voice, your past replies, your pricing pages, and the recurring workflows you run — without turning setup into a discovery sprint.',
      },
      {
        step: 2,
        title: 'Ask in plain English',
        body: 'Tell Duet what you actually need — "rebuild our site," "draft replies in my voice," "spin up an invoice tracker." No prompt engineering, no template gallery to browse, no integrations to set up first. You describe the job; Duet picks the tools.',
      },
      {
        step: 3,
        title: 'Run it on a schedule',
        body: 'Duet ships the work to a real server, sends drafts back to you for approval, and runs the recurring pieces on schedule. You stay in the loop, not in the weeds — review what ran this morning, redirect what didn’t, and keep the low-risk pieces moving under your rules.',
      },
    ],
    faqs: [
      {
        q: 'Do I need to be technical to use Duet?',
        a: "No. Duet is built for owners and operators who don't write code. You describe the work in plain English; Duet does the typing, the building, and the deploying. The closest thing to setup is connecting the tools you already use — Gmail, Drive, Stripe — and pointing Duet at your business URL.",
      },
      {
        q: 'Can Duet really build a website that ranks?',
        a: 'Duet can generate crawlable, fast, SEO-ready pages with metadata, schema, sitemap entries, and Open Graph cards — not a glorified PDF. Rankings still depend on domain authority, content quality, links, search intent, and competition, so treat Duet as the system that gets the page ready and keeps improving it.',
      },
      {
        q: 'How does Duet handle our customer data?',
        a: 'Every Duet workspace gets its own private cloud server with isolated storage and memory. Your customer data, drafts, and integrations stay scoped to your team — no shared multi-tenant pool, no training on your content, and no surprise cross-tenant exposure if a neighboring workspace gets compromised.',
      },
      {
        q: 'What does it cost compared to hiring a part-time VA?',
        a: 'A part-time human assistant is a recurring labor cost with limited coverage. Duet has monthly plans with included credits and fits best when repeatable work spans tools, files, and approvals inside your workspace.',
      },
      {
        q: 'Will Duet replace my team?',
        a: 'No. Duet takes on repeatable work your team could not get to — the website you never shipped, the inbox you never cleared, the tool you never built. Your team gets to focus on the things that actually need a human in the room: the customer conversation, the judgment call, the relationship.',
      },
      {
        q: 'How long does setup take?',
        a: 'Start by connecting a URL, inbox, or calendar and handing off one workflow. The first useful output depends on the workflow and tools connected.',
      },
    ],
    relatedSlugs: ['agencies', 'operations'],
    leaves: [
      {
        slug: 'shopify-store',
        title: 'AI for Shopify store owners',
        h1: 'Run your Shopify store with an AI coworker',
        metaTitle: 'AI for Shopify Stores | Run It Like a Giant | Duet',
        metaDescription:
          'Duet is AI for Shopify store owners. Draft product pages, answer support, rebuild the storefront, and run abandoned-cart flows — without hiring another agency.',
        intro:
          "You're running a Shopify store and a customer service desk and a marketing team — alone. Duet plugs into your store, your inbox, and your ad accounts to help run the loop: product page copy, support replies, abandoned-cart sequences, and the analytics report you've been meaning to look at since launch.",
        workflowSteps: [
          {
            step: 1,
            title: 'Connect your Shopify store and support inbox',
            body: 'Point Duet at your store and your customer service inbox (Gmail, Help Scout, Gorgias, or plain support@). It pulls in your product catalog, brand voice, refund policy, and recent support tickets so its drafts can match how you already talk to customers.',
          },
          {
            step: 2,
            title: 'Generate product pages and category copy',
            body: 'Hand Duet a product spec or a supplier PDF and it drafts the title, description, bullets, SEO metadata, and FAQ block — ready to publish through an enabled Shopify Admin path or paste in. Same flow rewrites stale category pages so the whole catalog is searchable, not just the bestsellers.',
          },
          {
            step: 3,
            title: 'Run support replies with human review',
            body: "Duet reads every new ticket, classifies it (where's my order, refund, sizing, wholesale), drafts a reply in your tone, and queues it for review. Anything ambiguous — a chargeback, a press request — escalates to you with the relevant context attached.",
          },
          {
            step: 4,
            title: 'Recover abandoned carts on cadence',
            body: 'Connect Klaviyo or your built-in Shopify Email and Duet writes the abandoned-cart sequence — personalized to the cart contents and the customer\u2019s previous orders. New variants can run on a cadence, with winners promoted after review.',
          },
          {
            step: 5,
            title: 'Get a weekly store report you can act on',
            body: 'On a weekly cadence, Duet emails a one-page report: GMV trend, top SKUs, support volume and CSAT, ad ROAS, and the decisions that need attention. The report is the meeting; you can review it before the team sync.',
          },
        ],
        faqs: [
          {
            q: 'Does Duet work with the Shopify Admin API?',
            a: 'Yes. Duet authenticates against your Shopify store with scoped credentials and can read products, orders, and customers, and write product updates, draft orders, and metafield values. You approve the scopes during setup — nothing escalates without you re-authorizing it.',
          },
          {
            q: 'Will the product copy sound like AI slop?',
            a: 'No, not if you give it strong examples. Once Duet has read your top-selling product pages, it mirrors your sentence length, the words you use for fit and material, the way you call out shipping, and the lines you put in the FAQ block. The goal is drafts that need editing, not rewriting.',
          },
          {
            q: 'Can it handle returns and refunds?',
            a: 'Duet drafts the refund reply and proposes the refund in Shopify, but a human approves the actual money movement by default. You can loosen that rule per category once you trust the classifier — some teams later define low-risk categories or thresholds after review and keep edge cases escalated.',
          },
          {
            q: 'Does it integrate with Klaviyo, Gorgias, and the rest of the Shopify stack?',
            a: 'Duet can connect to Shopify stacks through managed integrations, APIs, webhooks, IMAP/CSV, or custom wiring depending on the tool. Klaviyo, Gorgias, Help Scout, Postscript, Recharge, and Loop Returns-style workflows are best treated as scoped setup items, not assumed instant connectors.',
          },
          {
            q: 'How is this different from a Shopify-native AI like Sidekick?',
            a: 'Sidekick lives inside the Shopify admin and helps you with one task at a time. Duet lives outside the admin, runs scheduled workflows on a cloud server, keeps memory across your workspace, and reaches into Klaviyo, Gorgias, your ad accounts, and your inbox. Use both — they don\u2019t conflict.',
          },
          {
            q: 'How fast can a one-person store be live with Duet?',
            a: 'Solo Shopify owners typically start with support drafts or abandoned-cart copy, then expand into product pages, email, and recurring reporting after a few review passes.',
          },
        ],
        relatedJobs: ['customer-support', 'content-marketing', 'inbox-triage'],
        lastUpdated: '2026-05-18',
      },
      {
        slug: 'service-business-owner',
        title: 'AI for service business owners',
        h1: 'Run your service business with a cloud AI assistant',
        metaTitle: 'AI for Service Businesses | Cloud Assistant | Duet',
        metaDescription:
          'Duet is AI for service businesses. Book appointments, send invoices, follow up on leads, triage the inbox, and run the front office from one workspace.',
        intro:
          "You run a salon, a clinic, a contracting crew, a cleaning business. The phone never stops, the inbox is a mess by Friday, and half your leads never get a follow-up. Duet sits on top of your existing tools — Google Calendar, QuickBooks, Jobber, your phone forwarding — and runs the front office while you're on a job site.",
        workflowSteps: [
          {
            step: 1,
            title: 'Point Duet at your calendar and inbox',
            body: 'Connect Google Calendar (or Calendly, Acuity, or Jobber), your business email, and your phone forwarding number. Duet learns your service menu, your pricing, your hours, and the way you talk to customers from your past replies.',
          },
          {
            step: 2,
            title: 'Capture leads on every channel',
            body: "Inbound text, missed call, website form, Yelp message — Duet drafts the booking link or a clarifying question, then keeps the conversation moving until the lead either books or opts out. The goal is fewer leads sitting untouched while you're on the job.",
          },
          {
            step: 3,
            title: 'Book and confirm appointments with review rules',
            body: 'Duet proposes a slot from your calendar, gets confirmation by text or email, and writes the appointment into your booking system — with the customer\u2019s notes, the service requested, and the address. It can also send reminders and reschedule if they reply asking to move.',
          },
          {
            step: 4,
            title: 'Send invoices and chase the slow payers',
            body: 'After a job, Duet drafts the invoice in QuickBooks or Jobber from the appointment notes, sends it for your approval, and then follows up on a polite cadence. You review the exceptions instead of rebuilding the same invoice workflow every time.',
          },
          {
            step: 5,
            title: 'Ask for the review at the right moment',
            body: "After the job is marked complete, Duet can send a personalized request for a Google review — with the customer's name, the service they got, and a direct link to your Google Business Profile. More consistent review requests give you a better shot at building local trust.",
          },
          {
            step: 6,
            title: 'Get a Monday-morning roundup of the week ahead',
            body: 'On a weekly cadence, Duet emails you open bookings, the leads still on the fence, the invoices unpaid, and the slots that are still open. You start the week knowing exactly where to push.',
          },
        ],
        faqs: [
          {
            q: 'Does Duet work with Jobber, ServiceTitan, or Housecall Pro?',
            a: 'Duet can connect to service-business systems through managed integrations, APIs, email, CSV exports, or custom wiring depending on the tool. For Jobber, ServiceTitan, Housecall Pro, Workiz, or a smaller system, the setup should be scoped against the exact API access and permissions available.',
          },
          {
            q: 'Can it answer the phone?',
            a: "Duet doesn't replace your phone line, but it can pick up missed calls and SMS via Twilio, OpenPhone, or your existing call forwarding. The caller gets a booking link or a human-sounding follow-up — so fewer leads drift to your competitor across town.",
          },
          {
            q: 'Will it sound like me, or like a robot?',
            a: 'It sounds more like you after it has examples of your past customer messages to read. The goal is for routine replies to feel familiar enough that regulars do not notice a handoff — and when Duet uses a phrase you would never say, you can correct that in one sentence.',
          },
          {
            q: 'How does this compare to hiring a virtual receptionist?',
            a: 'A virtual receptionist is a recurring labor cost for scripted coverage. Duet has monthly plans with included credits and fits best when front-office work spans booking, invoices, payment follow-up, reviews, and customer context.',
          },
          {
            q: 'Is my customer data safe?',
            a: "Every Duet workspace is a private cloud server with isolated storage. Customer phone numbers, addresses, and job notes stay inside your workspace — no shared multi-tenant pool, no training on your content, no cross-tenant exposure if someone else's workspace is compromised.",
          },
          {
            q: 'What if I don\u2019t want Duet sending messages without me reviewing?',
            a: "You pick the approval rule per workflow. A safer rollout starts with everything in review, then narrows explicitly enabled sends to low-risk confirmations or review requests while invoices and refunds keep needing a human tap. You can change the rule any time — it's one prompt to Duet, not a settings menu.",
          },
        ],
        relatedJobs: ['customer-support', 'inbox-triage', 'sales-outbound'],
        lastUpdated: '2026-05-18',
      },
    ],
    lastUpdated: '2026-05-21',
  },
  {
    slug: 'agencies',
    name: 'Creative agencies',
    shortName: 'Agencies',
    navLabel: 'Creative agencies',
    eyebrow: 'For creative & marketing agencies',
    h1Lead: 'AI that lets your agency',
    h1Highlight: 'finally bill for the thinking.',
    metaTitle: 'AI for Creative Agencies | Ship More Per Client | Duet',
    metaDescription:
      'Duet is AI for creative agencies. Ship landing pages, draft concepts, generate on-brand imagery, and package deliverables faster — without growing headcount.',
    primaryKeyword: 'AI for creative agencies',
    secondaryKeywords: [
      'AI for marketing agencies',
      'AI for design agencies',
      'agency automation',
      'AI for freelancers',
      'AI agency workflow',
    ],
    heroDescription:
      'Stop losing margin to grunt work. Duet is AI for creative agencies that want to ship more per client without growing headcount — it builds the landing site, drafts the design concept, generates the on-brand imagery, and packages the deliverable, so your team gets back to the high-priced thinking the work was sold on.',
    definition:
      'An AI coworker for agencies is a persistent, cloud-based AI teammate that handles the production work a billable team usually grinds through — first drafts, on-brand imagery, deliverable assembly, client recaps, and reporting. It lives in one workspace per client or retainer, remembers context across engagements, and ships the repeatable pieces under your review rules so creative directors get back to the high-priced thinking the work was sold on.',
    painCards: [
      {
        title: 'Production eats the margin',
        quote: '"We sold the strategy. We\'re delivering the slides."',
        body: 'Duet handles the production layer — slides, decks, landing pages, image generation — so senior time stops getting burned on assembly. Your strategists go back to telling the story; Duet does the layout, the resizes, and the eighteenth round of asset renames.',
      },
      {
        title: 'Concepts take too long to mock',
        quote: '"Three rounds of comps before the client says anything useful."',
        body: "Duet drafts the concept in your brand voice, generates the imagery in your visual language, and gets a review-ready first round in front of the client. The next round comes back faster too, because the working files live in your workspace — not on a designer's laptop you can't get to until Tuesday.",
      },
      {
        title: 'Deliverables packaged by hand',
        quote: '"Friday is always the day we zip the assets and write the handoff doc."',
        body: 'Duet bundles the final assets, writes the handoff doc, drops it in the client folder, and emails the link. No more Friday afternoons lost to file plumbing — the same workflow runs for every project, named the same way, with the same change log every time.',
      },
    ],
    useCases: [
      {
        id: 'client-sites',
        title: 'Build client landing pages and microsites',
        prompt:
          'Build a launch landing page for the Northbeam Series B campaign. Use the brand kit in /brand/northbeam. Hero, feature row, customer quote, signup form. Deploy to staging.',
        outcome: 'A working build, not a stalled sprint',
      },
      {
        id: 'concepts',
        title: 'Draft design concepts and creative briefs',
        prompt:
          'Take the Loft 32 brief and draft 3 concept directions: positioning, key visual idea, sample tagline, and a 2-paragraph rationale for each.',
        outcome: 'Multiple directions from one brief',
      },
      {
        id: 'imagery',
        title: 'Generate on-brand imagery at scale',
        prompt:
          'Generate 12 hero images for the Loft 32 site in the same style as /brand/loft32/refs — overhead studio shot, soft daylight, neutral palette.',
        outcome: 'On-brand variants from your references',
      },
      {
        id: 'deliverables',
        title: 'Package and ship client deliverables',
        prompt:
          'Zip the final assets in /clients/loft32/v3, write a handoff doc summarizing changes since v2, upload to the client Drive, and email the link to ben@loft32.com.',
        outcome: 'Handoff done in one prompt',
      },
    ],
    comparison: {
      without: [
        'Senior strategists doing slide-cleanup at 9pm.',
        'Long gaps between brief and first concept review.',
        'Brand assets recreated from scratch every project.',
        'Friday handoffs done by hand in Dropbox.',
      ],
      with: [
        'Production runs on Duet. Senior time goes to thinking and presenting.',
        'Concepts drafted from the brief, ready for human polish.',
        "A brand-aware AI that remembers every client's visual system.",
        'Handoffs packaged, named, and queued for review.',
      ],
    },
    howItWorks: [
      {
        step: 1,
        title: 'Load the brand',
        body: "Drop each client's brand kit, voice guidelines, and asset library into Duet. It learns the rules so the output looks like the brand on the first pass — and the second project for the same client starts from where the first one ended, not from a blank canvas.",
      },
      {
        step: 2,
        title: 'Brief like you brief a junior',
        body: "Hand Duet the brief in the same words you'd use with a new designer. It comes back with mocks, copy, and decks — all in your house style — and your senior people spend their time reviewing tasteful options instead of dictating layouts to a queue of contractors.",
      },
      {
        step: 3,
        title: 'Review and ship',
        body: 'Polish the parts that matter, queue the rest. Duet packages deliverables, uploads to the client folder, writes the handoff note, and prepares the email. The Friday-afternoon ritual becomes a reviewable handoff instead of a manual scramble.',
      },
    ],
    faqs: [
      {
        q: 'Will the output actually look on-brand?',
        a: 'Yes — once Duet has the brand kit and a handful of reference outputs. The more you correct it in the first project, the closer it gets to your house style on the next one. Agencies use that review loop to turn rough first drafts into reusable client-specific style memory.',
      },
      {
        q: 'Can we keep clients separated?',
        a: "Each client gets its own workspace with isolated memory and files. Brand assets, drafts, and workspace history for one account never leak into another, and you can hand keys to a client (or revoke them) without that touching the other accounts you're running.",
      },
      {
        q: 'Does Duet replace designers and copywriters?',
        a: 'No. It absorbs the production layer — the parts your senior people resent doing. Concepts still need taste, presentations still need a human in the room. Duet just clears the runway so the senior bench spends time on the work clients actually paid for.',
      },
      {
        q: 'How do we bill for work Duet does?',
        a: 'The way you already do — by project, by deliverable, or by retainer. Duet is a cost line, not a billable role. The goal is to protect strategy pricing while reducing repetitive production time that eats margin.',
      },
      {
        q: 'What about image generation rights?',
        a: 'Duet routes image work through commercial-use-capable providers where available, and your client data stays scoped to the workspace. For client deliverables, review the selected model/provider terms and pin or exclude providers when an account has specific IP requirements.',
      },
      {
        q: 'How does Duet fit into a Figma / Adobe / Webflow stack?',
        a: "Duet doesn't replace your design tools — it sits one step earlier, drafting the concept, the copy, and the visual references that feed into them. Hand it a brief, get a Figma-ready mock; hand it a wireframe, get a working Webflow page. Agencies use Duet to skip the blank-page pass on each project.",
      },
    ],
    relatedSlugs: ['small-businesses', 'founders'],
    leaves: [],
    lastUpdated: '2026-05-21',
  },
  {
    slug: 'founders',
    name: 'Startup founders',
    shortName: 'Founders',
    navLabel: 'Startup founders',
    eyebrow: 'For startup founders',
    h1Lead: 'AI for founders who would rather',
    h1Highlight: 'ship than schedule.',
    metaTitle: 'AI for Startup Founders | Ship Faster Solo | Duet',
    metaDescription:
      'Duet is AI for startup founders — the cofounder you can deploy. Build a working MVP, run research, draft fundraising decks, and send investor updates.',
    primaryKeyword: 'AI for startup founders',
    secondaryKeywords: [
      'AI cofounder',
      'AI for solo founders',
      'startup AI agent',
      'AI for indie hackers',
      'MVP AI builder',
    ],
    heroDescription:
      "You're earlier than the role you're playing. Duet is AI for startup founders who would rather ship than schedule — it builds the MVP, runs the market research, drafts the deck, and sends the investor update, so you stop being the bottleneck on every function at once. Less hire-the-cofounder, more deploy-the-cofounder.",
    definition:
      'An AI coworker for founders is a persistent, cloud-based AI teammate that runs every function a one-person founder usually juggles — prototypes, market research, outreach, recruiting prep, decks, and weekly updates. It does the work from a single workspace, remembers prior context, and prepares each move for review so the founder stops being the bottleneck on every function at once.',
    painCards: [
      {
        title: "Code you can't justify hiring for",
        quote: '"I have a rough idea. I need a prototype the team can react to."',
        body: 'Duet ships a working MVP — frontend, backend, deploy — from a spec written like a story. You ship a real product to test the wedge, not a pitch deck — which means real users, real signups, and real conversations with the people who actually want the thing.',
      },
      {
        title: 'Research that should be automated',
        quote: '"I keep rebuilding the same competitor sheet."',
        body: 'Duet runs deep competitor and market research on a schedule, files findings into a shared doc, and pings you when something interesting moves. Pricing pages, changelogs, LinkedIn posts, hiring patterns — watched continuously without you reopening another spreadsheet.',
      },
      {
        title: "Investor updates that don't happen",
        quote: '"I haven\'t sent an update since the angel round."',
        body: 'Duet drafts the monthly update from your metrics, your workspace history, and your roadmap — you edit, you hit send, the cap table stays warm. The same scaffolding builds the board deck the quarter you raise, so you stop starting from a blank Google Slide.',
      },
    ],
    useCases: [
      {
        id: 'mvp',
        title: 'Build a working MVP from a one-page spec',
        prompt:
          'Build the MVP described in /spec/v1.md. Use Next.js + Convex + Resend. Set up auth with Convex Auth. Deploy to Vercel and seed the demo data from /spec/seed.json.',
        outcome: 'Demo ready for review',
      },
      {
        id: 'research',
        title: 'Run market and competitor research',
        prompt:
          "On a weekly cadence, pull updates from our 8 competitors' pricing pages, changelogs, and LinkedIn posts. Summarize the diff in #market-watch.",
        outcome: 'Recurring intel, zero clicks',
      },
      {
        id: 'deck',
        title: 'Draft fundraising decks and one-pagers',
        prompt:
          'Draft a 12-slide seed deck using /memos/seed-narrative.md, our latest metrics from Stripe, and the design system in /brand. Output as Google Slides.',
        outcome: 'Deck v1 from your source material',
      },
      {
        id: 'updates',
        title: 'Send monthly investor updates',
        prompt:
          "Draft the November investor update: pull MRR from Stripe, top 3 wins from #wins, the ask for the month, and last month's asks revisited. Email me v1 for review.",
        outcome: 'From blank page to review-ready draft',
      },
    ],
    comparison: {
      without: [
        'You context-switch between code, sales, and decks all day.',
        'A backlog of "I\'ll do it Monday" tasks that never get done.',
        'Investor updates done quarterly, badly, with guilt.',
        'A Notion full of competitor links you never reopen.',
      ],
      with: [
        'A cofounder-shaped AI that actually executes the spec.',
        'Recurring research, drafting, and shipping that runs on cron.',
        'Updates and decks drafted from real data, ready to polish.',
        'You back in the seat where founders should be — selling and building.',
      ],
    },
    howItWorks: [
      {
        step: 1,
        title: 'Give Duet the founding documents',
        body: "Share your spec, your brand, your metrics dashboards, and your last investor update. Duet builds a memory of the company so it can write in the founder voice — your phrasing, your numbers, your roadmap, your customers' names — instead of generic startup boilerplate.",
      },
      {
        step: 2,
        title: 'Delegate functions, not tickets',
        body: "Hand off whole functions — research, drafting, MVP build — instead of micromanaging tasks. Duet runs them on cron and pings you for review when there's a decision to make or a draft worth your time, not for every keystroke.",
      },
      {
        step: 3,
        title: 'Ship and review weekly',
        body: "On a regular review cadence, scan Duet's output: the MVP it shipped, the update it drafted, the research it surfaced. Approve, edit, or redirect. The flywheel keeps spinning between reviews, so planning opens with progress instead of a stale backlog.",
      },
    ],
    faqs: [
      {
        q: 'Can Duet really build a usable MVP?',
        a: 'Yes. Duet writes real production code (Next.js, Convex, Supabase, Vercel deploys) from a spec. The goal is a working demo you can put in front of a design partner, with a codebase that is yours to take to GitHub the moment you outgrow no-code.',
      },
      {
        q: 'Is it better than just using Cursor or Claude Code?',
        a: "Coding assistants help you type faster on your laptop. Duet runs on its own cloud server, persists state, schedules work, and handles non-coding functions (research, decks, updates) in the same workspace. For a founder running every function alone, that's a different shape of product — Cursor speeds up Tuesday; Duet runs all five weekdays.",
      },
      {
        q: 'How does Duet handle sensitive metrics and investor data?',
        a: 'Your workspace is a private cloud server with isolated storage. Stripe keys, board materials, and metric dashboards stay scoped to your org — no cross-tenant exposure and no training on your content. Secrets live in encrypted environment variables that Duet reads at runtime, never logged or surfaced.',
      },
      {
        q: 'Can I bring Duet into a team workspace later?',
        a: 'Yes. Start solo, then invite a cofounder or contractor. Shared files and Train sources stay with the workspace, so the new member can work from the same codebase, customer context, and operating knowledge.',
      },
      {
        q: 'What does it cost at pre-seed?',
        a: "Usage-based — solo founders can start with a small credit pack while validating. There's no per-seat tax, so adding contractors doesn't multiply the bill. When you raise and ramp output, the line item scales with the work, not with headcount.",
      },
      {
        q: 'Will my investors care that I shipped this with AI?',
        a: 'The serious ones care about traction, judgment, pace, and burn discipline — not which keys you pressed to ship the build.',
      },
    ],
    relatedSlugs: ['agencies', 'operations'],
    leaves: [],
    lastUpdated: '2026-05-21',
  },
  {
    slug: 'sales-teams',
    name: 'Sales teams',
    shortName: 'Sales Teams',
    navLabel: 'Sales teams',
    eyebrow: 'For sales teams',
    h1Lead: 'AI for sales teams who would rather',
    h1Highlight: 'close than copy-paste.',
    metaTitle: 'AI for Sales Teams | Enrich, Send, Follow Up | Duet',
    metaDescription:
      'Duet is AI for sales teams that closes the admin gap. Enrich inbound, run outbound, keep the CRM clean, and follow up — so reps sell instead of copy-paste.',
    primaryKeyword: 'AI for sales teams',
    secondaryKeywords: [
      'AI SDR',
      'sales automation AI',
      'AI for outbound',
      'AI CRM cleanup',
      'AI follow-up assistant',
    ],
    heroDescription:
      'Your reps are great on the phone and terrible at the keyboard. Duet is AI for sales teams that closes the admin gap — it enriches every inbound lead, prepares the outbound sequence for review, keeps Salesforce current, and drafts the follow-up the rep forgot. They sell. Duet handles the admin loop under your rules, and the pipeline stays believable on a Monday.',
    definition:
      'An AI coworker for sales teams is a persistent, cloud-based AI teammate that owns the work between meetings — account research, list building, enrichment, draft outreach, CRM hygiene, and pipeline briefs. It runs on your data and in your tone, keeps the CRM honest, and prepares the next move under your review rules so reps spend their hours in conversations, not in tabs.',
    painCards: [
      {
        title: 'Inbound leads sit unqualified',
        quote: '"By the time we research them, they\'ve gone cold."',
        body: 'Duet enriches every inbound the moment it lands — company size, stack, funding signals, recent LinkedIn posts — and pushes a one-pager to the rep with the suggested opening. The lead is research-ready before the prep call that used to come first.',
      },
      {
        title: 'Outbound is a copy-paste job',
        quote: '"My SDRs lose too much time in spreadsheets, not on the phone."',
        body: "Duet coordinates the outbound sequence: pulls the list, personalizes each email, queues approved sends in your sequencing tool, and logs replies in the CRM. The SDR's job stops being the spreadsheet and goes back to being the conversation that actually creates a meeting opportunity.",
      },
      {
        title: 'CRM hygiene is a fairy tale',
        quote: '"Half the deals in pipeline have stage dates from last quarter."',
        body: 'Duet reads every meeting transcript and email thread, updates stages, fills missing fields, and flags deals that have gone quiet for review. The pipeline meeting opens with the truth, not with the version your team had time to type after the last call.',
      },
    ],
    useCases: [
      {
        id: 'enrichment',
        title: 'Enrich inbound leads as they arrive',
        prompt:
          'Every new HubSpot lead: pull company size from Crunchbase, tech stack from BuiltWith, and recent LinkedIn posts. Drop a one-pager in their record and Slack the AE.',
        outcome: 'Inbound leads enriched without copy-paste',
      },
      {
        id: 'outbound',
        title: 'Run outbound email sequences with review rules',
        prompt:
          "Pull Series A SaaS CFOs from /lists/q4-cfo.csv. Personalize the sequence from /sequences/cfo-v3.md using each company's latest funding round. Queue it for review before approval in our sending tool.",
        outcome: 'Personalized outbound queued without copy-paste',
      },
      {
        id: 'crm',
        title: 'Keep the CRM clean and current',
        prompt:
          'On a weekly cadence, read recent Gong calls, update deal stages in Salesforce, fill missing decision-maker fields, and flag deals with stale activity.',
        outcome: 'Pipeline you can actually trust',
      },
      {
        id: 'followup',
        title: 'Automate post-meeting follow-ups',
        prompt:
          "When a tldv call ends, draft a follow-up email in the rep's voice that recaps the call, restates the next step, and attaches the relevant case study from /case-studies.",
        outcome: "Follow-up draft ready before they're back at their desk",
      },
    ],
    comparison: {
      without: [
        'SDRs losing large chunks of the day to research and data entry.',
        'Sequences sent in batches because personalization is tedious.',
        'A CRM that drifts out of date between pipeline reviews.',
        'Follow-ups that go out late, or never.',
      ],
      with: [
        'Reps on the phone. Duet doing the typing.',
        'Outbound sequences personalized at the company level, sent on cadence.',
        'A CRM that updates itself from calls, emails, and meetings.',
        'Follow-ups drafted while the meeting context is still fresh.',
      ],
    },
    howItWorks: [
      {
        step: 1,
        title: 'Connect the revenue stack',
        body: 'Plug Duet into HubSpot or Salesforce, your email, Gong/tldv, and your enrichment APIs. It indexes your pipeline, your templates, and your past wins — so the next email it drafts sounds like the one that actually closed last quarter.',
      },
      {
        step: 2,
        title: 'Hand off the repetitive plays',
        body: 'Tell Duet which plays to run: inbound enrichment, outbound sequence, CRM cleanup, follow-up. Each one runs on event or schedule — no rep intervention needed — and the rep keeps a real-time view of what fired, what landed, and what needs them.',
      },
      {
        step: 3,
        title: 'Reps approve the high-stakes stuff',
        body: 'Duet drafts; reps approve outbound copy, escalations, and exec emails before send. Everything else just happens, with an audit log of every send, every CRM update, and every customer touch the AI made on the team’s behalf.',
      },
    ],
    faqs: [
      {
        q: 'Does Duet replace SDRs?',
        a: "No — it handles the parts of the SDR day that don't require a human. Reps still own the conversation, the discovery question, and the close. Duet owns the prep, the typing, and the admin work reps complain about most.",
      },
      {
        q: 'Will it work with our existing CRM?',
        a: 'Duet can connect to CRMs through managed integrations, APIs, CSV, or custom wiring depending on the tool. HubSpot, Salesforce, Pipedrive, Attio, and Close-style workflows should be scoped against the fields and permissions your team wants Duet to touch.',
      },
      {
        q: 'How do you prevent it from sending bad emails?',
        a: 'You set the approval rules. Drafts can stage for rep review, send through connected tools only after approval or under an explicit narrow repeat rule, or never send automatically. A safer rollout keeps everything in review first, then loosens the rules only where the risk is low.',
      },
      {
        q: 'How does Duet learn our voice?',
        a: "Show it real sent emails and a handful of wins. It adopts cadence, vocabulary, and signoff style. As you correct drafts, it gets closer to the rep's voice. The same voice carries across follow-ups, sequences, and inbound replies, so the prospect's inbox feels consistent.",
      },
      {
        q: 'Is it compliant for regulated industries?',
        a: "Workspaces are isolated, data is scoped to your org, and outbound sending honors CAN-SPAM and your suppression lists. Talk to us about specific compliance frameworks (SOC2, HIPAA-aligned setups) — we'll walk through what's in place today and what's on the roadmap.",
      },
      {
        q: "What about deliverability — won't AI-sent email get spam-flagged?",
        a: "Duet sends from your domain, through your warmed-up mailbox, with rate limits that mirror a human SDR's pace. No bulk blasts, no spoofed senders, no fingerprint that screams bot. Sequences can pause when the sending tool exposes reputation or deliverability signals, then ping the rep before more email goes out; the underlying ESP integration handles SPF, DKIM, and DMARC the way your IT team already configured them.",
      },
    ],
    relatedSlugs: ['operations', 'founders'],
    leaves: [],
    lastUpdated: '2026-05-21',
  },
  {
    slug: 'operations',
    name: 'Operations teams',
    shortName: 'Operations',
    navLabel: 'Operations teams',
    eyebrow: 'For operations teams',
    h1Lead: 'AI for operations who would rather',
    h1Highlight: 'fix the system than firefight.',
    metaTitle: 'AI for Operations Teams | Automate the Boring | Duet',
    metaDescription:
      'Duet is AI for operations teams. Schedule meetings, automate documents, ship recurring reports, and triage tickets so ops fixes the system, not firefights.',
    primaryKeyword: 'AI for operations teams',
    secondaryKeywords: [
      'AI for operations',
      'operations automation',
      'AI for ops managers',
      'AI scheduling assistant',
      'AI for back office',
    ],
    heroDescription:
      "Operations is the role that absorbs everyone else's tax. Duet is AI for operations teams that wants to stop being the help desk — it runs the scheduling tetris, the document plumbing, the weekly report, and the support triage, so your ops team can finally fix the system instead of being the system.",
    definition:
      'An AI coworker for operations is a persistent, cloud-based AI teammate that handles the recurring back-office work an ops lead usually does manually — document extraction, vendor and renewal tracking, scheduling, internal reporting, and support triage. It connects to the systems you already use, remembers process context, and runs the repetitive pieces under your review rules so the ops team stops being the bottleneck.',
    painCards: [
      {
        title: 'Meeting scheduling is a full-time job',
        quote: '"Half my week is calendar Tetris."',
        body: 'Duet reads the request, checks the calendars, proposes the slot, and prepares the invite under your calendar rules. The whole back-and-forth becomes one message — and the same flow runs for renewals, QBRs, customer onboardings, and the all-hands you keep rescheduling.',
      },
      {
        title: 'Documents move by hand',
        quote: '"We literally re-type the contract into the renewal sheet."',
        body: "Duet pulls fields out of contracts, MSAs, and onboarding forms; writes them into the right systems; and flags anything that doesn't match. The data lives in one place instead of three, and renewals stop sneaking up on you because the dates were buried in a PDF.",
      },
      {
        title: 'Weekly reports drain Friday',
        quote: '"I lose too much Friday focus to one PDF."',
        body: "Duet compiles the report — metrics, summaries, charts — straight from the source systems and emails it to the distribution list on schedule. The reporting window becomes a review pass instead of a manual assembly job, and the report can still ship when you're out.",
      },
    ],
    useCases: [
      {
        id: 'scheduling',
        title: 'Schedule meetings and coordinate calendars',
        prompt:
          "Book a 30-min onboarding call between Sara (sara@example.com) and our CSM team next week. Prefer Tue/Thu afternoons in Sara's timezone. Send a calendar invite with the onboarding doc attached.",
        outcome: 'One message instead of calendar ping-pong',
      },
      {
        id: 'documents',
        title: 'Automate document workflows',
        prompt:
          'When a signed MSA lands in /contracts, extract counterparty, start date, term, and total value. Write a row to the renewals sheet and create a ticket in Linear ahead of renewal.',
        outcome: 'Renewals tracked without a human',
      },
      {
        id: 'reports',
        title: 'Ship recurring reports and dashboards',
        prompt:
          'On a weekly cadence, pull recent numbers from Mixpanel, Stripe, and HubSpot. Generate the weekly ops report PDF and email it to the leadership distro.',
        outcome: 'A cleaner Friday reporting ritual',
      },
      {
        id: 'tickets',
        title: 'Triage support tickets and inbound requests',
        prompt:
          'For every new Zendesk ticket: tag urgency, suggest the right macro reply, attach the linked customer record, and ping the on-call engineer if priority is high-priority.',
        outcome: 'Urgent tickets escalated clearly',
      },
    ],
    comparison: {
      without: [
        'Ops team buried in calendar threads and inbox triage.',
        'Contract data re-typed into 3 different systems.',
        'Focus lost to one report. Then another report.',
        'Tickets stack up; SLA breaches show up in QBRs.',
      ],
      with: [
        'Scheduling, intake, and routing handled by Duet.',
        'Document data flows into systems of record under your routing rules.',
        'Reports compiled, formatted, and delivered on schedule.',
        'Tickets triaged quickly, escalations clearly flagged.',
      ],
    },
    howItWorks: [
      {
        step: 1,
        title: 'Map the workflows',
        body: "Walk Duet through the workflows that eat your week: scheduling rules, document templates, report formats, ticket SLAs. Save each one as a reusable playbook in workspace Files so the next person on the ops team doesn't have to re-explain the system from scratch.",
      },
      {
        step: 2,
        title: 'Wire up the systems',
        body: 'Connect calendars, Drive, Notion, Slack, Linear, Zendesk, your data warehouse. Duet reads, writes, and triggers across the stack through scoped permissions, and workflows can reuse a connection once it is wired in.',
      },
      {
        step: 3,
        title: 'Run on schedule, on event, on demand',
        body: 'Workflows fire on cron (the weekly report), on event (a contract lands), or on demand (someone asks in Slack). You see what ran and what needs a human in a single feed — no hunting through five different tool logs.',
      },
    ],
    faqs: [
      {
        q: 'How is this different from Zapier or Make?',
        a: "Zapier and Make are deterministic plumbing — if X then Y. Duet handles the steps in between that need judgment: parsing an unfamiliar contract, writing a customer email, deciding which playbook applies. It uses Zapier-style triggers where they fit and reasons through the parts that don't.",
      },
      {
        q: 'Can it write to our systems of record?',
        a: 'Duet can connect to ops stacks through managed integrations, APIs, CSV exports, or custom wiring depending on the system. Google Workspace, Notion, Linear, Asana, Jira, Zendesk, HubSpot, Salesforce, Snowflake, and BigQuery-style workflows should be scoped by permissions, fields, and approval rules before write access is enabled.',
      },
      {
        q: 'How do we keep approval gates where they matter?',
        a: 'You define them per workflow. Anything Duet writes externally (emails, customer-facing messages, contract changes) can route through a human approval step before it goes out. Low-risk internal updates — moving a ticket, updating a CRM field — can run without manual review when you choose; sensitive writes can stay reviewed.',
      },
      {
        q: 'What if a workflow breaks?',
        a: 'Duet logs every run and surfaces failures. You can replay a failed run, edit the workflow in plain English, and re-run — no need to dig into integration logs. The error tells you which step failed and what it was trying to do in human terms.',
      },
      {
        q: 'How long until we see time back?',
        a: 'Duet is designed to reduce the recurring coordination work that eats ops calendars. The wins are concentrated on recurring workflows you run — scheduling and recurring reports are common starting points, with document workflows landing after Duet has seen enough variants of the inbound formats.',
      },
      {
        q: 'Does it replace our ops manager?',
        a: "No. Ops managers design the system; Duet runs it. The job shape changes — less keyboard time, more time on the workflows you used to skip because they took too long to wire up. Ops teams use Duet to take on a function they couldn't staff for, and reframe the role from coordinator to system designer.",
      },
    ],
    relatedSlugs: ['sales-teams', 'small-businesses'],
    leaves: [],
    lastUpdated: '2026-05-21',
  },
]

export type UseCaseJobStep = {
  /** 1-indexed; renders as the HowToStep position. */
  step: number
  /** Short imperative — "Connect your support inbox". */
  title: string
  /** 1-3 sentences. The body of the HowToStep. */
  body: string
}

/** A by-job page node — the cross-axis sibling of `UseCasePersonaLeaf`.
 *
 * Copy rules:
 * - `title` and `h1` are keyword-shaped ("AI for customer support"),
 *   not clever positioning lines.
 * - `jobSteps` is the actual workflow — Google's HowTo schema only
 *   carries weight when the steps are honest, so no "step 1: sign
 *   up" filler.
 * - `faqs` answers stay plain text (no markdown links) because the
 *   strings ship into FAQPage JSON-LD verbatim.
 * - `relatedPersonas` is an array of persona slugs that map back into
 *   the persona axis — the "works for these roles" rail at the bottom
 *   of the by-job page.
 * - `relatedLeaves` is an array of `<persona>/<leaf>` strings pointing
 *   at the closest-fit persona-leaf pages (cross-axis internal links).
 */
export type UseCaseJob = {
  /** URL slug under /use-cases/by-job/. Keep stable. */
  slug: string
  /** Display title — used in the by-job index grid and the H2
   * eyebrow on the job page. */
  title: string
  /** Long-form H1 on the job page. Long-tail keyword phrasing. */
  h1: string
  /** <= 60 chars meta title. */
  metaTitle: string
  /** 140-160 chars meta description. */
  metaDescription: string
  /** 1-3 sentence lede under the H1, also used as the card blurb on
   * the by-job index grid. */
  intro: string
  /** 5-7 steps — the HowTo schema bait. */
  jobSteps: UseCaseJobStep[]
  /** 5+ Q&A pairs — job-specific objection handling. */
  faqs: UseCasePersonaFaq[]
  /** Persona slugs this job fits — drives the "works for these
   * personas" rail on the by-job page. */
  relatedPersonas: string[]
  /** Cross-axis links into specific persona leaves, encoded as
   * '<persona>/<leaf>' strings. Empty array is fine — the rail just
   * skips when there's nothing relevant to point at. */
  relatedLeaves: string[]
  /** ISO date (YYYY-MM-DD) of the job's last meaningful content
   * edit. Surfaced as `<lastmod>` in the sitemap so the freshness
   * signal doesn't oscillate every build. */
  lastUpdated: string
}

const EN_USE_CASE_JOBS: UseCaseJob[] = [
  {
    slug: 'customer-support',
    title: 'Customer support',
    h1: 'Hand customer support to an AI coworker',
    metaTitle: 'AI for Customer Support | Triage and Draft | Duet',
    metaDescription:
      'Duet drafts, triages, escalates, and prepares support replies for review, keeping routine tickets moving under your approval rules.',
    intro:
      'Customer support is where small businesses bleed time. Duet is an AI coworker that drafts, triages, escalates, and prepares replies for review, then keeps routine tickets moving under your approval rules. The inbox is prepared before you sit down in the morning — not a graveyard by Friday.',
    jobSteps: [
      {
        step: 1,
        title: 'Connect your support inbox and help docs',
        body: 'Point Duet at support@ (Gmail, Help Scout, Gorgias, Zendesk, Intercom, or plain IMAP) and at your help center, FAQ pages, and refund policy. Duet ingests recent tickets and your knowledge base so its first reply already sounds like you.',
      },
      {
        step: 2,
        title: 'Teach it your voice with the real replies',
        body: 'Drop in real replies you sent — the messy ones, the long ones, the short ones — so Duet learns tone, signature, default refund stance, and the phrases you use when something has gone wrong. The rest of the playbook inherits from those examples.',
      },
      {
        step: 3,
        title: 'Set the escalation rules',
        body: 'Tell Duet what you want to see yourself: high-value refund requests, churn risk, anything mentioning a lawyer, anything from a strategic customer. Everything else is drafted into send-as-is or review queues based on your confidence threshold.',
      },
      {
        step: 4,
        title: 'Let it triage every new ticket',
        body: 'New tickets land, Duet classifies them in seconds, drafts a reply, attaches the relevant help-doc link, and tags the ticket. You see a clean queue with three buckets: send-as-is, edit-and-send, and needs-me.',
      },
      {
        step: 5,
        title: 'Prepare approved responses for easy ones',
        body: 'Password resets, order-status checks, invoice copies, refund acknowledgments — Duet prepares or routes responses through the connected helpdesk after approval or under explicit rules, logs the action, and keeps the ticket moving. The customer gets a fast, useful answer instead of waiting for a Monday-morning reply.',
      },
      {
        step: 6,
        title: 'Get a recurring support brief',
        body: "On a weekly cadence, Duet drops a one-paragraph brief in your inbox: tickets handled, top three themes, anything escalated waiting on you, and what changed about your customers' questions this week.",
      },
    ],
    faqs: [
      {
        q: 'Will it actually sound like me, or will customers spot the bot?',
        a: 'Duet reads approved examples of your recent replies inside your workspace, so it can use your sign-off, your apologies, your refund stance, and the specific phrases you use when something has gone wrong as context. The goal is for routine replies to sound close enough that the first review pass is about small corrections, not rewriting from scratch.',
      },
      {
        q: 'What happens when a customer is angry or the ticket is sensitive?',
        a: 'You set the escalation rules. Refund requests over a threshold, churn risk, anything mentioning legal action, anything from a top customer — Duet flags them, drafts an empathetic holding reply, and routes the ticket to the queue you watch yourself. The risky ones never get sent without you.',
      },
      {
        q: 'Which inboxes and helpdesks does it work with?',
        a: 'Duet can connect to inboxes and helpdesks through managed integrations, APIs, IMAP, CSV, or custom wiring depending on the vendor. For Gmail, Outlook, Help Scout, Gorgias, Zendesk, Intercom, Front, Freshdesk, and Crisp-style workflows, scope the exact read, draft, and write-back permissions during setup.',
      },
      {
        q: 'How long until tickets are actually being handled, not just drafted?',
        a: 'Teams should move from drafted-for-review to explicitly enabled sends category by category. The safest path is to start with one well-defined bucket — order status or password resets — enable narrow send rules once the drafts look right, then expand from there.',
      },
      {
        q: 'What does it cost compared to a support agent or a helpdesk add-on?',
        a: 'A part-time support contractor and helpdesk AI add-ons can both become meaningful line items. Duet offers monthly plans with included credits and a paid reserve for overage; compare the current plan with your ticket volume.',
      },
      {
        q: 'Does Duet replace my support team?',
        a: "No. Duet handles the repeatable volume so your team can focus on conversations that actually need a human. Status checks, resets, and refund acknowledgments can move out of the queue; judgment-heavy tickets land on a human's desk faster, with more context, and without a backlog in front of them.",
      },
    ],
    relatedPersonas: ['small-businesses', 'agencies', 'operations'],
    relatedLeaves: ['small-businesses/shopify-store'],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'sales-outbound',
    title: 'Sales & outbound',
    h1: 'Run sales outbound with an AI coworker',
    metaTitle: 'AI for Sales Outbound | Prospect, Draft, Review | Duet',
    metaDescription:
      'Duet finds prospects, enriches leads, drafts first touches, follows up, and logs replies from one AI coworker workspace.',
    intro:
      'Outbound is the job small teams skip because it eats the week. Duet is an AI coworker that coordinates outbound workflows from prospecting through reply logging: building your prospect list, enriching leads, drafting first touches in your voice, and running the pipeline admin loop without you babysitting it. Sales motion that compounds, without hiring an SDR.',
    jobSteps: [
      {
        step: 1,
        title: 'Define your ICP in one paragraph',
        body: 'Describe who you sell to in plain English — industry, headcount, geography, the trigger that makes them ready to buy. Duet turns that into a structured filter you can re-run any time without touching a CRM screen.',
      },
      {
        step: 2,
        title: 'Build the prospect list',
        body: 'Duet pulls matching accounts from Crustdata, Apollo, Clay, or LinkedIn Sales Navigator (whichever you already pay for), enriches each contact with email + title + tenure, and dedupes against your CRM so you never email the same person twice.',
      },
      {
        step: 3,
        title: 'Pick the trigger that makes the touch relevant',
        body: "Recent funding round, new hire on the team, a job posting, a stack change — Duet watches the signals you care about and only lines up outreach when there's a real reason to email today, not just a list with a SEND button.",
      },
      {
        step: 4,
        title: 'Write the first touch in your voice',
        body: 'Duet drafts a concise email tied to the trigger, references one specific thing about the prospect, and signs off in your voice. You review the first batch in a side-by-side; approved drafts can be pushed to your sending tool, while risky or new-pattern drafts stay in review.',
      },
      {
        step: 5,
        title: 'Prepare the cadence for your sending tool',
        body: 'Duet prepares the cadence for Instantly, Smartlead, Lemlist, or Gmail where connected; your sending tool handles warm-up, throttling, and domain rules.',
      },
      {
        step: 6,
        title: 'Handle replies the same way it triages support',
        body: "Positive reply, meeting-booked, not-the-right-person, soft-no, unsubscribe — Duet classifies every reply, drafts the right next step, and prepares a booking link or calendar hold for review. Nothing falls through the cracks because the inbox isn't where pipeline goes to die.",
      },
      {
        step: 7,
        title: 'Get a weekly pipeline brief',
        body: 'On a weekly cadence, Duet sends a snapshot: replies this week, meetings booked, top patterns by reply (industry, persona, trigger), and which campaign to double down on. The next move is obvious, not buried in a sprawling dashboard.',
      },
    ],
    faqs: [
      {
        q: 'Is this just another "AI cold email" tool?',
        a: 'No. Duet is built for the full loop — ICP filter, list building, enrichment, trigger detection, drafting, sending, reply classification, follow-up — on one workspace with one coworker that remembers everything. Point cold-email tools are strongest at the drafting or sequencing step; Duet is for connecting the steps around them.',
      },
      {
        q: 'How does it avoid spam folders and the deliverability disaster every founder runs into?',
        a: "Duet hands the actual sending to your existing tool — Instantly, Smartlead, Lemlist — which already handles warm-up, domain rotation, and per-inbox throttling. Duet's job is the upstream work that makes deliverability matter: smaller, more relevant lists, one trigger per send, and copy that doesn't look like a generic blast sent the same week.",
      },
      {
        q: 'Will it write meeting-worthy copy?',
        a: "Meeting-worthy copy is short, specific, and trigger-aware — Duet writes to that pattern because it's reading the trigger, the prospect's last role move, and your best replies from recent history. It's not a generic personalization variable; the email actually references the thing that made the prospect worth emailing.",
      },
      {
        q: 'How does it integrate with my CRM?',
        a: 'Duet can connect to CRM workflows through managed integrations, APIs, CSV, or custom wiring depending on the system. For HubSpot, Salesforce, Attio, Pipedrive, Folk, or Notion-as-CRM, scope the exact read, write-back, dedupe, and lifecycle-stage permissions before a campaign runs.',
      },
      {
        q: 'What does it cost compared to hiring an SDR?',
        a: 'Hiring an SDR is a major fixed-cost bet, whether in-house or offshore. Duet offers monthly plans with included credits, making outbound research, drafting, and CRM updates easier to test before you commit to headcount.',
      },
      {
        q: 'Will the outreach feel automated?',
        a: 'Only if you let it. Duet writes to your tone, references the specific trigger, and limits send volume to what a careful human SDR would do in a week. The point is to preserve the research quality and specificity of hand-written outreach while removing the repetitive drafting and CRM work.',
      },
    ],
    relatedPersonas: ['sales-teams', 'founders', 'agencies'],
    relatedLeaves: [],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'inbox-triage',
    title: 'Inbox triage',
    h1: 'Triage your inbox with an AI coworker',
    metaTitle: 'AI Inbox Triage | Read, Draft, Escalate | Duet',
    metaDescription:
      'Duet triages shared inboxes, summarizes the day, drafts replies in your voice, flags urgent threads, and follows your approval rules.',
    intro:
      "You don't have an email problem — you have an attention problem dressed as an email problem. Duet is an AI coworker that reads new messages on a schedule, drafts replies in your voice, flags the ones that actually need you, and clears the rest. The inbox is prepared before review.",
    jobSteps: [
      {
        step: 1,
        title: 'Connect your inbox',
        body: 'Gmail, Outlook, or plain IMAP. Duet authenticates via OAuth, reads recent messages, and uses the sender and thread patterns you approve to separate urgent conversations from noise.',
      },
      {
        step: 2,
        title: 'Teach it your priorities in plain English',
        body: '"Customers always, vendors next, newsletters low priority, billing urgent." One paragraph is enough; Duet turns it into the rule set that decides what lands on your desk and what does not.',
      },
      {
        step: 3,
        title: 'Schedule the overnight pass',
        body: 'While you sleep, Duet reads every new thread, drafts replies for the ones that need them, labels likely noise for batch review, and labels the rest by intent — sales, support, billing, recruiting, personal — using the same buckets your real workflow already runs on.',
      },
      {
        step: 4,
        title: 'Wake up to a triaged queue, not an unread pile',
        body: 'Your inbox opens to three things: a one-paragraph brief at the top, a small "needs you" list, and a folder of drafted replies waiting for a single approval click. Everything else is queued, labeled, or prepared for review under your rules.',
      },
      {
        step: 5,
        title: 'Approve drafts in a single sweep',
        body: "Click through the drafts queue — accept, edit, reject. Duet remembers every edit so the next batch needs less correction, and the rejections train the rules so it stops drafting the kinds of replies you don't actually want sent.",
      },
      {
        step: 6,
        title: 'Get a Friday-afternoon recap',
        body: 'On a weekly cadence, Duet sends a recap: top senders this week, what changed (more recruiter spam, fewer customer questions), threads you marked important but never replied to, and the open loops worth closing before Monday.',
      },
    ],
    faqs: [
      {
        q: 'Is it safe to give an AI access to my inbox?',
        a: "Duet authenticates through standard OAuth — the same flow Gmail and Outlook use for any third-party app — and runs in its own private cloud server, not a shared model. Your messages aren't training a foundation model and aren't pooled with other customers' data. The audit log shows every read, draft, and send so you can see exactly what Duet has touched.",
      },
      {
        q: 'What if it drafts the wrong reply on a sensitive thread?',
        a: 'You set the rule. By default, anything you mark as personal, anything involving money over a threshold, and anything tagged "sensitive" gets a draft but never an automatic send — the reply waits for you. As you train it on your edits, you can raise the confidence threshold for explicitly enabled send categories while keeping it low on risky ones.',
      },
      {
        q: "How is this different from Gmail's built-in smart reply?",
        a: "Smart reply suggests three short sentences; Duet writes the whole reply, references the thread context, references prior threads with the same person, and decides whether to draft, escalate, or use an explicitly enabled send rule. The job isn't to suggest one sentence faster — it's to make the inbox need you less for repeatable work.",
      },
      {
        q: 'Can my whole team use this on a shared inbox like support@ or sales@?',
        a: "Yes. Duet runs on shared inboxes the same way it runs on personal ones — reads, drafts, escalates, and follows the send rules you explicitly enable — and you can set the rules per inbox. A common setup is support@ with narrow approval rules for easy categories and sales@ in draft-and-review mode while the team is still learning what Duet's first touches read like.",
      },
      {
        q: 'How much email volume is too much for Duet?',
        a: 'Duet is designed for high-volume inbox triage because the heavy lifting — classification and drafting — runs on the same sandbox infrastructure that powers the rest of the workspace. In practice, approval policy and review capacity are often the bottlenecks to plan around.',
      },
      {
        q: 'Does it work in languages other than English?',
        a: 'Yes. Duet drafts replies in the language the original message used, and you can set per-rule language preferences ("reply to French customers in French, everything else in English"). The triage classifier is multilingual; the drafts inherit the tone of your past replies in that language.',
      },
    ],
    relatedPersonas: ['small-businesses', 'founders', 'operations'],
    relatedLeaves: [],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'content-marketing',
    title: 'Content marketing',
    h1: 'Run content marketing with an AI coworker',
    metaTitle: 'AI for Content Marketing | Research, Draft, Ship | Duet',
    metaDescription:
      'Duet researches topics, drafts posts in your voice, schedules channels, repurposes wins, and reports back on what worked.',
    intro:
      "Many SMBs ship content like a side project — when somebody finally has time this quarter. Duet is an AI coworker that runs content like a function: researches what's working, drafts in your voice, schedules across channels, repurposes the wins, and reports back on what landed. The flywheel finally spins.",
    jobSteps: [
      {
        step: 1,
        title: 'Define the topics you want to own',
        body: 'Tell Duet the three or four themes your business should rank for and the audiences you write to. It builds a topic map, maps each theme to the customer pains it solves, and pulls the keywords that match — no SEO consultant required.',
      },
      {
        step: 2,
        title: 'Research the angle worth writing',
        body: 'For each topic, Duet pulls what already ranks, what AI overviews currently cite, and what the competitive content gets wrong. You get a one-page brief with a clear angle, a target keyword, an outline, and the three sources worth referencing.',
      },
      {
        step: 3,
        title: 'Draft the post in your voice',
        body: "Duet writes a long-form draft using your existing blog as the voice reference, with proper structure (clear section headings, FAQ block, lede paragraph) and SEO basics built in (meta title, description, JSON-LD). It's a real draft an editor can ship, not a first pass that needs to be rewritten.",
      },
      {
        step: 4,
        title: 'Prepare the CMS draft or PR',
        body: 'WordPress, Webflow, Ghost, Sanity, Contentful, or Markdown to GitHub — Duet can prepare a CMS draft or PR through the integration path you enable, with social-share images ready for review. Internal-link suggestions land in the same PR / draft so the article ships with the link graph it needs.',
      },
      {
        step: 5,
        title: 'Repurpose across LinkedIn, X, and the newsletter',
        body: "Every long-form post becomes a LinkedIn carousel, an X thread, two replies into existing conversations, and a section of the next newsletter. Duet writes each variant to the channel's actual norms — not a single message reposted five times.",
      },
      {
        step: 6,
        title: 'Track what worked and double down',
        body: 'Duet pulls GSC, Plausible, GA4, and the social platforms once a week, identifies the posts that picked up traffic or replies, and proposes the next three articles based on what readers are actually engaging with — not what looked clever in the brainstorm.',
      },
    ],
    faqs: [
      {
        q: 'Will the writing sound like AI slop?',
        a: 'Not if Duet has your blog and your social as voice references. The drafts pick up sentence rhythm, the way you transition between sections, your tic of using em-dashes or short paragraphs — the small choices that make a piece sound like a person, not a template. The editor pass is real editing, not rewriting from scratch.',
      },
      {
        q: 'How do I make sure the SEO actually works?',
        a: "Every draft ships with the basics Google now expects on a content piece: a real H1, semantic H2s, a structured FAQ block with FAQPage JSON-LD, internal links to relevant pages, and meta tags that match the body. Duet won't manufacture rankings on a stale keyword — it researches what's currently winning before drafting.",
      },
      {
        q: 'Can it write for AI overviews / ChatGPT search / Perplexity, not just Google?',
        a: "Yes. The brief step looks at what AI overviews already cite for the target query and writes the angle to be cited too — short summary up top, plain factual statements with citations, FAQ block with crisp answers. The same structure Google rewards is the structure AI search rewards, so you're not splitting effort across two strategies.",
      },
      {
        q: 'Which CMSes can it prepare drafts for?',
        a: 'Duet can prepare CMS drafts, exports, or PRs through integrations, APIs, Git-based workflows, exports, or custom wiring depending on the CMS. For WordPress, Webflow, Ghost, Sanity, Contentful, Strapi, Notion, Hashnode, dev.to, or Markdown-to-GitHub workflows, scope draft/PR permissions before enabling any publishing path that writes live.',
      },
      {
        q: 'How much content can it ship per week?',
        a: 'A sustainable SMB cadence is a focused long-form post plus repurposing into the channels your audience actually reads. You can increase volume later, but the wins come from compounding the same topic cluster, not from publishing more for its own sake.',
      },
      {
        q: 'Does it replace a content marketer?',
        a: "No. It handles the work nobody on the team has time to do. A content marketer designs the strategy, picks the topics, and reviews the drafts; Duet does the research, the drafting, the publishing, and the repurposing. The marketer's output goes from one post a month to a content function that runs on a calendar.",
      },
    ],
    relatedPersonas: ['agencies', 'founders', 'small-businesses'],
    relatedLeaves: [],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'bookkeeping',
    title: 'Bookkeeping',
    h1: 'Run bookkeeping with an AI coworker',
    metaTitle: 'AI for Bookkeeping | Reconcile, Flag, Report | Duet',
    metaDescription:
      'Duet runs bookkeeping ops for lean teams — categorizes transactions, reconciles accounts, flags anomalies, and sends clean monthly reports.',
    intro:
      'Bookkeeping should not eat the same founder hours every month. Duet connects to the tools you already use, categorizes transactions, reconciles the obvious matches, flags the weird ones, and gives you a clean monthly packet to review or send to your finance partner. You stay lean without letting the books drift.',
    jobSteps: [
      {
        step: 1,
        title: 'Connect your accounting stack',
        body: 'Connect QuickBooks, Xero, Stripe, Plaid, Mercury, Ramp, or the CSV exports you already pull. Duet reads the chart of accounts, vendor history, customer names, and prior reconciliations before touching new transactions.',
      },
      {
        step: 2,
        title: 'Teach the categorization rules',
        body: 'Explain the edge cases once: software goes to subscriptions, contractors go to cost of goods sold, client meals get split, founder reimbursements need receipts. Duet turns that into reusable rules instead of asking the same question every month.',
      },
      {
        step: 3,
        title: 'Categorize and match transactions',
        body: 'New transactions are categorized against the rule set, matched to invoices or receipts, and marked with confidence. High-confidence items are queued for batch approval; low-confidence items get a short note explaining what Duet needs from you.',
      },
      {
        step: 4,
        title: 'Reconcile the easy accounts',
        body: 'Duet compares bank, card, Stripe, and accounting balances, resolves obvious timing differences, and produces a reconciliation checklist. The goal is not to pretend accounting judgment disappeared — it is to turn human review into a focused check instead of a manual rebuild.',
      },
      {
        step: 5,
        title: 'Flag anomalies before they become urgent',
        body: 'Duplicate subscriptions, unusual vendor spend, missing receipts, late deposits, uncategorized transfers, and margin swings get surfaced as exceptions. You see the handful of weird things, not every line item.',
      },
      {
        step: 6,
        title: 'Send the monthly packet',
        body: 'At month end, Duet prepares a concise packet: P&L, cash movement, unresolved questions, anomalies, and the files your finance partner needs. The books become a running system, not a quarterly archaeology project.',
      },
    ],
    faqs: [
      {
        q: 'Does Duet replace my finance partner?',
        a: 'No. Duet does the repeatable bookkeeping ops so your finance partner can review cleaner work and focus on judgment, taxes, and advice. Small teams can use Duet to prepare the month-end packet while keeping a human reviewer for sign-off.',
      },
      {
        q: 'Can it write directly into QuickBooks or Xero?',
        a: 'Duet can connect to QuickBooks or Xero through available APIs, exports, or custom wiring with scoped permissions. Start in review mode, then allow high-confidence categories to post under your rules only once the setup has proven itself.',
      },
      {
        q: 'How does Duet handle weird transactions?',
        a: 'Anything below the confidence threshold becomes an exception with a short explanation and the source documents attached. Duet does not bury ambiguity inside a category; it asks the human once, remembers the answer, and applies the rule next time.',
      },
      {
        q: 'Is this useful if I already have a bookkeeper?',
        a: 'Yes. Duet reduces the back-and-forth that makes bookkeeping expensive: receipt chasing, vendor explanations, export cleanup, and monthly packet prep. Your bookkeeper gets cleaner inputs and fewer mystery rows.',
      },
      {
        q: 'What accounting tools does it support?',
        a: 'Duet can connect to accounting workflows through APIs, exports, Plaid-connected data, CSV, or custom wiring depending on the tool. For QuickBooks, Xero, Stripe, Mercury, Ramp, Brex, and bank data, scope access before enabling writes.',
      },
      {
        q: 'Will Duet move money or approve payments?',
        a: 'Not by default. Duet can prepare invoices, categorize expenses, and draft payment reminders, but money movement stays behind explicit approval unless you set a narrow trusted rule for it.',
      },
    ],
    relatedPersonas: ['small-businesses', 'founders', 'operations'],
    relatedLeaves: ['small-businesses/service-business-owner'],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'seo',
    title: 'SEO operations',
    h1: 'Run SEO operations with an AI coworker',
    metaTitle: 'AI for SEO Operations | Audit, Link, Report | Duet',
    metaDescription:
      'Duet runs SEO operations for lean teams — audits pages, finds keyword gaps, updates internal links, monitors rankings, and reports what changed.',
    intro:
      'SEO is not one magical blog post. It is a weekly operating cadence: find the gaps, fix the pages, add the links, watch the results, repeat. Duet turns that cadence into an always-on coworker so a small business can build search momentum without hiring an agency retainer.',
    jobSteps: [
      {
        step: 1,
        title: 'Map the pages you already have',
        body: 'Duet crawls your site, reads titles, descriptions, headings, schema, internal links, and indexability. The first output is a clean map of what exists and which pages are actually capable of ranking.',
      },
      {
        step: 2,
        title: 'Find keyword gaps worth owning',
        body: 'Duet pulls Search Console, competitor pages, and keyword data, then filters for topics a lean team can realistically win. You get a short list of pages to create or update, not a thousand-row keyword dump.',
      },
      {
        step: 3,
        title: 'Rewrite the pages that are close',
        body: 'For pages already near page one, Duet updates the meta, headings, FAQ block, schema, and missing sections in a branch or CMS draft. It preserves your voice and fixes the boring technical pieces humans avoid.',
      },
      {
        step: 4,
        title: 'Repair the internal link graph',
        body: 'Duet finds orphan pages, thin hubs, and missing links from high-authority pages. It proposes exact anchor text and destinations so the site starts behaving like a deliberate tree instead of a pile of posts.',
      },
      {
        step: 5,
        title: 'Monitor rankings and AI citations',
        body: 'Every week, Duet checks search impressions, clicks, query movement, and AI overview citation opportunities. The report focuses on what changed and what action to take next, not dashboard screenshots.',
      },
      {
        step: 6,
        title: 'Ship one compounding improvement every week',
        body: 'New FAQ, refreshed title, stronger comparison section, missing schema, better internal link, new leaf page — Duet keeps the crawl moving. SEO becomes an operating rhythm a small team can actually maintain.',
      },
    ],
    faqs: [
      {
        q: 'Is Duet an SEO agency replacement?',
        a: 'For weekly operating work — audits, updates, link fixes, reports, and content briefs — Duet can cover a lot of what small businesses outsource. A specialist is still useful for strategy, migration planning, and high-stakes technical calls.',
      },
      {
        q: 'Can Duet update my site directly?',
        a: 'Yes. Duet can open a pull request for code-based sites or draft changes in WordPress, Webflow, Ghost, Sanity, Contentful, or another CMS. You choose whether it publishes directly or waits for review.',
      },
      {
        q: 'How does it avoid generic SEO content?',
        a: 'Duet starts from your actual product, customers, and existing pages. It writes specific sections, FAQs, and internal links based on what your site can credibly answer, rather than producing interchangeable keyword sludge.',
      },
      {
        q: 'Does it help with Google AI Overviews and answer engines?',
        a: 'Yes. Duet looks for definitional sections, citation-friendly summaries, FAQ schema, and missing structured answers. The same content that is clear for humans is easier for AI search systems to quote.',
      },
      {
        q: 'How soon will SEO results show up?',
        a: 'Technical fixes and internal links can move impressions after focused fixes, but durable rankings depend on search demand and competition. Duet is useful because it keeps shipping the small improvements every week instead of letting SEO become a quarterly panic.',
      },
      {
        q: 'What data sources does it use?',
        a: 'Search Console, analytics, sitemap data, crawler output, competitor pages, keyword providers, and the site itself. Duet turns those inputs into a prioritized worklist and then executes the work.',
      },
    ],
    relatedPersonas: ['small-businesses', 'agencies', 'founders'],
    relatedLeaves: ['small-businesses/shopify-store'],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'newsletter',
    title: 'Newsletter operations',
    h1: 'Run your newsletter with an AI coworker',
    metaTitle: 'AI for Newsletters | Draft, Send, Learn | Duet',
    metaDescription:
      'Duet gathers updates, drafts newsletters in your voice, prepares broadcasts for approval, and reports what worked after each campaign.',
    intro:
      'A newsletter should be a distribution engine, not a monthly guilt trip. Duet gathers the week of product updates, customer wins, posts, and metrics, turns them into a tight email in your voice, prepares the broadcast in your provider, and closes the loop with what readers actually clicked after the campaign is sent.',
    jobSteps: [
      {
        step: 1,
        title: 'Connect the sources of truth',
        body: 'Duet reads the places your updates already live: GitHub, Linear, Notion, Slack, blog drafts, product analytics, and the last few newsletters. It builds the raw material without asking someone to paste a recap into a doc.',
      },
      {
        step: 2,
        title: 'Pick the angle for the week',
        body: 'Duet clusters the updates into themes and proposes the strongest one: a launch, a customer story, a workflow people can copy, or a behind-the-scenes build note. The email gets a point instead of becoming a changelog.',
      },
      {
        step: 3,
        title: 'Draft in your voice and format',
        body: 'Duet writes the subject line, preview text, lede, sections, CTA, and P.S. using your prior sends as the voice reference. It also builds the HTML or Markdown to match your template.',
      },
      {
        step: 4,
        title: 'Prepare the campaign for approval',
        body: 'Duet checks the audience, suppressions, bounce history, and segment rules before approval in Resend, Customer.io, Mailchimp, ConvertKit, Loops, or your provider. The dangerous part stays reviewed.',
      },
      {
        step: 5,
        title: 'Repurpose the email into social posts',
        body: 'The finished newsletter becomes a LinkedIn post, X thread, short product update, and internal changelog. One clear angle fans out across the channels your customers already read.',
      },
      {
        step: 6,
        title: 'Report and improve the next issue',
        body: 'After the campaign is sent, Duet pulls opens, clicks, replies, unsubscribes, and bounces, then tells you what to keep, what to cut, and what topic deserves a deeper follow-up next week.',
      },
    ],
    faqs: [
      {
        q: 'Will Duet send emails without approval?',
        a: 'Not unless you explicitly allow it. A safer setup keeps final send behind approval, while letting Duet gather updates, draft the email, build HTML, check the audience, and prepare the broadcast for review.',
      },
      {
        q: 'Which email platforms does it support?',
        a: 'Duet can connect to email platforms through integrations, APIs, exports, or custom wiring depending on the provider. For Resend, Customer.io, Mailchimp, ConvertKit, Loops, HubSpot, or Markdown-export workflows, scope draft, audience, and send permissions before enabling send.',
      },
      {
        q: 'How does Duet know what happened this week?',
        a: 'It reads the systems where the work happened: commits, PRs, Linear issues, Slack threads, Notion docs, analytics, and support conversations. You get a real update, not a brainstorm from a blank page.',
      },
      {
        q: 'Can it keep our brand template consistent?',
        a: 'Yes. Duet stores the approved template, colors, footer, mobile styles, unsubscribe placement, and CTA pattern. Each new issue starts from the same system instead of being rebuilt by memory.',
      },
      {
        q: 'Can it clean or segment the list?',
        a: 'Yes. Duet can identify bounced, suppressed, inactive, high-engagement, product-user, and newsletter-only segments, then recommend who should receive a broadcast before anyone hits send.',
      },
      {
        q: 'Does it help if we only send once a month?',
        a: 'Yes, but weekly or biweekly works better because the source material is fresher. Duet makes the operating cost low enough that a lean team can send more consistently without turning the newsletter into a part-time job.',
      },
    ],
    relatedPersonas: ['founders', 'agencies', 'small-businesses'],
    relatedLeaves: [],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'invoicing',
    title: 'Invoicing & collections',
    h1: 'Run invoicing and collections with an AI coworker',
    metaTitle: 'AI for Invoicing | Send, Chase, Reconcile | Duet',
    metaDescription:
      'Duet drafts invoices, prepares reminders, follows up behind approval rules, reconciles payments, and flags overdue accounts.',
    intro:
      'Getting paid should not depend on the founder remembering to prepare a polite nudge. Duet drafts invoices from the work already done, prepares them in your accounting tool, follows up behind your approval rules, reconciles payments, and flags the accounts that need judgment. Cash collection becomes a system, not a mood.',
    jobSteps: [
      {
        step: 1,
        title: 'Connect billing, contracts, and project notes',
        body: 'Duet reads QuickBooks, Xero, Stripe, Harvest, Toggl, Notion, Linear, contracts, and project folders so it knows what was sold, what was delivered, and how the invoice should be described.',
      },
      {
        step: 2,
        title: 'Draft the invoice packet',
        body: 'For each billable milestone or recurring period, Duet drafts the invoice, line items, supporting notes, purchase-order reference, and client-facing email. You approve the packet once instead of assembling it from five tabs.',
      },
      {
        step: 3,
        title: 'Prepare invoices on the right cadence',
        body: 'Duet prepares invoices in your accounting tool with due date/payment link/tax details, then routes the packet for approval before send unless you configure a narrow repeat rule.',
      },
      {
        step: 4,
        title: 'Follow up without sounding desperate',
        body: 'Reminder, due-date nudge, overdue follow-up, escalation — Duet writes each nudge politely in your voice and references the actual work delivered. The tone stays firm, not awkward.',
      },
      {
        step: 5,
        title: 'Reconcile payments and close the loop',
        body: 'When money lands, Duet matches payments to invoices, marks them paid, updates the client record, and removes the account from follow-up. Partial payments and disputes get flagged with context.',
      },
      {
        step: 6,
        title: 'Surface cash risk every Monday',
        body: 'Duet sends a simple cash brief: invoices sent, paid, overdue, aging buckets, clients at risk, and the next collection action. You know where cash is stuck before payroll week.',
      },
    ],
    faqs: [
      {
        q: 'Can Duet create invoices inside QuickBooks or Xero?',
        a: 'Duet can draft invoices in QuickBooks, Xero, Stripe, or another billing tool when the integration path supports it, then wait for approval before send. Start with approval required and enable narrow repeat rules later only after review.',
      },
      {
        q: 'Will it chase clients too aggressively?',
        a: 'No. You define the cadence and tone. Duet can be soft for strategic accounts, firmer for chronic late payers, and always route sensitive clients to a human before any reminder is sent.',
      },
      {
        q: 'Can it invoice from time tracking or project management tools?',
        a: 'Yes. Duet can pull billable hours, milestones, completed tasks, and retainers from tools like Harvest, Toggl, Linear, Asana, Notion, and Google Sheets, then turn them into invoice line items.',
      },
      {
        q: 'Does Duet process payments?',
        a: 'Duet prepares and sends payment links through your existing provider, such as Stripe, QuickBooks Payments, or Xero. Actual money movement stays inside the payment system you already trust.',
      },
      {
        q: 'How does it handle disputed invoices?',
        a: 'Disputes are escalated with the invoice, contract terms, delivery notes, and prior emails attached. Duet drafts a response, but the decision stays with you.',
      },
      {
        q: 'Is this useful for agencies and service businesses?',
        a: 'Yes. Agencies, consultants, contractors, clinics, and other service businesses are a strong fit because invoicing depends on scattered delivery proof. Duet pulls that proof together and keeps the follow-up cadence running.',
      },
    ],
    relatedPersonas: ['small-businesses', 'agencies', 'operations'],
    relatedLeaves: ['small-businesses/service-business-owner'],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'client-onboarding',
    title: 'Client onboarding',
    h1: 'Onboard new clients with an AI coworker',
    metaTitle: 'AI for Client Onboarding | Kickoff to Handoff | Duet',
    metaDescription:
      'Duet runs client onboarding — kickoff emails, intake forms, workspace setup, calendar booking, asset collection, and first-week follow-up.',
    intro:
      'Client onboarding is where lean teams either look premium or look improvised. Duet turns a signed deal into a clean kickoff: welcome email, intake form, shared workspace, calendar invite, asset checklist, and first-week follow-up. The client feels like you have a bigger team than you do.',
    jobSteps: [
      {
        step: 1,
        title: 'Trigger from a signed deal or payment',
        body: 'Duet watches Stripe, HubSpot, Attio, Pipedrive, DocuSign, or a manual approval. When a deal closes, it starts the onboarding workflow with the client, plan, scope, and owner already attached.',
      },
      {
        step: 2,
        title: 'Send the kickoff email',
        body: 'Duet drafts the welcome note in your voice, introduces the working rhythm, links the intake form, and explains exactly what happens next. No blank-page kickoff every time a client signs.',
      },
      {
        step: 3,
        title: 'Collect the right assets',
        body: 'Brand files, logins, analytics access, audience notes, deadlines, legal constraints, invoice details — Duet asks for what this client needs, not a generic bloated intake form.',
      },
      {
        step: 4,
        title: 'Create the workspace and first tasks',
        body: 'Duet creates the Notion, Linear, Asana, ClickUp, Google Drive, or Slack workspace from your template, fills in the client details, assigns owners, and opens the first-week tasks.',
      },
      {
        step: 5,
        title: 'Book kickoff and chase missing inputs',
        body: 'Duet schedules the kickoff call, sends reminders, and follows up on missing assets without you becoming the project manager before the project even starts.',
      },
      {
        step: 6,
        title: 'Send the first-week status brief',
        body: 'After the first week, Duet summarizes what was received, what is blocked, what shipped, and what the client needs to do next. The relationship starts with momentum instead of confusion.',
      },
    ],
    faqs: [
      {
        q: 'Can Duet customize onboarding by package or client type?',
        a: 'Yes. Different packages can trigger different forms, workspaces, kickoff agendas, and asset requests. A lightweight audit and a full retainer should not get the same onboarding flow.',
      },
      {
        q: 'Which project tools can it set up?',
        a: 'Duet can set up project spaces through managed integrations, APIs, shared folders, CSV, or custom wiring depending on the tool. For Notion, Google Drive, Slack, Linear, Asana, ClickUp, Trello, Airtable, or client portals, scope the exact create/update permissions during setup.',
      },
      {
        q: 'Will the client know an AI is coordinating onboarding?',
        a: 'Only if you want that to be explicit. Many teams use Duet behind the scenes to draft, create, and chase, while the messages still come from the business in a consistent voice.',
      },
      {
        q: 'How does Duet avoid asking clients for things twice?',
        a: 'It stores what the client already provided, checks the workspace before preparing reminders, and only asks for missing items. The follow-up is specific: the logo is in, analytics access is still missing.',
      },
      {
        q: 'Can it handle compliance or legal steps?',
        a: 'Yes, as a checklist and routing layer. Duet can collect documents, send the right forms, and escalate legal review, but it does not make legal judgments without a human owner.',
      },
      {
        q: 'Is this only for agencies?',
        a: 'No. Agencies benefit immediately, but consultants, service businesses, software onboarding teams, and ops-heavy founders use the same pattern: trigger, collect, create workspace, follow up.',
      },
    ],
    relatedPersonas: ['agencies', 'small-businesses', 'operations'],
    relatedLeaves: ['small-businesses/service-business-owner'],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'reporting',
    title: 'Internal reporting',
    h1: 'Run internal reporting with an AI coworker',
    metaTitle: 'AI for Internal Reporting | Briefs, Metrics | Duet',
    metaDescription:
      'Duet runs internal reporting — pulls metrics, explains changes, builds daily or weekly briefs, and sends the next actions to your team.',
    intro:
      'Reporting should make the next move obvious. Instead, lean teams lose hours pulling the same numbers into the same slides. Duet connects the sources, builds the daily or weekly brief, explains what changed, and sends the handful of decisions that matter. The report becomes the meeting.',
    jobSteps: [
      {
        step: 1,
        title: 'Connect the metrics sources',
        body: 'Duet reads Stripe, PostHog, GA4, Search Console, HubSpot, Attio, Shopify, QuickBooks, spreadsheets, and databases. You define the handful of metrics that drive the business instead of dumping every chart into a dashboard.',
      },
      {
        step: 2,
        title: 'Define the brief people will read',
        body: 'Pick the cadence and audience: daily founder pulse, Monday revenue brief, Friday client report, monthly board packet. Duet shapes the output to the reader instead of reusing one giant dashboard for everyone.',
      },
      {
        step: 3,
        title: 'Pull numbers and compare to baseline',
        body: 'Duet fetches the latest metrics, compares them to last week, last month, forecast, or target, and flags changes that are large enough to matter. Noise stays out of the brief.',
      },
      {
        step: 4,
        title: 'Explain what changed',
        body: 'When signups dip, churn spikes, traffic moves, or cash tightens, Duet checks the surrounding events: releases, campaigns, support volume, outages, seasonality. The report says why it probably happened, not just that it happened.',
      },
      {
        step: 5,
        title: 'Send the brief where work happens',
        body: 'Email, Slack, Duet Files, Notion, Google Slides, or PDF — Duet posts the finished brief with the supporting links attached. Humans read the summary and click through only when they need detail.',
      },
      {
        step: 6,
        title: 'Track follow-up actions',
        body: 'If the report recommends a pricing check, support reply, churn review, or SEO fix, Duet creates the task and follows up next week. Reporting becomes an operating loop, not a static artifact.',
      },
    ],
    faqs: [
      {
        q: 'How is this different from a dashboard?',
        a: 'A dashboard waits for you to interpret it. Duet pulls the numbers, explains the change, links the evidence, and recommends the next action. It is an analyst layer a small business can run without adding a full-time analyst.',
      },
      {
        q: 'Can Duet build client-facing reports?',
        a: 'Yes. Duet can create polished client reports with only the metrics each client should see, plus plain-English commentary and next steps. Agencies use this to replace repetitive reporting assembly.',
      },
      {
        q: 'Can it send scheduled reports?',
        a: 'Yes. Reports can run on a daily, weekly, monthly, or custom schedule. You can require approval for external reports while letting internal briefs send under the rules you set.',
      },
      {
        q: 'What formats can it produce?',
        a: 'Email, Slack posts, Duet Files, Notion pages, Markdown, Google Docs, Google Slides, CSV, and PDF are all supported. The same source brief can become multiple formats.',
      },
      {
        q: 'Can it handle messy spreadsheet data?',
        a: 'Yes. Duet can normalize sheets, detect missing columns, reconcile naming mismatches, and flag rows that need cleanup. It will not silently invent clean data where the source is broken.',
      },
      {
        q: 'Who should use AI internal reporting first?',
        a: 'Founders, operators, agencies, and small teams with repeated weekly reporting pain. If someone spends each week making the same report, Duet should own that job.',
      },
    ],
    relatedPersonas: ['operations', 'founders', 'agencies'],
    relatedLeaves: ['small-businesses/shopify-store'],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'documents',
    title: 'Document handling',
    h1: 'Handle business documents with an AI coworker',
    metaTitle: 'AI for Documents | Extract, Review, File | Duet',
    metaDescription:
      'Duet handles business documents — extracts terms, summarizes contracts, flags risks, renames files, routes approvals, and keeps records organized.',
    intro:
      'Every small business has a document graveyard: contracts, invoices, PDFs, decks, receipts, forms, statements. Duet reads them, extracts the useful fields, flags the risky parts, files them where they belong, and turns the pile into a system. No enterprise document platform required.',
    jobSteps: [
      {
        step: 1,
        title: 'Connect the places documents land',
        body: 'Duet watches Gmail, Google Drive, Dropbox, Notion, Slack uploads, and shared folders. It can also process one-off PDFs, scans, images, and Word docs you add to Files.',
      },
      {
        step: 2,
        title: 'Extract the fields that matter',
        body: 'For invoices, contracts, receipts, statements, and forms, Duet extracts names, dates, amounts, renewal terms, payment terms, obligations, and owners into a table or CRM record.',
      },
      {
        step: 3,
        title: 'Summarize and flag risk',
        body: 'Duet summarizes the document in plain English and flags unusual clauses, missing signatures, auto-renewals, late fees, mismatched totals, or anything that should go to a human before approval.',
      },
      {
        step: 4,
        title: 'Rename and file with routing rules',
        body: 'Files get renamed with a consistent pattern and routed to the right folder or record. You stop searching for “final_final_contract_signed_v3.pdf” and start opening the client record.',
      },
      {
        step: 5,
        title: 'Route approvals and reminders',
        body: 'Duet pings the right owner for approval, follows up before renewal dates, and creates tasks for documents that need signatures or missing attachments. The document becomes a workflow, not a dead file.',
      },
      {
        step: 6,
        title: 'Build a searchable business memory',
        body: 'The extracted fields and summaries live in Duet memory, so future questions like “which vendors renew in June?” or “what did this client agree to?” get answered without opening a folder maze.',
      },
    ],
    faqs: [
      {
        q: 'Can Duet read scanned PDFs and images?',
        a: 'Yes. Duet can OCR scanned PDFs and images, then extract structured fields and summarize the document. Low-confidence OCR gets flagged instead of treated as truth.',
      },
      {
        q: 'Is this legal review?',
        a: 'No. Duet can summarize terms, flag unusual clauses, and prepare questions for counsel, but it is not a lawyer. Legal approval stays with a human.',
      },
      {
        q: 'Can it organize Google Drive?',
        a: 'Yes. Duet can rename files, create folders, move documents, attach them to CRM or project records, and keep a log of what changed.',
      },
      {
        q: 'What document types work best?',
        a: 'Contracts, invoices, receipts, bank statements, vendor forms, client briefs, onboarding docs, tax packets, PDFs, images, Word docs, and decks all work well when the fields to extract are clear.',
      },
      {
        q: 'How does Duet avoid leaking sensitive documents?',
        a: 'Each workspace runs on its own isolated cloud server, and document outputs stay inside that workspace unless you explicitly share or export them. You can also keep approval required before anything leaves the system.',
      },
      {
        q: 'Can it build a searchable archive from old documents?',
        a: 'Yes. Duet can process a folder of old documents, extract metadata, write summaries, and create an index so the archive becomes searchable business memory instead of storage clutter.',
      },
    ],
    relatedPersonas: ['operations', 'small-businesses', 'agencies'],
    relatedLeaves: [],
    lastUpdated: '2026-05-18',
  },
  {
    slug: 'app-building',
    title: 'App building',
    h1: 'Build small business apps with an AI coworker',
    metaTitle: 'AI App Builder for Small Business | Build + Run | Duet',
    metaDescription:
      'Duet builds and runs small business apps — dashboards, portals, calculators, forms, automations, and internal tools hosted from your workspace.',
    intro:
      'Small businesses often have tiny apps they need and zero reason to hire a full engineering team: a quote calculator, client portal, invoice tracker, intake form, KPI dashboard, approval queue. Duet builds the app and runs it from the same workspace, so the tool does not become another thing you have to operate.',
    jobSteps: [
      {
        step: 1,
        title: 'Describe the job the app should do',
        body: 'Tell Duet the workflow in plain English: who uses it, what they enter, what happens next, and what systems it should touch. The app starts from the business process, not from a framework choice.',
      },
      {
        step: 2,
        title: 'Connect the data sources',
        body: 'Duet can connect spreadsheets, CRMs, payment tools, calendars, databases, files, or APIs through available integrations, credentials, or scoped setup. If the first version can run on a spreadsheet, Duet starts there instead of overbuilding.',
      },
      {
        step: 3,
        title: 'Generate the first working version',
        body: 'Duet builds the UI, database, permissions, and workflow logic, then gives you a live URL. You test it with real data instead of reading a spec for two weeks.',
      },
      {
        step: 4,
        title: 'Iterate with the people who will use it',
        body: 'Ask for changes in the same session: add a filter, rename a field, export CSV, make the mobile view less cramped, send an email when status changes. Duet ships the edits and remembers why they were made.',
      },
      {
        step: 5,
        title: 'Host and monitor the app',
        body: 'The app runs from your Duet workspace with logs, files, memory, scheduled jobs, and integrations nearby. Build and run stay together, which is the difference between a demo and a business tool.',
      },
      {
        step: 6,
        title: 'Turn repeated work into automation',
        body: 'Once the app is stable, Duet adds the cron, webhook, approval step, or report that lets it run on schedule under your rules. The app becomes a coworker-operated workflow, not another dashboard to babysit.',
      },
    ],
    faqs: [
      {
        q: 'Is Duet a no-code app builder?',
        a: 'Not exactly. No-code builders give you blocks to assemble. Duet gives you an AI coworker with a workspace, filesystem, memory, code execution, and integrations. You describe the business job and it builds the tool.',
      },
      {
        q: 'What kinds of apps are best for Duet?',
        a: 'Internal tools, client portals, calculators, dashboards, intake forms, approval queues, reporting apps, lightweight CRMs, and workflow tools are ideal. Duet is not trying to replace a full product engineering team for complex consumer software.',
      },
      {
        q: 'Can non-technical users make changes?',
        a: 'Yes. You ask in plain English and Duet edits the app. Technical users can inspect code and logs, but small business owners do not need to learn a builder interface to change a field or ship a new flow.',
      },
      {
        q: 'Where are the apps hosted?',
        a: 'Apps are hosted from the Duet workspace on a Duet subdomain or custom domain. The same workspace that built the app can run scheduled jobs, manage files, and connect to the tools the app needs.',
      },
      {
        q: 'Can Duet maintain the app after launch?',
        a: 'Yes. That is the point. Duet can monitor logs, fix copy, add fields, update integrations, generate reports, and keep the app aligned with the workflow as your business changes.',
      },
      {
        q: 'How is this different from hiring a developer for a small tool?',
        a: 'A developer can build the first version, but then every change becomes a ticket. Duet builds the first version and keeps operating beside it, so small improvements happen when the business asks for them.',
      },
    ],
    relatedPersonas: ['small-businesses', 'founders', 'operations'],
    relatedLeaves: ['small-businesses/shopify-store', 'small-businesses/service-business-owner'],
    lastUpdated: '2026-05-18',
  },
]
const useCasePersonasCopy = {
  en: EN_USE_CASE_PERSONAS,
  'es-419': [
    {
      slug: EN_USE_CASE_PERSONAS[0]!.slug,
      name: 'Propietarios de pequeñas empresas',
      shortName: 'Pequeñas empresas',
      navLabel: 'Pequeñas empresas',
      eyebrow: 'Para propietarios de pequeñas empresas',
      h1Lead: 'AI para la gente',
      h1Highlight: 'realmente dirigiendo el negocio.',
      metaTitle: 'AI para pequeñas empresas | Contrata uno hoy | Duet',
      metaDescription:
        'Duet es un AI siempre activo para propietarios de pequeñas empresas. Crea un sitio web, opera soporte, haz onboarding de clientes y envía herramientas internas, sin contratar otro rol.',
      primaryKeyword: 'AI para pequeñas empresas',
      secondaryKeywords: [
        'asistente de AI para pequeña empresa',
        'AI para SMB',
        'automatización de pequeñas empresas',
        'asistente de AI virtual',
        'AI para propietarios de tiendas',
      ],
      heroDescription:
        'Eres el fundador, el especialista en marketing, el departamento de TI y el contable. Duet es AI para propietarios de pequeñas empresas que realmente operan el negocio: crea el sitio, redacta el email, configura la hoja de cálculo y prepara el primer flujo de trabajo recurrente para tu revisión. Un compañero de AI, un workspace, el circuito operativo que siempre quisiste sistematizar.',
      definition:
        'Un compañero de trabajo con IA para propietarios de pequeñas empresas es un compañero de IA persistente, en la nube, que construye y opera el trabajo recurrente que un dueño suele hacer fuera de horario: el sitio web, la bandeja de soporte, el seguimiento de facturas y el onboarding de clientes. A diferencia de un chatbot, vive en su propio workspace, recuerda tu negocio entre sesiones y envía el trabajo bajo tus reglas de revisión para que una tienda de una sola persona opere como un equipo pequeño.',
      painCards: [
        {
          title: 'El sitio web que nunca terminas',
          quote: '"He tenido la intención de rehacer nuestro sitio desde el año pasado".',
          body: 'Duet crea un sitio real, rápido e indexable a partir de un resumen breve (copia, imágenes, formulario de contacto, todo) y lo aloja en un subdominio Duet o en el suyo propio. Cuando desee un ajuste de precio, una tarjeta de nuevo producto o un banner navideño, solicite en lenguaje natural y Duet puede realizar la actualización desde el mismo workspace.',
        },
        {
          title: 'Acumulación de emails de soporte',
          quote: '"El viernes mi bandeja de entrada será un cementerio".',
          body: 'Duet lee cada hilo de soporte, redacta una respuesta con tu voz, marca los que te necesitan y etiqueta el resto para que la revisión sea rápida. La bandeja de entrada se convierte en una cola de revisión, no en un cementerio, y los clientes que realmente necesitan un ser humano están sentados en la parte superior.',
        },
        {
          title: 'Herramientas que nunca podrás permitirte construir',
          quote: '"Necesitamos un panel pequeño, pero ningún desarrollador quiere ese trabajo".',
          body: 'Duet escribe la herramienta interna desde cero (rastreador de facturas, formulario de reserva, verificador de existencias) y la ejecuta en un servidor propio para que deje de hacer malabarismos con las hojas de cálculo. Viene con una base de datos real, autenticación real y una URL real, para que las personas que quieras que lo utilicen puedan simplemente abrir el enlace.',
        },
      ],
      useCases: [
        {
          id: EN_USE_CASE_PERSONAS[0]!.useCases[0]!.id,
          title: 'Crea y envía el sitio web de tu empresa',
          prompt:
            'Crea un sitio de 1 página para Pine & Pour, un bar de vinos en Austin: menú, horario, formulario de reservas y un bloque de Instagram. Implementarlo en pineandpour.duet.so.',
          outcome: 'Listo para revisión desde un resumen',
        },
        {
          id: EN_USE_CASE_PERSONAS[0]!.useCases[1]!.id,
          title: 'Crea apps internas sin un ingeniero',
          prompt:
            'Constrúyeme un rastreador de facturas. Extraiga los datos de los clientes de nuestra Hoja de Google, permítame marcar las facturas pagadas y enviar un recordatorio por email en la fecha de seguimiento si no se pagan.',
          outcome: 'App funcional en un resumen en lenguaje natural',
        },
        {
          id: EN_USE_CASE_PERSONAS[0]!.useCases[2]!.id,
          title: 'Administrar emails de soporte y mensajes de clientes.',
          prompt:
            'Lea los mensajes recientes en support@, redacte respuestas en nuestro tono y coloque los que necesitan un reembolso en un grupo de "me necesita".',
          outcome: 'Borradores preparados, excepciones escaladas',
        },
        {
          id: EN_USE_CASE_PERSONAS[0]!.useCases[3]!.id,
          title: 'Incorporar nuevos clientes con un flujo de trabajo revisable',
          prompt:
            'Cuando llegue un pago de Stripe, genera un email de bienvenida, crea tu workspace de Notion a partir de la plantilla y reserva un inicio en mi calendario.',
          outcome: 'Paquete de incorporación en cola para revisión',
        },
      ],
      comparison: {
        without: [
          'Cinco pestañas abiertas, cuatro herramientas a medio terminar, un sitio web que nunca se envió.',
          'Acumulación de soporte recurrente que tú eliminas fuera del horario laboral.',
          'Cotizaciones para un "tablero simple" que se convierte en una madriguera de proyecto personalizado.',
          'Incorporación de nuevos clientes realizada desde la memoria, en DM.',
        ],
        with: [
          'Un workspace Duet que construye, envía y ejecuta el trabajo.',
          'La bandeja de entrada se clasifica diariamente y los borradores están listos cuando te sientas.',
          'Apps internas escritas en lenguaje natural y alojadas para ti.',
          'Un flujo de incorporación repetible que se ejecuta cuando Stripe registra un pago.',
        ],
      },
      howItWorks: [
        {
          step: EN_USE_CASE_PERSONAS[0]!.howItWorks[0]!.step,
          title: 'Apunta Duet a tu negocio',
          body: 'Comparte tu sitio web, tu bandeja de entrada y las herramientas con las que trabajas. Duet lee la voz de tu marca, tus respuestas anteriores, tus páginas de precios y los flujos de trabajo recurrentes que ejecutas, sin convertir la configuración en una carrera de descubrimiento.',
        },
        {
          step: EN_USE_CASE_PERSONAS[0]!.howItWorks[1]!.step,
          title: 'Pregunta en lenguaje natural',
          body: 'Dile a Duet lo que realmente necesita: "reconstruir nuestro sitio", "borrar respuestas en mi voz", "activar un rastreador de facturas". Sin ingeniería rápida, sin galería de plantillas para explorar, sin integraciones que configurar primero. Tú describes el trabajo; Duet elige las herramientas.',
        },
        {
          step: EN_USE_CASE_PERSONAS[0]!.howItWorks[2]!.step,
          title: 'Ejecútelo según un cronograma',
          body: 'Duet envía el trabajo a un servidor real, te envía borradores para tu aprobación y ejecuta las piezas recurrentes según lo programado. Te mantienes informado, no en la maleza: revisa lo que se ejecutó esta mañana, redirige lo que no funcionó y mantén las piezas de bajo riesgo en movimiento según tus reglas.',
        },
      ],
      faqs: [
        {
          q: '¿Necesito ser técnico para usar Duet?',
          a: 'No. Duet está diseñado para propietarios y operadores que no escriben código. Describes el trabajo en un lenguaje natural; Duet se encarga de escribir, construir y desplegar. Lo más parecido a la configuración es conectar las herramientas que ya utilizas (Gmail, Drive, Stripe) y señalar Duet a la URL de tu empresa.',
        },
        {
          q: '¿Puede Duet realmente crear un sitio web que se clasifique?',
          a: 'Duet puede generar páginas rastreables, rápidas y listas para SEO con metadatos, esquemas, entradas de mapas del sitio y tarjetas Open Graph, no un PDF glorificado. Las clasificaciones aún dependen de la autoridad del dominio, la calidad del contenido, los enlaces, la intención de búsqueda y la competencia, así que trate a Duet como el sistema que prepara la página y la sigue mejorando.',
        },
        {
          q: '¿Cómo maneja Duet los datos de nuestros clientes?',
          a: 'Cada workspace Duet tiene su propio servidor en la nube privado con almacenamiento y memoria aislados. Los datos, los borradores y las integraciones de tus clientes permanecen exclusivos de tu equipo: sin grupo compartido de múltiples inquilinos, sin capacitación sobre tu contenido y sin exposición sorpresa entre inquilinos si un workspace vecino se ve comprometido.',
        },
        {
          q: '¿Cuánto cuesta en comparación con contratar un VA a tiempo parcial?',
          a: 'Un asistente humano a tiempo parcial es un costo laboral recurrente con cobertura limitada. Duet ofrece planes mensuales con créditos incluidos y se adapta mejor cuando el trabajo repetible abarca herramientas, archivos y aprobaciones dentro de tu workspace.',
        },
        {
          q: '¿Duet reemplazará a mi equipo?',
          a: 'No. Duet asume un trabajo repetible al que tu equipo no pudo acceder: el sitio web que nunca envió, la bandeja de entrada que nunca borró, la herramienta que nunca creó. Tu equipo puede concentrarse en las cosas que realmente necesitan un ser humano en la sala: la conversación con el cliente, la decisión, la relación.',
        },
        {
          q: '¿Cuánto tiempo lleva la configuración?',
          a: 'Comienza conectando una URL, una bandeja de entrada o un calendario y entregando un flujo de trabajo. El primer resultado útil depende del flujo de trabajo y de las herramientas conectadas.',
        },
      ],
      relatedSlugs: EN_USE_CASE_PERSONAS[0]!.relatedSlugs,
      leaves: [
        {
          slug: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.slug,
          title: 'AI para propietarios de tiendas Shopify',
          h1: 'Dirige tu tienda Shopify con un compañero de AI',
          metaTitle: 'AI para tiendas Shopify | Ejecútelo como un gigante | Duet',
          metaDescription:
            'Duet es AI para propietarios de tiendas Shopify. Redacta páginas de productos, responde al soporte, reconstruye el escaparate y ejecuta flujos de carritos abandonados, sin contratar a otra agencia.',
          intro:
            'Estás dirigiendo una tienda Shopify, un servicio de atención al cliente y un equipo de marketing, solo. Duet se conecta a tu tienda, tu bandeja de entrada y tus cuentas publicitarias para ayudar a ejecutar el ciclo: copia de la página del producto, respuestas de soporte, secuencias de carritos abandonados y el informe analítico que has querido consultar desde el lanzamiento.',
          workflowSteps: [
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.workflowSteps[0]!.step,
              title: 'Conecta tu tienda Shopify y bandeja de entrada de soporte',
              body: 'Apunta Duet a tu tienda y a tu bandeja de entrada de atención al cliente (Gmail, Help Scout, Gorgias o simple support@). Incluye tu catálogo de productos, voz de marca, política de reembolso y tickets de soporte recientes para que los borradores coincidan con tu forma de hablar con los clientes.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.workflowSteps[1]!.step,
              title: 'Generar páginas de productos y copia de categorías.',
              body: 'Entrega a Duet una especificación de producto o un PDF de proveedor y redacta el título, la descripción, las viñetas, los metadatos de SEO y el bloque de preguntas frecuentes, listo para publicar a través de una ruta de administrador de Shopify habilitada o pegarlo. El mismo flujo reescribe las páginas de categorías obsoletas para que se pueda buscar en todo el catálogo, no solo en los más vendidos.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.workflowSteps[2]!.step,
              title: 'Ejecuta respuestas de soporte con revisión humana',
              body: 'Duet lee cada ticket nuevo, lo clasifica (dónde está mi pedido, reembolso, tamaño, venta al por mayor), redacta una respuesta en tu tono y la pone en cola para tu revisión. Cualquier cosa ambigua (una devolución de cargo, una solicitud de prensa) se te remite con el contexto relevante adjunto.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.workflowSteps[3]!.step,
              title: 'Recuperar carros abandonados en cadencia',
              body: 'Conecta Klaviyo o tu email de Shopify integrado y Duet escribe la secuencia del carrito abandonado, personalizada según el contenido del carrito y los pedidos anteriores del cliente. Las nuevas variantes pueden ejecutarse con una cadencia y los ganadores ascienden después de la revisión.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.workflowSteps[4]!.step,
              title: 'Obtén un informe semanal de la tienda en el que puedas actuar',
              body: 'Con una cadencia semanal, Duet envía por email un informe de una página: tendencia de GMV, SKU principales, volumen de soporte y CSAT, ROAS publicitario y las decisiones que necesitan atención. El informe es la reunión; puedes revisarlo antes de la sincronización del equipo.',
            },
          ],
          faqs: [
            {
              q: '¿Duet funciona con la API de administración de Shopify?',
              a: 'Sí. Duet se autentica en tu tienda Shopify con credenciales de alcance y puede leer productos, pedidos y clientes, y escribir actualizaciones de productos, borradores de pedidos y valores de metacampos. Tú apruebas los alcances durante la configuración; nada se intensifica sin que tú lo vuelva a autorizar.',
            },
            {
              q: '¿La copia del producto sonará como AI basura?',
              a: 'No, no si le das ejemplos sólidos. Una vez que Duet haya leído las páginas de tus productos más vendidos, reflejará la longitud de tus oraciones, las palabras que usas para el ajuste y el material, la forma en que indicas el envío y las líneas que colocas en el bloque de preguntas frecuentes. El objetivo son borradores que necesitan edición, no reescritura.',
            },
            {
              q: '¿Puede manejar devoluciones y reembolsos?',
              a: 'Duet redacta la respuesta de reembolso y propone el reembolso en Shopify, pero un humano aprueba el movimiento de dinero real de forma predeterminada. Puede flexibilizar esa regla por categoría una vez que confíe en el clasificador; algunos equipos definen posteriormente categorías o umbrales de bajo riesgo después de la revisión y mantienen los casos extremos escalados.',
            },
            {
              q: '¿Se integra con Klaviyo, Gorgias y el resto de la pila de Shopify?',
              a: 'Duet puede conectarse a entornos de Shopify mediante integraciones administradas, API, webhooks, IMAP/CSV o configuración personalizada según la herramienta. Los flujos de Klaviyo, Gorgias, Help Scout, Postscript, Recharge y Loop Returns deben tratarse como configuraciones con alcance definido, no como conectores instantáneos.',
            },
            {
              q: '¿En qué se diferencia esto de un AI nativo de Shopify como Sidekick?',
              a: 'Sidekick vive dentro del administrador de Shopify y te ayuda con una tarea a la vez. Duet vive fuera del administrador, ejecuta flujos de trabajo programados en un servidor en la nube, mantiene la memoria en tu workspace y accede a Klaviyo, Gorgias, tus cuentas publicitarias y tu bandeja de entrada. Usa ambos: no entran en conflicto.',
            },
            {
              q: '¿Qué tan rápido puede funcionar una tienda unipersonal con Duet?',
              a: 'Los propietarios individuales de Shopify generalmente comienzan con borradores de soporte o copias de carritos abandonados, luego se expanden a páginas de productos, emails e informes recurrentes después de algunas revisiones.',
            },
          ],
          relatedJobs: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.relatedJobs,
          lastUpdated: EN_USE_CASE_PERSONAS[0]!.leaves[0]!.lastUpdated,
        },
        {
          slug: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.slug,
          title: 'AI para propietarios de empresas de servicios',
          h1: 'Dirige tu negocio de servicios con un asistente AI en la nube',
          metaTitle: 'AI para empresas de servicios | Asistente en la nube | Duet',
          metaDescription:
            'Duet es AI para empresas de servicios. Reserva citas, envía facturas, realiza seguimiento de clientes potenciales, clasifica la bandeja de entrada y administra la oficina principal desde un solo workspace.',
          intro:
            'Diriges un salón, una clínica, un equipo de contratación, un negocio de limpieza. El teléfono nunca se detiene, la bandeja de entrada es un desastre el viernes y la mitad de tus clientes potenciales nunca reciben un seguimiento. Duet se ubica encima de tus herramientas existentes (Google Calendar, QuickBooks, Jobber, el desvío de tu teléfono) y ejecuta la oficina principal mientras estás en el lugar de trabajo.',
          workflowSteps: [
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.workflowSteps[0]!.step,
              title: 'Apunta Duet a tu calendario y bandeja de entrada',
              body: 'Conecta Google Calendar (o Calendly, Acuity o Jobber), tu email comercial y tu número de transferencia telefónica. Duet aprende tu menú de servicios, tus precios, tus horarios y la forma en que hablas con los clientes a partir de tus respuestas anteriores.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.workflowSteps[1]!.step,
              title: 'Capte clientes potenciales en todos los canales',
              body: 'Texto entrante, llamada perdida, formulario del sitio web, mensaje de Yelp: Duet redacta el enlace de reserva o una pregunta aclaratoria y luego mantiene la conversación en movimiento hasta que el cliente potencial reserva o se da de baja. El objetivo es que haya menos clientes potenciales sin tocar mientras estás en el trabajo.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.workflowSteps[2]!.step,
              title: 'Reserva y confirma citas con reglas de revisión',
              body: 'Duet propone un espacio en tu calendario, recibe confirmación por mensaje de texto o email y escribe la cita en tu sistema de reservas, con las notas del cliente, el servicio solicitado y la dirección. También puede enviar recordatorios y reprogramar si responden pidiendo mudarse.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.workflowSteps[3]!.step,
              title: 'Envía facturas y persigue a los pagadores lentos',
              body: 'Después de un trabajo, Duet redacta la factura en QuickBooks o Jobber a partir de las notas de la cita, la envía para tu aprobación y luego realiza un seguimiento con un ritmo cortés. Revisa las excepciones en lugar de reconstruir el mismo flujo de trabajo de facturas cada vez.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.workflowSteps[4]!.step,
              title: 'Solicita la reseña en el momento adecuado',
              body: 'Una vez que el trabajo se marca como completo, Duet puede enviar una solicitud personalizada para una revisión de Google, con el nombre del cliente, el servicio que recibió y un enlace directo a su perfil comercial de Google. Las solicitudes de revisión más consistentes te brindan una mejor oportunidad de generar confianza local.',
            },
            {
              step: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.workflowSteps[5]!.step,
              title: 'Obtén un resumen de la próxima semana el lunes por la mañana',
              body: 'Con una cadencia semanal, Duet te envía emails con reservas abiertas, clientes potenciales aún indecisos, facturas pendientes de pago y espacios que aún están abiertos. Empiezas la semana sabiendo exactamente dónde presionar.',
            },
          ],
          faqs: [
            {
              q: '¿Duet funciona con Jobber, ServiceTitan o Housecall Pro?',
              a: 'Duet puede conectarse a sistemas de empresas de servicios mediante integraciones administradas, API, email, exportaciones CSV o configuración personalizada según la herramienta. Para Jobber, ServiceTitan, Housecall Pro, Workiz o un sistema más pequeño, la configuración debe limitarse al acceso exacto a la API y los permisos disponibles.',
            },
            {
              q: '¿Puede contestar el teléfono?',
              a: 'Duet no reemplaza tu línea telefónica, pero puede atender llamadas perdidas y SMS a través de Twilio, OpenPhone o tu desvío de llamadas existente. La persona que llama recibe un enlace de reserva o un seguimiento que suena humano, por lo que menos clientes potenciales llegan a tu competidor al otro lado de la ciudad.',
            },
            {
              q: '¿Sonará como yo o como un robot?',
              a: 'Suena más a ti después de leer ejemplos de mensajes anteriores de clientes. El objetivo es que las respuestas de rutina resulten lo suficientemente familiares como para que los habituales no se den cuenta de un traspaso, y cuando Duet usa una frase que tú nunca dirías, puede corregirla en una oración.',
            },
            {
              q: '¿Cómo se compara esto con la contratación de una recepcionista virtual?',
              a: 'Una recepcionista virtual es un costo laboral recurrente para la cobertura con guión. Duet ofrece planes mensuales con créditos incluidos y se adapta mejor cuando el trabajo de front-office abarca reservas, facturas, seguimiento de pagos, reseñas y contexto del cliente.',
            },
            {
              q: '¿Están seguros los datos de mis clientes?',
              a: 'Cada workspace Duet es un servidor en la nube privado con almacenamiento aislado. Los números de teléfono, las direcciones y las notas de trabajo de los clientes permanecen dentro de tu workspace: sin grupo compartido de múltiples inquilinos, sin capacitación sobre tu contenido, sin exposición entre inquilinos si el workspace de otra persona se ve comprometido.',
            },
            {
              q: '¿Qué pasa si no quiero que Duet envíe mensajes sin que yo los revise?',
              a: 'Tú eliges la regla de aprobación por flujo de trabajo. Una implementación más segura comienza con todo en revisión, luego limita los envíos habilitados explícitamente a confirmaciones de bajo riesgo o solicitudes de revisión, mientras que las facturas y los reembolsos siguen necesitando un toque humano. Puedes cambiar la regla en cualquier momento: es un mensaje para Duet, no un menú de configuración.',
            },
          ],
          relatedJobs: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.relatedJobs,
          lastUpdated: EN_USE_CASE_PERSONAS[0]!.leaves[1]!.lastUpdated,
        },
      ],
      lastUpdated: EN_USE_CASE_PERSONAS[0]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_PERSONAS[1]!.slug,
      name: 'Agencias creativas',
      shortName: 'Agencias',
      navLabel: 'Agencias creativas',
      eyebrow: 'Para agencias creativas y de marketing',
      h1Lead: 'AI que permite a tu agencia',
      h1Highlight: 'Finalmente factura por el pensamiento.',
      metaTitle: 'AI para agencias creativas | Enviar más por cliente | Duet',
      metaDescription:
        'Duet es AI para agencias creativas. Envía páginas de destino, borradores de conceptos, genere imágenes de marca y entregas de paquetes más rápido, sin aumentar la plantilla.',
      primaryKeyword: 'AI para agencias creativas',
      secondaryKeywords: [
        'AI para agencias de marketing',
        'AI para agencias de diseño',
        'automatización de agencias',
        'AI para autónomos',
        'AI flujo de trabajo de la agencia',
      ],
      heroDescription:
        'Deja de perder margen por el trabajo duro. Duet es AI para agencias creativas que desean ofrecer más por cliente sin aumentar la plantilla: construye el sitio de destino, redacta el concepto de diseño, genera las imágenes de la marca y empaqueta el producto final, para que tu equipo vuelva al pensamiento de alto precio que vendió el trabajo.',
      definition:
        'Un compañero de trabajo con IA para agencias es un compañero de IA persistente, en la nube, que maneja la producción que un equipo facturable suele resolver a mano: primeros borradores, imágenes con marca, ensamblaje de entregables, recapitulaciones para clientes y reporting. Vive en un workspace por cliente o retainer, recuerda el contexto entre proyectos y envía las piezas repetibles bajo tus reglas de revisión para que tus directores creativos vuelvan al pensamiento de alto precio que vendieron.',
      painCards: [
        {
          title: 'La producción se come el margen',
          quote: '"Vendimos la estrategia. Estamos entregando las diapositivas".',
          body: 'Duet maneja la capa de producción (diapositivas, presentaciones, páginas de destino, generación de imágenes) para que el tiempo de los superiores deje de perderse en el montaje. Tus estrategas vuelven a contar la historia; Duet realiza el diseño, los cambios de tamaño y la decimoctava ronda de cambios de nombre de activos.',
        },
        {
          title: 'Los conceptos tardan demasiado en burlarse',
          quote: '"Tres rondas de composiciones antes de que el cliente diga algo útil".',
          body: 'Duet redacta el concepto con la voz de tu marca, genera las imágenes en tu lenguaje visual y prepara una primera ronda lista para revisión frente al cliente. La siguiente ronda también llega más rápido, porque los archivos de trabajo se encuentran en tu workspace, no en la computadora portátil de un diseñador a la que no podrá acceder hasta el martes.',
        },
        {
          title: 'Entregables empaquetados a mano.',
          quote:
            '"El viernes es siempre el día en que comprimimos los activos y redactamos el documento de transferencia".',
          body: 'Duet agrupa los activos finales, escribe el documento de transferencia, lo coloca en la carpeta del cliente y envía el enlace por email. No más viernes por la tarde perdidos con la fontanería de archivos: se ejecuta el mismo flujo de trabajo para cada proyecto, con el mismo nombre y con el mismo registro de cambios cada vez.',
        },
      ],
      useCases: [
        {
          id: EN_USE_CASE_PERSONAS[1]!.useCases[0]!.id,
          title: 'Crea páginas de destino y micrositios para clientes',
          prompt:
            'Crea una página de inicio de lanzamiento para la campaña Northbeam Serie B. Usa el kit de marca en /brand/northbeam. Hero, fila de funciones, cotización del cliente y formulario de registro. Implementa en staging.',
          outcome: 'Una construcción funcional, no un sprint estancado',
        },
        {
          id: EN_USE_CASE_PERSONAS[1]!.useCases[1]!.id,
          title: 'Borradores de conceptos de diseño y resúmenes creativos.',
          prompt:
            'Tome el resumen de Loft 32 y redacte 3 direcciones conceptuales: posicionamiento, idea visual clave, eslogan de muestra y una justificación de 2 párrafos para cada una.',
          outcome: 'Múltiples instrucciones desde un solo resumen',
        },
        {
          id: EN_USE_CASE_PERSONAS[1]!.useCases[2]!.id,
          title: 'Genere imágenes de marca a escala',
          prompt:
            'Genere 12 imágenes destacadas para el sitio Loft 32 con el mismo estilo que /brand/loft32/refs: toma aérea de estudio, luz natural suave y paleta neutra.',
          outcome: 'Variantes de marca a partir de tus referencias',
        },
        {
          id: EN_USE_CASE_PERSONAS[1]!.useCases[3]!.id,
          title: 'Empaquetar y enviar entregables al cliente',
          prompt:
            'Comprime los activos finales en /clients/loft32/v3,, escriba un documento de transferencia que resuma los cambios desde la versión 2, cárgalo en el cliente Drive y envía el enlace por email a ben@loft32.com.',
          outcome: 'Transferencia realizada en un solo mensaje',
        },
      ],
      comparison: {
        without: [
          'Estrategas senior limpiando diapositivas a las 9 p.m.',
          'Grandes intervalos entre la revisión breve y la primera revisión del concepto.',
          'Los activos de marca recrearon desde cero cada proyecto.',
          'Entregas de los viernes realizadas a mano en Dropbox.',
        ],
        with: [
          'La producción se ejecuta el Duet. El tiempo del senior se dedica a pensar y presentar.',
          'Conceptos redactados a partir del brief, listos para ser pulidos por el ser humano.',
          'Un AI consciente de la marca que recuerda el sistema visual de cada cliente.',
          'Transferencias empaquetadas, nombradas y puestas en cola para tu revisión.',
        ],
      },
      howItWorks: [
        {
          step: EN_USE_CASE_PERSONAS[1]!.howItWorks[0]!.step,
          title: 'Cargar la marca',
          body: 'Coloque el kit de marca, las pautas de voz y la biblioteca de recursos de cada cliente en Duet. Aprende las reglas para que el resultado se parezca a la marca en la primera pasada, y el segundo proyecto para el mismo cliente comienza desde donde terminó el primero, no desde un lienzo en blanco.',
        },
        {
          step: EN_USE_CASE_PERSONAS[1]!.howItWorks[1]!.step,
          title: 'Brief como si le informaras a un joven',
          body: 'Entrega a Duet el informe con las mismas palabras que usarías con un nuevo diseñador. Vuelve con simulacros, textos y presentaciones, todo al estilo de tu casa, y tu personal superior dedica tu tiempo a revisar opciones de buen gusto en lugar de dictar diseños a una cola de contratistas.',
        },
        {
          step: EN_USE_CASE_PERSONAS[1]!.howItWorks[2]!.step,
          title: 'Revisar y enviar',
          body: 'Pule las partes que importan, pon en cola el resto. Duet empaqueta los entregables, los carga en la carpeta del cliente, escribe la nota de entrega y prepara el email. El ritual del viernes por la tarde se convierte en un traspaso revisable en lugar de una lucha manual.',
        },
      ],
      faqs: [
        {
          q: '¿El resultado realmente lucirá acorde a la marca?',
          a: 'Sí, una vez que Duet tenga el kit de marca y algunas salidas de referencia. Cuanto más lo corrijas en el primer proyecto, más se acercará al estilo de tu casa en el siguiente. Las agencias utilizan ese ciclo de revisión para convertir los primeros borradores en una memoria de estilo reutilizable y específica del cliente.',
        },
        {
          q: '¿Podemos mantener a los clientes separados?',
          a: 'Cada cliente obtiene su propio workspace con memoria y archivos aislados. Los activos de marca, los borradores y el historial del workspace de una cuenta nunca se filtran a otra, y puedes entregar claves a un cliente (o revocarlas) sin que eso toque las otras cuentas que estás ejecutando.',
        },
        {
          q: '¿Duet reemplaza a los diseñadores y redactores?',
          a: 'No. Absorbe la capa de producción: las partes que al equipo senior les molesta hacer. Los conceptos aún necesitan sabor, las presentaciones aún necesitan un ser humano en la sala. Duet simplemente despeja la pista para que el banco superior dedique tiempo al trabajo por el que los clientes realmente pagaron.',
        },
        {
          q: '¿Cómo facturamos el trabajo que hace Duet?',
          a: 'Como ya lo hace: por proyecto, por entregable o por anticipo. Duet es una línea de costo, no una función facturable. El objetivo es proteger la estrategia de precios y al mismo tiempo reducir el tiempo de producción repetitivo que consume el margen.',
        },
        {
          q: '¿Qué pasa con los derechos de generación de imágenes?',
          a: 'Duet dirige el trabajo de imágenes a través de proveedores con capacidad de uso comercial cuando estén disponibles, y los datos de tu cliente permanecen restringidos al workspace. Para los entregables del cliente, revise los términos del modelo/proveedor seleccionado y fije o excluya proveedores cuando una cuenta tenga requisitos de IP específicos.',
        },
        {
          q: '¿Cómo encaja Duet en una pila Figma/Adobe/Webflow?',
          a: 'Duet no reemplaza tus herramientas de diseño: se ubica un paso antes, redactando el concepto, la copia y las referencias visuales que los alimentan. Entrégale un resumen, consigue un simulacro listo para Figma; entréguele una estructura alámbrica y obtenga una página de flujo web que funcione. Las agencias usan Duet para omitir el pase de página en blanco en cada proyecto.',
        },
      ],
      relatedSlugs: EN_USE_CASE_PERSONAS[1]!.relatedSlugs,
      leaves: EN_USE_CASE_PERSONAS[1]!.leaves,
      lastUpdated: EN_USE_CASE_PERSONAS[1]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_PERSONAS[2]!.slug,
      name: 'Fundadores de startups',
      shortName: 'Fundadores',
      navLabel: 'Fundadores de startups',
      eyebrow: 'Para fundadores de startups',
      h1Lead: 'AI para fundadores que prefieren',
      h1Highlight: 'enviar que lo programado.',
      metaTitle: 'AI para fundadores de empresas emergentes | Envío más rápido en solitario | Duet',
      metaDescription:
        'Duet es AI para fundadores de startups: el cofundador que puedes implementar. Crea un MVP funcional, realiza investigaciones, redacta presentaciones de recaudación de fondos y envía actualizaciones a los inversores.',
      primaryKeyword: 'AI para fundadores de startups',
      secondaryKeywords: [
        'AI cofundador',
        'AI para fundadores en solitario',
        'agente de inicio AI',
        'AI para hackers independientes',
        'MVP AI constructor',
      ],
      heroDescription:
        'Eres anterior al papel que estás desempeñando. Duet es AI para fundadores de startups que prefieren realizar envíos antes que programar: crea el MVP, ejecuta la investigación de mercado, redacta la plataforma y envía la actualización a los inversores, para que dejes de ser el cuello de botella en cada función a la vez. Menos contratar al cofundador y más implementar al cofundador.',
      definition:
        'Un compañero de trabajo con IA para fundadores es un compañero de IA persistente, en la nube, que ejecuta cada función que un fundador en solitario suele hacer malabares: prototipos, investigación de mercado, outreach, preparación de reclutamiento, decks y actualizaciones semanales. Hace el trabajo desde un único workspace, recuerda el contexto previo y prepara cada movimiento para tu revisión, para que el fundador deje de ser el cuello de botella en cada función a la vez.',
      painCards: [
        {
          title: 'Código por el que no puedes justificar la contratación',
          quote:
            '"Tengo una idea aproximada. Necesito un prototipo al que el equipo pueda reaccionar".',
          body: 'Duet envía un MVP funcional (frontend, backend, implementación) a partir de una especificación escrita como una historia. Envías un producto real para probar la plataforma, no una plataforma de presentación, lo que significa usuarios reales, registros reales y conversaciones reales con las personas que realmente quieren el producto.',
        },
        {
          title: 'Investigación que debería automatizarse',
          quote: '"Sigo reconstruyendo la misma hoja de competencia".',
          body: 'Duet realiza investigaciones profundas de mercado y de la competencia según un cronograma, archiva los hallazgos en un documento compartido y te avisa cuando se mueve algo interesante. Páginas de precios, registros de cambios, publicaciones de LinkedIn, patrones de contratación: observados continuamente sin que tengas que volver a abrir otra hoja de cálculo.',
        },
        {
          title: 'Actualizaciones para inversores que no suceden',
          quote: '"No he enviado una actualización desde la ronda de los ángeles".',
          body: 'Duet redacta la actualización mensual a partir de tus métricas, el historial de tu workspace y tu hoja de ruta: editas, presionas enviar y la tabla de límites se mantiene activa. El mismo andamio construye el deck la cuarta parte que levantas, por lo que dejas de comenzar desde una diapositiva de Google en blanco.',
        },
      ],
      useCases: [
        {
          id: EN_USE_CASE_PERSONAS[2]!.useCases[0]!.id,
          title: 'Crea un MVP funcional a partir de una especificación de una página',
          prompt:
            'Crea el MVP descrito en /spec/v1.md. Usa Next.js + Convex + Resend. Configura la autenticación con Convex Auth. Implementar en Vercel y generar los datos de demostración de /spec/seed.json.',
          outcome: 'Demostración lista para revisión',
        },
        {
          id: EN_USE_CASE_PERSONAS[2]!.useCases[1]!.id,
          title: 'Realizar investigaciones de mercado y de la competencia.',
          prompt:
            'Con una cadencia semanal, obtenga actualizaciones de las páginas de precios, registros de cambios y publicaciones de LinkedIn de nuestros 8 competidores. Resuma la diferencia en #market-watch.',
          outcome: 'Información recurrente, cero clics',
        },
        {
          id: EN_USE_CASE_PERSONAS[2]!.useCases[2]!.id,
          title: 'Borradores de presentaciones y folletos de recaudación de fondos',
          prompt:
            'Redacta un conjunto de semillas de 12 diapositivas utilizando /memos/seed-narrative.md, nuestras últimas métricas de Stripe y el sistema de diseño en /brand. Salida como Presentaciones de Google.',
          outcome: 'Deck v1 de tu material fuente',
        },
        {
          id: EN_USE_CASE_PERSONAS[2]!.useCases[3]!.id,
          title: 'Enviar actualizaciones mensuales a los inversores',
          prompt:
            'Redacta la actualización para inversionistas de noviembre: extraiga MRR de Stripe, las 3 principales ganancias de #wins, la solicitud del mes y las solicitudes revisadas del mes pasado. Envíame un email v1 para tu revisión.',
          outcome: 'De una página en blanco a un borrador listo para revisar',
        },
      ],
      comparison: {
        without: [
          'Cambias de contexto entre código, ventas y mazos todo el día.',
          'Una acumulación de tareas del tipo "lo haré el lunes" que nunca se realizan.',
          'Las actualizaciones de los inversores se hacen trimestralmente, mal, con culpa.',
          'Una noción llena de enlaces de competidores que nunca vuelves a abrir.',
        ],
        with: [
          'Un AI con forma de cofundador que realmente ejecuta la especificación.',
          'Investigación, redacción y envío recurrentes que se ejecutan en cron.',
          'Actualizaciones y mazos elaborados a partir de datos reales, listos para pulir.',
          'Regresas al asiento donde deberían estar los fundadores: vender y construir.',
        ],
      },
      howItWorks: [
        {
          step: EN_USE_CASE_PERSONAS[2]!.howItWorks[0]!.step,
          title: 'Entregar a Duet los documentos fundacionales.',
          body: 'Comparte tus especificaciones, tu marca, tus paneles de métricas y tu última actualización para inversionistas. Duet crea una memoria de la empresa para que pueda escribir con la voz del fundador (tu frase, tus números, tu hoja de ruta, los nombres de tus clientes) en lugar de un texto genérico de inicio.',
        },
        {
          step: EN_USE_CASE_PERSONAS[2]!.howItWorks[1]!.step,
          title: 'Delegar funciones, no entradas',
          body: 'Transfiere funciones completas (investigación, redacción, creación de MVP) en lugar de microgestionar tareas. Duet los ejecuta en cron y te envía un ping para que los revise cuando hay que tomar una decisión o hay un borrador que vale la pena, no para cada pulsación de tecla.',
        },
        {
          step: EN_USE_CASE_PERSONAS[2]!.howItWorks[2]!.step,
          title: 'Enviar y revisar semanalmente',
          body: 'En una cadencia de revisión regular, escanee el resultado de Duet: el MVP que envió, la actualización que redactó, la investigación que surgió. Aprobar, editar o redirigir. El volante sigue girando entre revisiones, por lo que la planificación comienza con el progreso en lugar de un trabajo atrasado.',
        },
      ],
      faqs: [
        {
          q: '¿Puede Duet realmente crear un MVP utilizable?',
          a: 'Sí. Duet escribe código de producción real (implementaciones de Next.js, Convex, Supabase, Vercel) a partir de una especificación. El objetivo es una demostración funcional que puedas presentarle a un socio de diseño, con un código base que sea tuyo para llevar a GitHub en el momento en que dejes de usar el código.',
        },
        {
          q: '¿Es mejor que simplemente usar Cursor o Claude Code?',
          a: 'Los asistentes de codificación te ayudan a escribir más rápido en tu computadora portátil. Duet se ejecuta en tu propio servidor en la nube, conserva el estado, programa el trabajo y maneja funciones no relacionadas con la codificación (investigación, presentaciones, actualizaciones) en el mismo workspace. Para un fundador que ejecuta cada función solo, esa es una forma diferente de producto: el cursor se acelera el martes; Duet se ejecuta los cinco días de la semana.',
        },
        {
          q: '¿Cómo maneja Duet métricas confidenciales y datos de inversores?',
          a: 'Tu workspace es un servidor en la nube privado con almacenamiento aislado. Las claves de Stripe, los materiales del tablero y los paneles de métricas permanecen en el ámbito de tu organización, sin exposición entre inquilinos ni capacitación sobre tu contenido. Los secretos viven en variables de entorno cifradas que Duet lee en tiempo de ejecución, nunca se registran ni aparecen.',
        },
        {
          q: '¿Puedo incorporar Duet a un workspace en equipo más adelante?',
          a: 'Sí. Empieza por tu cuenta y luego invita a un cofundador o contratista. Los Archivos compartidos y las fuentes de Train permanecen en el workspace, así que la nueva persona puede trabajar con el mismo código, contexto de clientes y conocimiento operativo.',
        },
        {
          q: '¿Cuánto cuesta en pre-semilla?',
          a: 'Basado en el uso: los fundadores individuales pueden comenzar con un pequeño paquete de créditos mientras validan. No hay impuestos por asiento, por lo que agregar contratistas no multiplica la factura. Cuando se aumenta y aumenta la producción, la línea de pedido aumenta con el trabajo, no con la plantilla.',
        },
        {
          q: '¿Les importará a mis inversores que haya enviado esto con AI?',
          a: 'Los serios se preocupan por la tracción, el juicio, el ritmo y la disciplina, no por las teclas que presionaste para enviar la construcción.',
        },
      ],
      relatedSlugs: EN_USE_CASE_PERSONAS[2]!.relatedSlugs,
      leaves: EN_USE_CASE_PERSONAS[2]!.leaves,
      lastUpdated: EN_USE_CASE_PERSONAS[2]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_PERSONAS[3]!.slug,
      name: 'equipos de ventas',
      shortName: 'Equipos de ventas',
      navLabel: 'equipos de ventas',
      eyebrow: 'Para equipos de ventas',
      h1Lead: 'AI para equipos de ventas que prefieren',
      h1Highlight: 'cerrar que copiar y pegar.',
      metaTitle: 'AI para equipos de ventas | Enriquecer, enviar, dar seguimiento | Duet',
      metaDescription:
        'Duet es AI para equipos de ventas que cierra la brecha administrativa. Enriquece el contenido entrante, ejecuta el saliente, mantén limpio el CRM y realiza un seguimiento, para que los representantes vendan en lugar de copiar y pegar.',
      primaryKeyword: 'AI para equipos de ventas',
      secondaryKeywords: [
        'AI DEG',
        'automatización de ventas AI',
        'AI para salida',
        'AI Limpieza de CRM',
        'asistente de AI de seguimiento',
      ],
      heroDescription:
        'Tus representantes son excelentes por teléfono y terribles con el teclado. Duet es AI para equipos de ventas que cierra la brecha administrativa: enriquece cada cliente potencial entrante, prepara la secuencia saliente para tu revisión, mantiene Salesforce actualizado y redacta el seguimiento que el representante olvidó. Ellos venden. Duet maneja el ciclo de administración según tus reglas y el proceso sigue siendo creíble los lunes.',
      definition:
        'Un compañero de trabajo con IA para equipos de ventas es un compañero de IA persistente, en la nube, que se encarga del trabajo entre reuniones: investigación de cuentas, armado de listas, enriquecimiento, borradores de outreach, higiene del CRM y briefings de pipeline. Corre sobre tus datos y en tu tono, mantiene el CRM honesto y prepara el próximo paso bajo tus reglas de revisión para que los reps pasen sus horas en conversaciones, no en pestañas.',
      painCards: [
        {
          title: 'Los clientes potenciales entrantes no están calificados',
          quote: '"Cuando los investigamos, se han enfriado".',
          body: 'Duet enriquece cada entrada en el momento en que llega (tamaño de la empresa, pila, señales de financiación, publicaciones recientes en LinkedIn) y envía una página al representante con la apertura sugerida. El cliente potencial está listo para la investigación antes de la llamada de preparación que solía ser lo primero.',
        },
        {
          title: 'El saliente es un trabajo de copiar y pegar',
          quote: '"Mis DEG pierden demasiado tiempo en hojas de cálculo, no en el teléfono".',
          body: 'Duet coordina la secuencia saliente: extrae la lista, personaliza cada email, pone en cola los envíos aprobados en tu herramienta de secuenciación y registra las respuestas en el CRM. El trabajo del DEG deja de ser la hoja de cálculo y vuelve a ser la conversación que realmente crea una oportunidad de reunión.',
        },
        {
          title: 'La higiene del CRM es un cuento de hadas',
          quote:
            '"La mitad de los acuerdos en trámite tienen fechas de etapa del último trimestre".',
          body: 'Duet lee la transcripción de cada reunión y el hilo de email, actualiza las etapas, completa los campos faltantes y señala los acuerdos que se han quedado en silencio para tu revisión. La reunión del canal comienza con la verdad, no con la versión que tu equipo tuvo tiempo de escribir después de la última llamada.',
        },
      ],
      useCases: [
        {
          id: EN_USE_CASE_PERSONAS[3]!.useCases[0]!.id,
          title: 'Enriquezca los clientes potenciales entrantes a medida que llegan',
          prompt:
            'Cada nuevo cliente potencial de HubSpot: extrae el tamaño de la empresa de Crunchbase, la pila tecnológica de BuiltWith y las publicaciones recientes de LinkedIn. Coloca una página en el registro y avisa al AE.',
          outcome: 'Clientes potenciales entrantes enriquecidos sin copiar y pegar',
        },
        {
          id: EN_USE_CASE_PERSONAS[3]!.useCases[1]!.id,
          title: 'Ejecuta secuencias de email salientes con reglas de revisión',
          prompt:
            'Obtén directores financieros de SaaS Serie A de /lists/q4-cfo.csv.. Personaliza la secuencia de /sequences/cfo-v3.md utilizando la última ronda de financiación de cada empresa. Ponlo en cola para tu revisión antes de tu aprobación en nuestra herramienta de envío.',
          outcome: 'Salida personalizada en cola sin copiar y pegar',
        },
        {
          id: EN_USE_CASE_PERSONAS[3]!.useCases[2]!.id,
          title: 'Mantén el CRM limpio y actualizado',
          prompt:
            'Con una cadencia semanal, lea las llamadas de Gong recientes, actualice las etapas de los acuerdos en Salesforce, complete los campos faltantes para los responsables de la toma de decisiones y marque los acuerdos con actividad obsoleta.',
          outcome: 'Tubería en la que realmente puedes confiar',
        },
        {
          id: EN_USE_CASE_PERSONAS[3]!.useCases[3]!.id,
          title: 'Automatizar los seguimientos posteriores a la reunión',
          prompt:
            'Cuando finalice una llamada de tldv, redacte un email de seguimiento con la voz del representante que resuma la llamada, replantee el siguiente paso y adjunte el estudio de caso relevante de /case-studies.',
          outcome: 'El borrador de seguimiento está listo antes de que regresen al escritorio.',
        },
      ],
      comparison: {
        without: [
          'Los DEG pierden gran parte del día debido a la investigación y la entrada de datos.',
          'Secuencias enviadas en lotes porque la personalización es tediosa.',
          'Un CRM que se queda obsoleto entre revisiones de procesos.',
          'Seguimientos que salen tarde, o nunca.',
        ],
        with: [
          'Representantes por teléfono. Duet escribiendo.',
          'Secuencias de salida personalizadas a nivel de empresa, enviadas en cadencia.',
          'Un CRM que se actualiza a partir de llamadas, emails y reuniones.',
          'Seguimientos redactados mientras el contexto de la reunión aún está fresco.',
        ],
      },
      howItWorks: [
        {
          step: EN_USE_CASE_PERSONAS[3]!.howItWorks[0]!.step,
          title: 'Conecta la pila de ingresos',
          body: 'Conecta Duet a HubSpot o Salesforce, tu email, Gong/tldv y tus API de enriquecimiento. Indexa tu pipeline, tus plantillas y tus victorias pasadas, por lo que el próximo email que redacta suena como el que realmente cerró el último trimestre.',
        },
        {
          step: EN_USE_CASE_PERSONAS[3]!.howItWorks[1]!.step,
          title: 'Deja las jugadas repetitivas',
          body: 'Dile a Duet qué jugadas ejecutar: enriquecimiento entrante, secuencia saliente, limpieza de CRM, seguimiento. Cada uno se ejecuta según el evento o el cronograma (no se necesita la intervención del representante) y el representante mantiene una vista en tiempo real de lo que se disparó, lo que aterrizó y lo que los necesita.',
        },
        {
          step: EN_USE_CASE_PERSONAS[3]!.howItWorks[2]!.step,
          title: 'Los representantes aprueban las cosas de alto riesgo',
          body: 'Duet borradores; Los representantes aprueban las copias salientes, las derivaciones y los emails ejecutivos antes de enviarlos. Todo lo demás simplemente sucede, con un registro de auditoría de cada envío, cada actualización de CRM y cada contacto del cliente con el AI realizado en nombre del equipo.',
        },
      ],
      faqs: [
        {
          q: '¿Duet reemplaza los DEG?',
          a: 'No, se encarga de las partes del día del DEG que no requieren un ser humano. Los representantes aún son dueños de la conversación, la pregunta de descubrimiento y el cierre. Duet es dueño de la preparación, la mecanografía y el trabajo administrativo de los que más se quejan los representantes.',
        },
        {
          q: '¿Funcionará con nuestro CRM existente?',
          a: 'Duet puede conectarse a CRM mediante integraciones administradas, API, CSV o configuración personalizada según la herramienta. Los flujos de HubSpot, Salesforce, Pipedrive, Attio y Close deben limitarse a los campos y permisos que tu equipo quiere que Duet use.',
        },
        {
          q: '¿Cómo se evita que envíes emails incorrectos?',
          a: 'Tú estableces las reglas de aprobación. Los borradores pueden prepararse para la revisión del representante, enviarse a través de herramientas conectadas solo después de la aprobación o bajo una regla de repetición limitada explícita, o nunca enviarse automáticamente. Una implementación más segura primero mantiene todo bajo revisión y luego flexibiliza las reglas solo cuando el riesgo es bajo.',
        },
        {
          q: '¿Cómo aprende Duet nuestra voz?',
          a: 'Muéstrele emails enviados reales y algunas ganancias. Adopta cadencia, vocabulario y estilo de cierre. A medida que corrige borradores, se acerca más a la voz del representante. La misma voz se transmite a través de seguimientos, secuencias y respuestas entrantes, por lo que la bandeja de entrada del cliente potencial se siente consistente.',
        },
        {
          q: '¿Cumple con las industrias reguladas?',
          a: 'Los workspaces están aislados, los datos se limitan a tu organización y el envío saliente respeta CAN-SPAM y tus listas de supresión. Habla con nosotros sobre marcos de cumplimiento específicos (SOC2, configuraciones alineadas con HIPAA): analizaremos lo que existe hoy y lo que hay en la hoja de ruta.',
        },
        {
          q: '¿Qué pasa con la capacidad de entrega? ¿Los emails enviados por AI no serán marcados como spam?',
          a: 'Duet envía desde tu dominio, a través de tu buzón calentado, con límites de velocidad que reflejan el ritmo de un DEG humano. Sin explosiones masivas, sin remitentes falsificados, sin huellas dactilares que griten bot. Las secuencias pueden pausarse cuando la herramienta de envío expone señales de reputación o capacidad de entrega y luego hacer ping al representante antes de que se envíen más emails; la integración ESP subyacente maneja SPF, DKIM y DMARC de la forma en que tu equipo de TI ya los configuró.',
        },
      ],
      relatedSlugs: EN_USE_CASE_PERSONAS[3]!.relatedSlugs,
      leaves: EN_USE_CASE_PERSONAS[3]!.leaves,
      lastUpdated: EN_USE_CASE_PERSONAS[3]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_PERSONAS[4]!.slug,
      name: 'Equipos de operaciones',
      shortName: 'Operaciones',
      navLabel: 'Equipos de operaciones',
      eyebrow: 'Para equipos de operaciones',
      h1Lead: 'AI para operaciones que prefieren',
      h1Highlight: 'arreglar el sistema que disparar.',
      metaTitle: 'AI para equipos de operaciones | Automatizar lo aburrido | Duet',
      metaDescription:
        'Duet es AI para equipos de operaciones. Programa reuniones, automatiza documentos, envía informes recurrentes y clasifica los tickets para que las operaciones arreglen el sistema, no los tiroteos.',
      primaryKeyword: 'AI para equipos de operaciones',
      secondaryKeywords: [
        'AI para operaciones',
        'automatización de operaciones',
        'AI para gerentes de operaciones',
        'asistente de AI de programación',
        'AI para el back office',
      ],
      heroDescription:
        'Operaciones es la función que absorbe los impuestos de todos los demás. Duet es AI para equipos de operaciones que quieren dejar de ser la mesa de ayuda: ejecuta el tetris de programación, la gestión de documentos, el informe semanal y la clasificación de soporte, para que tu equipo de operaciones finalmente pueda arreglar el sistema en lugar de ser el sistema.',
      definition:
        'Un compañero de trabajo con IA para operaciones es un compañero de IA persistente, en la nube, que maneja el trabajo recurrente de back office que un líder de ops suele hacer manualmente: extracción de documentos, seguimiento de proveedores y renovaciones, scheduling, reporting interno y triage de soporte. Se conecta a los sistemas que ya usas, recuerda el contexto del proceso y ejecuta las piezas repetitivas bajo tus reglas de revisión para que el equipo de operaciones deje de ser el cuello de botella.',
      painCards: [
        {
          title: 'La programación de reuniones es un trabajo de tiempo completo',
          quote: '"La mitad de mi semana es Tetris de calendario".',
          body: 'Duet lee la solicitud, revisa los calendarios, propone el espacio y prepara la invitación según las reglas de tu calendario. Todo el intercambio se convierte en un solo mensaje, y el mismo flujo se ejecuta para renovaciones, QBR, incorporaciones de clientes y todo el personal que sigues reprogramando.',
        },
        {
          title: 'Los documentos se mueven a mano.',
          quote: '"Literalmente volvemos a escribir el contrato en la hoja de renovación".',
          body: 'Duet extrae campos de contratos, MSA y formularios de incorporación; los escribe en los sistemas correctos; y marca todo lo que no coincide. Los datos residen en un solo lugar en lugar de tres, y las renovaciones dejan de sorprenderte porque las fechas estaban enterradas en un PDF.',
        },
        {
          title: 'Los informes semanales se agotan el viernes',
          quote: '"Pierdo demasiado el foco del viernes en un solo PDF".',
          body: 'Duet compila el informe (métricas, resúmenes, gráficos) directamente desde los sistemas de origen y lo envía por email a la lista de distribución según lo programado. La ventana de informes se convierte en un pase de revisión en lugar de un trabajo de ensamblaje manual, y el informe aún se puede enviar cuando tú no estés.',
        },
      ],
      useCases: [
        {
          id: EN_USE_CASE_PERSONAS[4]!.useCases[0]!.id,
          title: 'Programar reuniones y coordinar calendarios',
          prompt:
            'Reserva una llamada de incorporación de 30 minutos entre Sara (sara@example.com) y nuestro equipo de CSM la próxima semana. Prefiero los martes y jueves por la tarde en la zona horaria de Sara. Envía una invitación de calendario con el documento de incorporación adjunto.',
          outcome: 'Un mensaje en lugar de ping-pong de calendario',
        },
        {
          id: EN_USE_CASE_PERSONAS[4]!.useCases[1]!.id,
          title: 'Automatizar los flujos de trabajo de documentos',
          prompt:
            'Cuando un MSA firmado llega a /contracts,, extrae la contraparte, la fecha de inicio, el plazo y el valor total. Escribe una fila en la hoja de renovaciones y cree un ticket en Linear antes de la renovación.',
          outcome: 'Renovaciones rastreadas sin un humano',
        },
        {
          id: EN_USE_CASE_PERSONAS[4]!.useCases[2]!.id,
          title: 'Envía informes y paneles recurrentes',
          prompt:
            'Con una cadencia semanal, extrae números recientes de Mixpanel, Stripe y HubSpot. Genera el informe de operaciones semanal en PDF y envíalo por email a la distribución de liderazgo.',
          outcome: 'Un ritual más limpio para informar los viernes',
        },
        {
          id: EN_USE_CASE_PERSONAS[4]!.useCases[3]!.id,
          title: 'Clasificación de tickets de soporte y solicitudes entrantes',
          prompt:
            'Para cada ticket nuevo de Zendesk: etiquete la urgencia, sugiera la respuesta macro correcta, adjunte el registro del cliente vinculado y haga ping al ingeniero de guardia si la prioridad es alta.',
          outcome: 'Las multas urgentes aumentaron claramente',
        },
      ],
      comparison: {
        without: [
          'Equipo de operaciones enterrado en hilos de calendario y clasificación de bandejas de entrada.',
          'Datos del contrato reescritos en 3 sistemas diferentes.',
          'Atención perdida en un informe. Luego otro informe.',
          'Los boletos se acumulan; Las infracciones de SLA aparecen en los QBR.',
        ],
        with: [
          'Programación, admisión y enrutamiento manejados por Duet.',
          'Los datos de los documentos fluyen hacia los sistemas de registro según tus reglas de enrutamiento.',
          'Informes compilados, formateados y entregados a tiempo.',
          'Los tickets se clasificaron rápidamente y las escaladas se marcaron claramente.',
        ],
      },
      howItWorks: [
        {
          step: EN_USE_CASE_PERSONAS[4]!.howItWorks[0]!.step,
          title: 'Mapear los flujos de trabajo',
          body: 'Guía a Duet por los flujos que consumen tu semana: reglas de programación, plantillas de documentos, formatos de informes y SLA de tickets. Guarda cada uno como un playbook reutilizable en los Archivos del workspace para que la siguiente persona de operaciones no tenga que explicar el sistema desde cero.',
        },
        {
          step: EN_USE_CASE_PERSONAS[4]!.howItWorks[1]!.step,
          title: 'Conecta los sistemas',
          body: 'Conecta calendarios, Drive, Notion, Slack, Linear, Zendesk, tu almacén de datos. Duet lee, escribe y activa en la pila mediante permisos de alcance, y los flujos de trabajo pueden reutilizar una conexión una vez que está conectada.',
        },
        {
          step: EN_USE_CASE_PERSONAS[4]!.howItWorks[2]!.step,
          title: 'Ejecutar según lo programado, según el evento y según demanda',
          body: 'Los flujos de trabajo se activan en cron (el informe semanal), en un evento (se concreta un contrato) o bajo demanda (alguien pregunta en Slack). Puedes ver lo que se ejecutó y lo que necesita un humano en una sola transmisión, sin tener que buscar entre cinco registros de herramientas diferentes.',
        },
      ],
      faqs: [
        {
          q: '¿En qué se diferencia de Zapier o Make?',
          a: 'Zapier y Make son plomería determinista: si X, entonces Y. Duet maneja los pasos intermedios que necesitan juicio: analizar un contrato desconocido, escribir un email a un cliente, decidir qué manual se aplica. Utiliza disparadores estilo Zapier donde encajan y razona a través de las partes que no lo hacen.',
        },
        {
          q: '¿Puede escribir en nuestros sistemas de registro?',
          a: 'Duet puede conectarse a entornos de operaciones mediante integraciones administradas, API, exportaciones CSV o configuración personalizada según el sistema. Los flujos de Google Workspace, Notion, Linear, Asana, Jira, Zendesk, HubSpot, Salesforce, Snowflake y BigQuery deben delimitarse por permisos, campos y reglas de aprobación antes de habilitar el acceso de escritura.',
        },
        {
          q: '¿Cómo mantenemos las puertas de aprobación donde importan?',
          a: 'Los defines por flujo de trabajo. Cualquier cosa que Duet escriba externamente (emails, mensajes dirigidos al cliente, cambios de contrato) puede pasar por un paso de aprobación humana antes de publicarse. Las actualizaciones internas de bajo riesgo (mover un ticket, actualizar un campo de CRM) se pueden ejecutar sin revisión manual cuando tú así lo desees; Las escrituras confidenciales pueden permanecer revisadas.',
        },
        {
          q: '¿Qué pasa si un flujo de trabajo se interrumpe?',
          a: 'Duet registra cada ejecución y muestra fallas. Puedes reproducir una ejecución fallida, editar el flujo de trabajo en lenguaje natural y volver a ejecutarlo, sin necesidad de profundizar en los registros de integración. El error te indica qué paso falló y qué intentaba hacer en términos humanos.',
        },
        {
          q: '¿Cuánto falta para que veamos el tiempo atrás?',
          a: 'Duet está diseñado para reducir el trabajo de coordinación recurrente que consume los calendarios de operaciones. Los beneficios se concentran en los flujos de trabajo recurrentes que ejecuta: la programación y los informes recurrentes son puntos de partida comunes, y los flujos de trabajo de documentos llegan después de que Duet haya visto suficientes variantes de los formatos entrantes.',
        },
        {
          q: '¿Reemplaza a nuestro gerente de operaciones?',
          a: 'No. Los gerentes de operaciones diseñan el sistema; Duet lo ejecuta. La forma del trabajo cambia: menos tiempo con el teclado, más tiempo en los flujos de trabajo que solía omitir porque tardaban demasiado en conectarse. Los equipos de operaciones utilizan Duet para asumir una función para la que no podían dotar de personal y replantear el rol de coordinador a diseñador de sistemas.',
        },
      ],
      relatedSlugs: EN_USE_CASE_PERSONAS[4]!.relatedSlugs,
      leaves: EN_USE_CASE_PERSONAS[4]!.leaves,
      lastUpdated: EN_USE_CASE_PERSONAS[4]!.lastUpdated,
    },
  ],
} satisfies Record<AppLocale, UseCasePersona[]>

const useCaseJobsCopy = {
  en: EN_USE_CASE_JOBS,
  'es-419': [
    {
      slug: EN_USE_CASE_JOBS[0]!.slug,
      title: 'Atención al cliente',
      h1: 'Entregar atención al cliente a un compañero de AI',
      metaTitle: 'AI para atención al cliente | Triaje y Draft | Duet',
      metaDescription:
        'Duet redacta, clasifica, escala y prepara respuestas de soporte para tu revisión, manteniendo los tickets de rutina en movimiento según tus reglas de aprobación.',
      intro:
        'La atención al cliente es donde las pequeñas empresas pierden tiempo. Duet es un compañero de AI que redacta, clasifica, escala y prepara respuestas para tu revisión, luego mantiene los tickets de rutina en movimiento según tus reglas de aprobación. La bandeja de entrada se prepara antes de que te sientes por la mañana, no un cementerio el viernes.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[0]!.jobSteps[0]!.step,
          title: 'Conecta tu bandeja de entrada de soporte y documentos de ayuda',
          body: 'Apunta Duet a support@ (Gmail, Help Scout, Gorgias, Zendesk, Intercom o IMAP simple) y a tu centro de ayuda, páginas de preguntas frecuentes y política de reembolso. Duet ingiere tickets recientes y tu base de conocimientos, por lo que la primera respuesta ya te suena a ti.',
        },
        {
          step: EN_USE_CASE_JOBS[0]!.jobSteps[1]!.step,
          title: 'Enséñale tu voz con las respuestas reales.',
          body: 'Incluye las respuestas reales que enviaste (las desordenadas, las largas, las cortas) para que Duet aprenda el tono, la firma, la postura de reembolso predeterminada y las frases que usas cuando algo sale mal. El resto del libro de jugadas hereda de esos ejemplos.',
        },
        {
          step: EN_USE_CASE_JOBS[0]!.jobSteps[2]!.step,
          title: 'Establece las reglas de escalada',
          body: 'Dile a Duet lo que quieres ver tú mismo: solicitudes de reembolso de alto valor, riesgo de abandono, cualquier cosa que mencione a un abogado, cualquier cosa de un cliente estratégico. Todo lo demás se redacta en colas de envío o de revisión según tu umbral de confianza.',
        },
        {
          step: EN_USE_CASE_JOBS[0]!.jobSteps[3]!.step,
          title: 'Déjalo clasificar cada boleto nuevo',
          body: 'Llegan nuevos tickets, Duet los clasifica en segundos, redacta una respuesta, adjunta el enlace del documento de ayuda correspondiente y etiqueta el ticket. Verás una cola limpia con tres depósitos: enviar tal cual, editar y enviar y necesitarme.',
        },
        {
          step: EN_USE_CASE_JOBS[0]!.jobSteps[4]!.step,
          title: 'Prepara respuestas aprobadas para las más fáciles.',
          body: 'Restablecimiento de contraseñas, verificación del estado de los pedidos, copias de facturas, acuses de recibo de reembolso: Duet prepara o dirige las respuestas a través del servicio de asistencia técnica conectado después de la aprobación o según reglas explícitas, registra la acción y mantiene el ticket en movimiento. El cliente obtiene una respuesta rápida y útil en lugar de esperar una respuesta el lunes por la mañana.',
        },
        {
          step: EN_USE_CASE_JOBS[0]!.jobSteps[5]!.step,
          title: 'Obtén un resumen de soporte recurrente',
          body: 'Con una cadencia semanal, Duet deja caer un resumen de un párrafo en tu bandeja de entrada: tickets manejados, tres temas principales, cualquier cosa que te esté esperando y qué cambió en las preguntas de tus clientes esta semana.',
        },
      ],
      faqs: [
        {
          q: '¿Realmente sonará como yo o los clientes detectarán el robot?',
          a: 'Duet lee ejemplos aprobados de tus respuestas recientes dentro de tu workspace, por lo que puede usar tu aprobación, tus disculpas, tu postura de reembolso y las frases específicas que usa cuando algo salió mal como contexto. El objetivo es que las respuestas de rutina suenen lo suficientemente cercanas como para que la primera pasada de revisión se trate de pequeñas correcciones, no de reescrituras desde cero.',
        },
        {
          q: '¿Qué sucede cuando un cliente está enojado o el ticket es delicado?',
          a: 'Tú estableces las reglas de escalada. Solicitudes de reembolso que superen un umbral, riesgo de abandono, cualquier cosa que mencione acciones legales, cualquier cosa de un cliente importante: Duet las marca, redacta una respuesta empática y dirige el ticket a la cola que tú mismo supervisa. Los riesgosos nunca son enviados sin ti.',
        },
        {
          q: '¿Con qué bandejas de entrada y servicios de asistencia técnica funciona?',
          a: 'Duet puede conectarse a bandejas de entrada y servicios de asistencia mediante integraciones administradas, API, IMAP, CSV o configuración personalizada según el proveedor. Para Gmail, Outlook, Help Scout, Gorgias, Zendesk, Intercom, Front, Freshdesk y Crisp, define los permisos exactos de lectura, borrador y escritura durante la configuración.',
        },
        {
          q: '¿Cuánto tiempo pasará hasta que las multas se manejen realmente, y no sólo se redacten?',
          a: 'Los equipos deben pasar de envíos redactados para revisión a envíos explícitamente habilitados categoría por categoría. El camino más seguro es comenzar con un grupo bien definido (estado del pedido o restablecimiento de contraseña), habilitar reglas de envío limitadas una vez que los borradores se vean bien y luego expandirlas desde allí.',
        },
        {
          q: '¿Cuánto cuesta en comparación con un agente de soporte o un complemento de servicio de asistencia técnica?',
          a: 'Un contratista de soporte a tiempo parcial y los complementos del servicio de asistencia técnica AI pueden convertirse en líneas de pedido significativas. Duet ofrece planes mensuales con créditos incluidos y una reserva para uso adicional; compara el plan actual con el volumen de tickets.',
        },
        {
          q: '¿Duet reemplaza a mi equipo de soporte?',
          a: 'No. Duet maneja el volumen repetible para que tu equipo pueda concentrarse en conversaciones que realmente necesitan un ser humano. Las comprobaciones de estado, los restablecimientos y los acuses de recibo de reembolso pueden salir de la cola; Los tickets con mucho juicio llegan al escritorio de un ser humano más rápido, con más contexto y sin retrasos.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[0]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[0]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[0]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[1]!.slug,
      title: 'Ventas y salida',
      h1: 'Ejecuta ventas salientes con un compañero de AI',
      metaTitle: 'AI para ventas salientes | Prospecto, borrador, revisión | Duet',
      metaDescription:
        'Duet encuentra clientes potenciales, enriquece los clientes potenciales, redacta los primeros toques, realiza un seguimiento y registra las respuestas de un workspace de un compañero de AI.',
      intro:
        'La salida es el trabajo que los equipos pequeños se saltan porque consume la semana. Duet es un compañero de AI que coordina los flujos de trabajo salientes desde la prospección hasta el registro de respuestas: crear tu lista de prospectos, enriquecer los clientes potenciales, redactar los primeros toques con tu voz y ejecutar el ciclo de administración del canal sin que tú lo cuides. Movimiento de venta que compone, sin contratar DEG.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[0]!.step,
          title: 'Define tu PCI en un párrafo',
          body: 'Describe a quién les vendes en un lenguaje sencillo: industria, plantilla, geografía, el factor que los prepara para comprar. Duet lo convierte en un filtro estructurado que puede volver a ejecutar en cualquier momento sin tocar una pantalla de CRM.',
        },
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[1]!.step,
          title: 'Construye la lista de prospectos',
          body: 'Duet extrae cuentas coincidentes de Crustdata, Apollo, Clay o LinkedIn Sales Navigator (lo que ya pagas), enriquece cada contacto con email + título + antigüedad y deduplica tu CRM para que nunca envíes emails a la misma persona dos veces.',
        },
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[2]!.step,
          title: 'Elige el disparador que hace que el toque sea relevante',
          body: 'Ronda de financiación reciente, nueva contratación en el equipo, una oferta de trabajo, un cambio de pila: Duet observa las señales que te interesan y solo alinea la comunicación cuando hay una razón real para enviar un email hoy, no solo una lista con un botón ENVIAR.',
        },
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[3]!.step,
          title: 'Escribe el primer toque en tu voz.',
          body: 'Duet redacta un email conciso vinculado al desencadenante, hace referencia a un aspecto específico sobre el cliente potencial y cierra la sesión con tu voz. Revisa el primer lote uno al lado del otro; Los borradores aprobados se pueden enviar a tu herramienta de envío, mientras que los borradores riesgosos o con nuevos patrones permanecen en revisión.',
        },
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[4]!.step,
          title: 'Prepara la cadencia para tu herramienta de envío',
          body: 'Duet prepara la cadencia para Instantly, Smartlead, Lemlist o Gmail cuando esté conectado; tu herramienta de envío maneja el calentamiento, la limitación y las reglas de dominio.',
        },
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[5]!.step,
          title: 'Manejar las respuestas de la misma manera que clasifica el soporte',
          body: 'Respuesta positiva, reunión reservada, persona no adecuada, no suave, cancelación de suscripción: Duet clasifica cada respuesta, redacta el siguiente paso correcto y prepara un enlace de reserva o una retención de calendario para tu revisión. Nada pasa desapercibido porque la bandeja de entrada no es donde la canalización muere.',
        },
        {
          step: EN_USE_CASE_JOBS[1]!.jobSteps[6]!.step,
          title: 'Obtén un resumen semanal del proceso',
          body: 'Con una cadencia semanal, Duet envía una instantánea: respuestas de esta semana, reuniones reservadas, patrones principales por respuesta (industria, persona, desencadenante) y qué campaña duplicar. El siguiente paso es obvio, no está escondido en un tablero de instrumentos en expansión.',
        },
      ],
      faqs: [
        {
          q: '¿Es esta simplemente otra herramienta de "AI email frío"?',
          a: 'No. Duet está diseñado para el ciclo completo (filtro ICP, creación de listas, enriquecimiento, detección de activadores, redacción, envío, clasificación de respuestas, seguimiento) en un workspace con un compañero de AI que recuerda todo. Las herramientas de email en frío puntuales son más eficaces en el paso de redacción o secuenciación; Duet es para conectar los pasos alrededor.',
        },
        {
          q: '¿Cómo evita las carpetas de spam y el desastre de entregabilidad al que se enfrenta todo fundador?',
          a: 'Duet entrega el envío real a tu herramienta existente (Instantly, Smartlead, Lemlist) que ya maneja el calentamiento, la rotación de dominios y la limitación por bandeja de entrada. El trabajo de Duet es el trabajo previo que hace que la capacidad de entrega sea importante: listas más pequeñas y relevantes, un activador por envío y una copia que no parece una explosión genérica enviada la misma semana.',
        },
        {
          q: '¿Escribirá una copia digna de una reunión?',
          a: 'El texto digno de una reunión es breve, específico y tiene en cuenta los desencadenantes: Duet escribe según ese patrón porque lee el desencadenante, el último movimiento de rol del cliente potencial y sus mejores respuestas de la historia reciente. No es una variable de personalización genérica; el email en realidad hace referencia a lo que hizo que valiera la pena enviarle un email al cliente potencial.',
        },
        {
          q: '¿Cómo se integra con mi CRM?',
          a: 'Duet puede conectarse a flujos de CRM mediante integraciones administradas, API, CSV o configuración personalizada según el sistema. Para HubSpot, Salesforce, Attio, Pipedrive, Folk o Notion como CRM, define los permisos exactos de lectura, escritura, deduplicación y etapa del ciclo de vida antes de ejecutar una campaña.',
        },
        {
          q: '¿Cuánto cuesta respecto a contratar un DEG?',
          a: 'Contratar un SDR es una apuesta de costo fijo importante, ya sea internamente o en el extranjero. Los planes mensuales de Duet hacen que la investigación saliente, los borradores y las actualizaciones de CRM sean más fáciles de probar antes de ampliar la plantilla.',
        },
        {
          q: '¿Se sentirá automatizado el alcance?',
          a: 'Solo si lo permites. Duet escribe según tu tono, hace referencia al disparador específico y limita el volumen de envío a lo que haría un SDR humano cuidadoso en una semana. El objetivo es preservar la calidad de la investigación y la especificidad de la divulgación escrita a mano, eliminando al mismo tiempo la redacción repetitiva y el trabajo de CRM.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[1]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[1]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[1]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[2]!.slug,
      title: 'Clasificación de bandeja de entrada',
      h1: 'Clasifique tu bandeja de entrada con un compañero de AI',
      metaTitle: 'AI Clasificación de bandeja de entrada | Leer, redactar, escalar | Duet',
      metaDescription:
        'Duet clasifica las bandejas de entrada compartidas, resume el día, redacta respuestas en tu voz, marca temas urgentes y sigue tus reglas de aprobación.',
      intro:
        'No tienes un problema con el email: tienes un problema de atención disfrazado de problema con el email. Duet es un compañero de AI que lee mensajes nuevos según un cronograma, redacta respuestas con tu voz, marca los que realmente te necesitan y borra el resto. La bandeja de entrada se prepara antes de la revisión.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[2]!.jobSteps[0]!.step,
          title: 'Conecta tu bandeja de entrada',
          body: 'Gmail, Outlook o IMAP simple. Duet se autentica a través de OAuth, lee mensajes recientes y utiliza el remitente y los patrones de hilo que tú apruebas para separar las conversaciones urgentes del ruido.',
        },
        {
          step: EN_USE_CASE_JOBS[2]!.jobSteps[1]!.step,
          title: 'Enséñale tus prioridades en lenguaje natural',
          body: '"Los clientes siempre, los proveedores después, los boletines informativos de baja prioridad, la facturación es urgente". Un párrafo es suficiente; Duet lo convierte en el conjunto de reglas que decide qué aterriza en el escritorio y qué no.',
        },
        {
          step: EN_USE_CASE_JOBS[2]!.jobSteps[2]!.step,
          title: 'Programa el pase nocturno',
          body: 'Mientras duermes, Duet lee cada hilo nuevo, redacta borradores de respuestas para los que las necesitan, etiqueta el ruido probable para la revisión por lotes y etiqueta el resto por intención (ventas, soporte, facturación, reclutamiento, personal) utilizando los mismos grupos en los que ya se ejecuta tu flujo de trabajo real.',
        },
        {
          step: EN_USE_CASE_JOBS[2]!.jobSteps[3]!.step,
          title: 'Despierta con una cola clasificada, no con una pila sin leer',
          body: 'Tu bandeja de entrada se abre con tres cosas: un resumen de un párrafo en la parte superior, una pequeña lista de "lo necesita" y una carpeta de respuestas redactadas en espera de un solo clic de aprobación. Todo lo demás está en cola, etiquetado o preparado para revisión según tus reglas.',
        },
        {
          step: EN_USE_CASE_JOBS[2]!.jobSteps[4]!.step,
          title: 'Aprobar borradores en un solo barrido',
          body: 'Haz clic en la cola de borradores: aceptar, editar, rechazar. Duet recuerda cada edición, por lo que el siguiente lote necesita menos correcciones, y los rechazos entrenan las reglas para que deje de redactar los tipos de respuestas que en realidad no deseas que se envíen.',
        },
        {
          step: EN_USE_CASE_JOBS[2]!.jobSteps[5]!.step,
          title: 'Obtén un resumen del viernes por la tarde',
          body: 'Con una cadencia semanal, Duet envía un resumen: los principales remitentes de esta semana, qué cambió (más spam de reclutadores, menos preguntas de los clientes), hilos que marcó como importantes pero a los que nunca respondió y los bucles abiertos que vale la pena cerrar antes del lunes.',
        },
      ],
      faqs: [
        {
          q: '¿Es seguro darle acceso a AI a mi bandeja de entrada?',
          a: 'Duet se autentica a través de OAuth estándar (el mismo flujo que utilizan Gmail y Outlook para cualquier app de terceros) y se ejecuta en tu propio servidor de nube privado, no en un modelo compartido. Tus mensajes no entrenan un modelo básico y no se combinan con los datos de otros clientes. El registro de auditoría muestra cada lectura, borrador y envío para que puedas ver exactamente lo que Duet ha tocado.',
        },
        {
          q: '¿Qué pasa si redacta una respuesta incorrecta en un hilo sensible?',
          a: 'Tú pones la regla. De forma predeterminada, todo lo que marques como personal, todo lo que involucre dinero por encima de un umbral y todo lo etiquetado como "sensible" recibe un borrador, pero nunca un envío automático: la respuesta te espera. A medida que lo entrena con tus ediciones, puede aumentar el umbral de confianza para las categorías de envío habilitadas explícitamente y, al mismo tiempo, mantenerlo bajo en las categorías de riesgo.',
        },
        {
          q: '¿En qué se diferencia de la respuesta inteligente integrada de Gmail?',
          a: 'La respuesta inteligente sugiere tres frases cortas; Duet escribe la respuesta completa, hace referencia al contexto del hilo, hace referencia a hilos anteriores con la misma persona y decide si redactar, escalar o utilizar una regla de envío habilitada explícitamente. El trabajo no es sugerir una frase más rápido, sino hacer que la bandeja de entrada te necesite menos para un trabajo repetible.',
        },
        {
          q: '¿Todo mi equipo puede usar esto en una bandeja de entrada compartida como support@ o sales@?',
          a: 'Sí. Duet se ejecuta en bandejas de entrada compartidas de la misma manera que en las personales: lee, redacta borradores, escala y sigue las reglas de envío que tú habilitas explícitamente, y puede configurar las reglas por bandeja de entrada. Una configuración común es soporte@ con reglas de aprobación estrictas para categorías fáciles y ventas@ en modo borrador y revisión mientras el equipo aún está aprendiendo cómo se interpretan los primeros toques de Duet.',
        },
        {
          q: '¿Cuánto volumen de email es demasiado para Duet?',
          a: 'Duet está diseñado para la clasificación de bandejas de entrada de gran volumen porque el trabajo pesado (clasificación y redacción) se ejecuta en la misma infraestructura de espacio aislado que alimenta el resto del workspace. En la práctica, la política de aprobación y la capacidad de revisión suelen ser los obstáculos para planificar.',
        },
        {
          q: '¿Funciona en otros idiomas además del inglés?',
          a: 'Sí. Duet redacta borradores de respuestas en el idioma utilizado en el mensaje original y puede establecer preferencias de idioma por regla ("responder a los clientes franceses en francés, todo lo demás en inglés"). El clasificador de triaje es multilingüe; los borradores heredan el tono de tus respuestas anteriores en ese idioma.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[2]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[2]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[2]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[3]!.slug,
      title: 'marketing de contenidos',
      h1: 'Ejecuta marketing de contenidos con un compañero de AI',
      metaTitle: 'AI para marketing de contenidos | Investigación, Proyecto, Barco | Duet',
      metaDescription:
        'Duet investiga temas, redacta publicaciones con tu voz, programa canales, reutiliza logros e informa sobre lo que funcionó.',
      intro:
        'Muchas PYMES envían contenido como un proyecto paralelo, cuando alguien finalmente tiene tiempo este trimestre. Duet es un compañero de AI que ejecuta contenido como una función: investiga lo que funciona, redacta borradores con tu voz, programa todos los canales, reutiliza las ganancias e informa sobre lo que obtuvo. El volante finalmente gira.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[3]!.jobSteps[0]!.step,
          title: 'Define los temas que quieres posicionar',
          body: 'Dile a Duet los tres o cuatro temas para los que tu empresa debería clasificarse y las audiencias a las que escribe. Crea un mapa de temas, asigna cada tema a los problemas del cliente que resuelve y extrae las palabras clave que coinciden, sin necesidad de un consultor de SEO.',
        },
        {
          step: EN_USE_CASE_JOBS[3]!.jobSteps[1]!.step,
          title: 'Investiga el ángulo que vale la pena escribir',
          body: 'Para cada tema, Duet extrae lo que ya está clasificado, lo que citan actualmente las resúmenes de AI y en qué se equivoca el contenido competitivo. Obtiene un resumen de una página con un ángulo claro, una palabra clave objetivo, un esquema y las tres fuentes a las que vale la pena hacer referencia.',
        },
        {
          step: EN_USE_CASE_JOBS[3]!.jobSteps[2]!.step,
          title: 'Redacta la publicación con tu voz.',
          body: 'Duet escribe un borrador extenso utilizando tu blog existente como referencia de voz, con la estructura adecuada (títulos de sección claros, bloque de preguntas frecuentes, párrafo inicial) y conceptos básicos de SEO integrados (metatítulo, descripción, JSON-LD). Es un borrador real que un editor puede enviar, no un primer paso que deba reescribirse.',
        },
        {
          step: EN_USE_CASE_JOBS[3]!.jobSteps[3]!.step,
          title: 'Preparar el borrador o PR del CMS',
          body: 'WordPress, Webflow, Ghost, Sanity, Contentful o Markdown a GitHub: Duet puede preparar un borrador de CMS o relaciones públicas a través de la ruta de integración que tú habilites, con imágenes para compartir en redes sociales listas para tu revisión. Las sugerencias de enlaces internos aparecen en el mismo PR/borrador para que el artículo se envíe con el gráfico de enlaces que necesita.',
        },
        {
          step: EN_USE_CASE_JOBS[3]!.jobSteps[4]!.step,
          title: 'Reutilizar en LinkedIn, X y el boletín',
          body: 'Cada publicación extensa se convierte en un carrusel de LinkedIn, un hilo X, dos respuestas a conversaciones existentes y una sección del próximo boletín. Duet escribe cada variante según las normas reales del canal; ni ​​un solo mensaje se vuelve a publicar cinco veces.',
        },
        {
          step: EN_USE_CASE_JOBS[3]!.jobSteps[5]!.step,
          title: 'Haz seguimiento de lo que funcionó y duplique',
          body: 'Duet extrae GSC, Plausible, GA4 y las plataformas sociales una vez por semana, identifica las publicaciones que generaron tráfico o respuestas y propone los siguientes tres artículos basándose en lo que los lectores realmente interactúan, no en lo que parecía inteligente en la lluvia de ideas.',
        },
      ],
      faqs: [
        {
          q: '¿La escritura sonará como AI basura?',
          a: 'No si Duet tiene tu blog y tus redes sociales como referencias de voz. Los borradores recogen el ritmo de las oraciones, la forma en que haces la transición entre secciones, tu tic de usar guiones largos o párrafos cortos: las pequeñas elecciones que hacen que una pieza suene como una persona, no como una plantilla. El pase de editor es una edición real, no una reescritura desde cero.',
        },
        {
          q: '¿Cómo me aseguro de que el SEO realmente funcione?',
          a: 'Cada borrador se entrega con los conceptos básicos que Google ahora espera en un contenido: un H1 real, H2 semánticos, un bloque de preguntas frecuentes estructurado con la página de preguntas frecuentes JSON-LD, enlaces internos a páginas relevantes y metaetiquetas que coinciden con el cuerpo. Duet no creará clasificaciones sobre una palabra clave obsoleta: investiga qué está ganando actualmente antes de redactar.',
        },
        {
          q: '¿Puede escribir para AI descripciones generales/búsqueda ChatGPT/Perplexity, no solo para Google?',
          a: 'Sí. El breve paso analiza lo que las resúmenes de AI ya citan para la consulta de destino y también escribe el ángulo que se citará: breve resumen en la parte superior, declaraciones fácticas sencillas con citas, bloque de preguntas frecuentes con respuestas claras. La misma estructura de recompensas de Google es la estructura AI de recompensas de búsqueda, por lo que no está dividiendo el esfuerzo en dos estrategias.',
        },
        {
          q: '¿Para qué CMS puede preparar borradores?',
          a: 'Duet puede preparar borradores, exportaciones o PR de CMS mediante Integraciones, API, flujos basados en Git, exportaciones o configuración personalizada según el CMS. Para WordPress, Webflow, Ghost, Sanity, Contentful, Strapi, Notion, Hashnode, dev.to o Markdown-to-GitHub, define los permisos de borrador y PR antes de habilitar una ruta que publique en vivo.',
        },
        {
          q: '¿Cuánto contenido puede enviar por semana?',
          a: 'Una cadencia SMB sostenible es una publicación enfocada de formato largo y una reutilización en los canales que tu audiencia realmente lee. Puedes aumentar el volumen más adelante, pero los beneficios provienen de combinar el mismo grupo de temas, no de publicar más por sí solo.',
        },
        {
          q: '¿Reemplaza a un comercializador de contenidos?',
          a: 'No. Se encarga del trabajo que nadie en el equipo tiene tiempo para hacer. Un especialista en marketing de contenidos diseña la estrategia, elige los temas y revisa los borradores; Duet realiza la investigación, la redacción, la publicación y la reutilización. La producción del especialista en marketing va desde una publicación al mes hasta una función de contenido que se ejecuta en un calendario.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[3]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[3]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[3]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[4]!.slug,
      title: 'Contabilidad',
      h1: 'Llevar la contabilidad con un compañero de AI',
      metaTitle: 'AI para contabilidad | Conciliar, marcar, informar | Duet',
      metaDescription:
        'Duet ejecuta operaciones de contabilidad para equipos eficientes: clasifica transacciones, concilia cuentas, señala anomalías y envía informes mensuales limpios.',
      intro:
        'La contabilidad no debería consumir las mismas horas del fundador todos los meses. Duet se conecta a las herramientas que ya utilizas, clasifica las transacciones, concilia las coincidencias obvias, señala las extrañas y te brinda un paquete mensual limpio para revisar o enviar a tu socio financiero. Te mantienes delgado sin dejar que los libros se desvíen.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[4]!.jobSteps[0]!.step,
          title: 'Conecta tu pila de contabilidad',
          body: 'Conecta QuickBooks, Xero, Stripe, Plaid, Mercury, Ramp o las exportaciones CSV que ya realiza. Duet lee el plan de cuentas, el historial de proveedores, los nombres de los clientes y las conciliaciones anteriores antes de tocar nuevas transacciones.',
        },
        {
          step: EN_USE_CASE_JOBS[4]!.jobSteps[1]!.step,
          title: 'Enseñar las reglas de categorización.',
          body: 'Explica los casos extremos una vez: el software se destina a suscripciones, los contratistas al costo de los bienes vendidos, las comidas de los clientes se dividen, los reembolsos de los fundadores necesitan recibos. Duet convierte eso en reglas reutilizables en lugar de hacer la misma pregunta todos los meses.',
        },
        {
          step: EN_USE_CASE_JOBS[4]!.jobSteps[2]!.step,
          title: 'Categorizar y relacionar transacciones',
          body: 'Las nuevas transacciones se clasifican según el conjunto de reglas, se relacionan con facturas o recibos y se marcan con confianza. Los artículos de alta confianza se ponen en cola para la aprobación del lote; Los elementos de baja confianza reciben una breve nota que explica lo que Duet necesita de ti.',
        },
        {
          step: EN_USE_CASE_JOBS[4]!.jobSteps[3]!.step,
          title: 'Conciliar las cuentas fáciles',
          body: 'Duet compara saldos bancarios, de tarjetas, de Stripe y contables, resuelve diferencias de tiempo obvias y produce una lista de verificación de conciliación. El objetivo no es fingir que el juicio contable desapareció, sino convertir la revisión humana en una verificación enfocada en lugar de una reconstrucción manual.',
        },
        {
          step: EN_USE_CASE_JOBS[4]!.jobSteps[4]!.step,
          title: 'Señalar anomalías antes de que se vuelvan urgentes',
          body: 'Las suscripciones duplicadas, los gastos inusuales de los proveedores, los recibos faltantes, los depósitos atrasados, las transferencias no categorizadas y las oscilaciones de márgenes surgen como excepciones. Ves un puñado de cosas raras, no todas las líneas de pedido.',
        },
        {
          step: EN_USE_CASE_JOBS[4]!.jobSteps[5]!.step,
          title: 'Envía el paquete mensual',
          body: 'A fin de mes, Duet prepara un paquete conciso: P&L, movimiento de efectivo, preguntas no resueltas, anomalías y los archivos que tu socio financiero necesita. Los libros se convierten en un sistema en funcionamiento, no en un proyecto de arqueología trimestral.',
        },
      ],
      faqs: [
        {
          q: '¿Duet reemplaza a mi socio financiero?',
          a: 'No. Duet realiza las operaciones de contabilidad repetibles para que tu socio financiero pueda revisar un trabajo más limpio y concentrarse en el juicio, los impuestos y el asesoramiento. Los equipos pequeños pueden usar Duet para preparar el paquete de fin de mes mientras cuentan con un revisor humano para tu aprobación.',
        },
        {
          q: '¿Puede escribir directamente en QuickBooks o Xero?',
          a: 'Duet puede conectarse a QuickBooks o Xero a través de API disponibles, exportaciones o cableado personalizado con permisos específicos. Comienza en modo de revisión, luego permite que las categorías de alta confianza se publiquen según tus reglas solo una vez que la configuración haya demostrado su eficacia.',
        },
        {
          q: '¿Cómo maneja Duet transacciones extrañas?',
          a: 'Todo lo que esté por debajo del umbral de confianza se convierte en una excepción con una breve explicación y los documentos fuente adjuntos. Duet no oculta la ambigüedad dentro de una categoría; le pregunta a la persona una vez, recuerda la respuesta y aplica la regla la próxima vez.',
        },
        {
          q: '¿Esto es útil si ya tengo un contable?',
          a: 'Sí. Duet reduce el ir y venir que encarece la contabilidad: búsqueda de recibos, explicaciones de proveedores, limpieza de exportaciones y preparación de paquetes mensuales. Su contable obtiene entradas más limpias y menos filas misteriosas.',
        },
        {
          q: '¿Qué herramientas contables admite?',
          a: 'Duet puede conectarse a flujos de trabajo de contabilidad a través de API, exportaciones, datos conectados a Plaid, CSV o cableado personalizado según la herramienta. Para QuickBooks, Xero, Stripe, Mercury, Ramp, Brex y datos bancarios, define el acceso antes de habilitar las escrituras.',
        },
        {
          q: '¿Duet moverá dinero o aprobará pagos?',
          a: 'No por defecto. Duet puede preparar facturas, categorizar gastos y redactar recordatorios de pagos, pero el movimiento de dinero permanece detrás de una aprobación explícita a menos que establezcas una regla confiable limitada para ello.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[4]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[4]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[4]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[5]!.slug,
      title: 'Operaciones SEO',
      h1: 'Ejecuta operaciones de SEO con un compañero de AI',
      metaTitle: 'AI para operaciones SEO | Auditoría, Enlace, Informe | Duet',
      metaDescription:
        'Duet ejecuta operaciones de SEO para equipos eficientes: audita páginas, encuentra lagunas en las palabras clave, actualiza enlaces internos, monitorea las clasificaciones e informa sobre los cambios.',
      intro:
        'El SEO no es una publicación de blog mágica. Es una cadencia operativa semanal: encontrar los huecos, arreglar las páginas, añadir los enlaces, observar los resultados, repetir. Duet convierte esa cadencia en un compañero de AI siempre disponible para que una pequeña empresa pueda generar impulso de búsqueda sin contratar a una agencia.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[5]!.jobSteps[0]!.step,
          title: 'Mapea las páginas que ya tienes',
          body: 'Duet rastrea tu sitio, lee títulos, descripciones, encabezados, esquemas, enlaces internos e indexabilidad. El primer resultado es un mapa limpio de lo que existe y qué páginas son realmente capaces de clasificarse.',
        },
        {
          step: EN_USE_CASE_JOBS[5]!.jobSteps[1]!.step,
          title: 'Encuentre lagunas de palabras clave que valga la pena tener',
          body: 'Duet extrae Search Console, páginas de la competencia y datos de palabras clave, luego filtra los temas que un equipo eficiente puede ganar de manera realista. Obtiene una breve lista de páginas para crear o actualizar, no un volcado de palabras clave de mil filas.',
        },
        {
          step: EN_USE_CASE_JOBS[5]!.jobSteps[2]!.step,
          title: 'Reescribe las páginas que están cerca.',
          body: 'Para las páginas que ya están cerca de la página uno, Duet actualiza el meta, los encabezados, el bloque de preguntas frecuentes, el esquema y las secciones faltantes en una rama o borrador de CMS. Preserva tu voz y arregla las piezas técnicas aburridas que los humanos evitan.',
        },
        {
          step: EN_USE_CASE_JOBS[5]!.jobSteps[3]!.step,
          title: 'Reparar el gráfico de enlaces internos.',
          body: 'Duet encuentra páginas huérfanas, centros delgados y enlaces faltantes de páginas de alta autoridad. Propone destinos y texto de anclaje exactos para que el sitio comience a comportarse como un árbol deliberado en lugar de un montón de publicaciones.',
        },
        {
          step: EN_USE_CASE_JOBS[5]!.jobSteps[4]!.step,
          title: 'Monitorear clasificaciones y citas AI',
          body: 'Cada semana, Duet verifica las impresiones de búsqueda, los clics, el movimiento de consultas y AI las oportunidades de citas generales. El informe se centra en lo que cambió y qué acción tomar a continuación, no en las capturas de pantalla del panel.',
        },
        {
          step: EN_USE_CASE_JOBS[5]!.jobSteps[5]!.step,
          title: 'Envía una mejora compuesta cada semana',
          body: 'Nuevas preguntas frecuentes, título actualizado, sección de comparación más sólida, esquema faltante, mejor enlace interno, nueva página hoja: Duet mantiene el rastreo en movimiento. El SEO se convierte en un ritmo operativo que un equipo pequeño realmente puede mantener.',
        },
      ],
      faqs: [
        {
          q: '¿Es Duet un reemplazo de agencia de SEO?',
          a: 'Para el trabajo operativo semanal (auditorías, actualizaciones, correcciones de enlaces, informes y resúmenes de contenido), Duet puede cubrir gran parte de lo que las pequeñas empresas subcontratan. Un especialista sigue siendo útil para estrategias, planificación de migración y llamadas técnicas de alto riesgo.',
        },
        {
          q: '¿Puede Duet actualizar mi sitio directamente?',
          a: 'Sí. Duet puede abrir una solicitud de extracción para sitios basados ​​en código o borradores de cambios en WordPress, Webflow, Ghost, Sanity, Contentful u otro CMS. Tú eliges si se publica directamente o espera revisión.',
        },
        {
          q: '¿Cómo evita el contenido SEO genérico?',
          a: 'Duet comienza desde tu producto real, clientes y páginas existentes. Escribe secciones específicas, preguntas frecuentes y enlaces internos basados ​​en lo que tu sitio puede responder de manera creíble, en lugar de producir un montón de palabras clave intercambiables.',
        },
        {
          q: '¿Ayuda con las descripciones generales y los motores de respuestas de Google AI?',
          a: 'Sí. Duet busca secciones de definición, resúmenes fáciles de citar, esquemas de preguntas frecuentes y respuestas estructuradas faltantes. El mismo contenido que es claro para los humanos es más fácil de citar para los sistemas de búsqueda AI.',
        },
        {
          q: '¿Qué tan pronto aparecerán los resultados de SEO?',
          a: 'Las correcciones técnicas y los enlaces internos pueden mover las impresiones después de correcciones específicas, pero las clasificaciones duraderas dependen de la demanda de búsqueda y la competencia. Duet es útil porque sigue enviando pequeñas mejoras cada semana en lugar de permitir que el SEO se convierta en un pánico trimestral.',
        },
        {
          q: '¿Qué fuentes de datos utiliza?',
          a: 'Search Console, análisis, datos de mapas del sitio, resultados del rastreador, páginas de la competencia, proveedores de palabras clave y el sitio mismo. Duet convierte esas entradas en una lista de trabajo priorizada y luego ejecuta el trabajo.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[5]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[5]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[5]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[6]!.slug,
      title: 'Operaciones de boletines',
      h1: 'Ejecuta tu boletín con un compañero de AI',
      metaTitle: 'AI para boletines | Borrar, enviar, aprender | Duet',
      metaDescription:
        'Duet recopila actualizaciones, redacta boletines informativos con tu voz, prepara transmisiones para tu aprobación e informa lo que funcionó después de cada campaña.',
      intro:
        'Un boletín debería ser un motor de distribución, no un viaje de culpa mensual. Duet recopila la semana de actualizaciones de productos, ganancias de clientes, publicaciones y métricas, los convierte en un email ajustado en tu voz, prepara la transmisión en tu proveedor y cierra el círculo con lo que los lectores realmente hicieron clic después de enviar la campaña.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[6]!.jobSteps[0]!.step,
          title: 'Conecta las fuentes de la verdad',
          body: 'Duet lee los lugares donde ya están disponibles tus actualizaciones: GitHub, Linear, Notion, Slack, borradores de blogs, análisis de productos y los últimos boletines. Crea la materia prima sin pedirle a nadie que pegue un resumen en un documento.',
        },
        {
          step: EN_USE_CASE_JOBS[6]!.jobSteps[1]!.step,
          title: 'Elige el ángulo de la semana',
          body: 'Duet agrupa las actualizaciones en temas y propone el más sólido: un lanzamiento, una historia de cliente, un flujo de trabajo que la gente puede copiar o una nota de compilación entre bastidores. El email obtiene un punto en lugar de convertirse en un registro de cambios.',
        },
        {
          step: EN_USE_CASE_JOBS[6]!.jobSteps[2]!.step,
          title: 'Borrador en tu voz y formato',
          body: 'Duet escribe la línea de asunto, el texto de vista previa, el encabezado, las secciones, la CTA y P.D. utilizando tus envíos anteriores como referencia de voz. También crea HTML o Markdown para que coincida con tu plantilla.',
        },
        {
          step: EN_USE_CASE_JOBS[6]!.jobSteps[3]!.step,
          title: 'Preparar la campaña para tu aprobación.',
          body: 'Duet verifica la audiencia, las supresiones, el historial de rebotes y las reglas de segmento antes de la aprobación en Resend, Customer.io, Mailchimp, ConvertKit, Loops o tu proveedor. La parte peligrosa queda revisada.',
        },
        {
          step: EN_USE_CASE_JOBS[6]!.jobSteps[4]!.step,
          title: 'Reutilizar el email en publicaciones sociales',
          body: 'El boletín terminado se convierte en una publicación de LinkedIn, un hilo X, una breve actualización del producto y un registro de cambios interno. Un ángulo claro se extiende a lo largo de los canales que tus clientes ya leen.',
        },
        {
          step: EN_USE_CASE_JOBS[6]!.jobSteps[5]!.step,
          title: 'Informar y mejorar el próximo número.',
          body: 'Después de enviar la campaña, Duet abre, hace clic, responde, cancela la suscripción y rebota, luego te dice qué conservar, qué eliminar y qué tema merece un seguimiento más profundo la próxima semana.',
        },
      ],
      faqs: [
        {
          q: '¿Duet enviará emails sin aprobación?',
          a: 'No, a menos que lo permitas explícitamente. Una configuración más segura mantiene el envío final detrás de la aprobación, al tiempo que permite que Duet recopile actualizaciones, redacte el email, cree HTML, verifique la audiencia y prepare la transmisión para tu revisión.',
        },
        {
          q: '¿Qué plataformas de email admite?',
          a: 'Duet puede conectarse a plataformas de email mediante integraciones, API, exportaciones o configuración personalizada según el proveedor. Para Resend, Customer.io, Mailchimp, ConvertKit, Loops, HubSpot o exportaciones Markdown, define los permisos de borrador, audiencia y envío antes de habilitar el envío.',
        },
        {
          q: '¿Cómo sabe Duet lo que pasó esta semana?',
          a: 'Lee los sistemas donde se realizó el trabajo: confirmaciones, relaciones públicas, problemas lineales, subprocesos de Slack, documentos de Notion, análisis y conversaciones de soporte. Obtendrá una actualización real, no una lluvia de ideas de una página en blanco.',
        },
        {
          q: '¿Puedes mantener nuestra plantilla de marca consistente?',
          a: 'Sí. Duet almacena la plantilla aprobada, los colores, el pie de página, los estilos móviles, la ubicación para cancelar la suscripción y el patrón de CTA. Cada nuevo problema comienza desde el mismo sistema en lugar de ser reconstruido por la memoria.',
        },
        {
          q: '¿Puede limpiar o segmentar la lista?',
          a: 'Sí. Duet puede identificar segmentos rebotados, suprimidos, inactivos, de alto compromiso, de usuarios de productos y solo de boletines, y luego recomendar quién debe recibir una transmisión antes de que alguien presione enviar.',
        },
        {
          q: '¿Ayuda si solo enviamos una vez al mes?',
          a: 'Sí, pero semanal o quincenal funciona mejor porque el material original es más reciente. Duet hace que el costo operativo sea lo suficientemente bajo como para que un equipo ágil pueda realizar envíos de manera más consistente sin convertir el boletín en un trabajo a tiempo parcial.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[6]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[6]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[6]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[7]!.slug,
      title: 'Facturación y cobros',
      h1: 'Ejecuta facturación y cobros con un compañero de AI',
      metaTitle: 'AI para facturación | Enviar, perseguir, conciliar | Duet',
      metaDescription:
        'Duet redacta facturas, prepara recordatorios, realiza un seguimiento de las reglas de aprobación, concilia pagos y señala cuentas vencidas.',
      intro:
        'Recibir el pago no debería depender de que el fundador recuerde preparar un empujón cortés. Duet redacta facturas del trabajo ya realizado, las prepara en tu herramienta de contabilidad, realiza un seguimiento de tus reglas de aprobación, concilia pagos y marca las cuentas que necesitan juicio. La recaudación de efectivo se convierte en un sistema, no en un estado de ánimo.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[7]!.jobSteps[0]!.step,
          title: 'Conecta facturación, contratos y notas de proyecto',
          body: 'Duet lee QuickBooks, Xero, Stripe, Harvest, Toggl, Notion, Linear, contratos y carpetas de proyectos para saber qué se vendió, qué se entregó y cómo se debe describir la factura.',
        },
        {
          step: EN_USE_CASE_JOBS[7]!.jobSteps[1]!.step,
          title: 'Redactar el paquete de factura',
          body: 'Para cada hito facturable o período recurrente, Duet redacta la factura, las líneas de pedido, las notas de respaldo, la referencia de la orden de compra y el email dirigido al cliente. Aprueba el paquete una vez en lugar de ensamblarlo a partir de cinco pestañas.',
        },
        {
          step: EN_USE_CASE_JOBS[7]!.jobSteps[2]!.step,
          title: 'Prepara facturas con el ritmo adecuado',
          body: 'Duet prepara facturas en tu herramienta de contabilidad con fecha de vencimiento/enlace de pago/detalles de impuestos, luego envía el paquete para tu aprobación antes de enviarlo, a menos que configure una regla de repetición limitada.',
        },
        {
          step: EN_USE_CASE_JOBS[7]!.jobSteps[3]!.step,
          title: 'Haz seguimiento sin parecer desesperado',
          body: 'Recordatorio, empujón de fecha de vencimiento, seguimiento atrasado, escalamiento: Duet escribe cada empujón cortésmente con tu voz y hace referencia al trabajo real entregado. El tono se mantiene firme, no incómodo.',
        },
        {
          step: EN_USE_CASE_JOBS[7]!.jobSteps[4]!.step,
          title: 'Conciliar pagos y cerrar el círculo',
          body: 'Cuando llega el dinero, Duet relaciona los pagos con las facturas, las marca como pagadas, actualiza el registro del cliente y elimina la cuenta del seguimiento. Los pagos parciales y las disputas se marcan con el contexto.',
        },
        {
          step: EN_USE_CASE_JOBS[7]!.jobSteps[5]!.step,
          title: 'Riesgo de efectivo superficial todos los lunes',
          body: 'Duet envía un resumen de efectivo simple: facturas enviadas, pagadas, vencidas, cubetas antiguas, clientes en riesgo y la próxima acción de cobro. Tú sabe dónde está atrapado el efectivo antes de la semana de nómina.',
        },
      ],
      faqs: [
        {
          q: '¿Puede Duet crear facturas dentro de QuickBooks o Xero?',
          a: 'Duet puede redactar facturas en QuickBooks, Xero, Stripe u otra herramienta de facturación cuando la ruta de integración lo admita y luego esperar la aprobación antes de enviarlas. Comienza con la aprobación requerida y habilita reglas de repetición limitadas más adelante, solo después de la revisión.',
        },
        {
          q: '¿Perseguirá a los clientes de manera demasiado agresiva?',
          a: 'No. Tú defines la cadencia y el tono. Duet puede ser suave para cuentas estratégicas, más firme para morosos crónicos y siempre encaminar a los clientes sensibles a un ser humano antes de enviar cualquier recordatorio.',
        },
        {
          q: '¿Puede facturar desde herramientas de seguimiento del tiempo o de gestión de proyectos?',
          a: 'Sí. Duet puede extraer horas facturables, hitos, tareas completadas y anticipos de herramientas como Harvest, Toggl, Linear, Asana, Notion y Google Sheets, y luego convertirlos en partidas individuales de factura.',
        },
        {
          q: '¿Duet procesa pagos?',
          a: 'Duet prepara y envía enlaces de pago a través de tu proveedor actual, como Stripe, QuickBooks Payments o Xero. El movimiento de dinero real permanece dentro del sistema de pago en el que ya confía.',
        },
        {
          q: '¿Cómo maneja las facturas en disputa?',
          a: 'Las disputas se escalan con la factura, los términos del contrato, los albaranes y los emails anteriores adjuntos. Duet redacta una respuesta, pero la decisión queda en tus manos.',
        },
        {
          q: '¿Es esto útil para agencias y empresas de servicios?',
          a: 'Sí. Las agencias, consultores, contratistas, clínicas y otras empresas de servicios encajan perfectamente porque la facturación depende de pruebas de entrega dispersas. Duet reúne esa prueba y mantiene la cadencia de seguimiento en marcha.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[7]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[7]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[7]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[8]!.slug,
      title: 'Incorporación de clientes',
      h1: 'Incorporación de nuevos clientes con un compañero de AI',
      metaTitle: 'AI para la incorporación de clientes | Inicio al traspaso | Duet',
      metaDescription:
        'Duet ejecuta la incorporación de clientes: emails de inicio, formularios de admisión, configuración del workspace, reserva de calendario, recopilación de activos y seguimiento de la primera semana.',
      intro:
        'La incorporación de clientes es donde los equipos lean parecen premium o parecen improvisados. Duet convierte un acuerdo firmado en un inicio limpio: email de bienvenida, formulario de admisión, workspace compartido, invitación de calendario, lista de verificación de activos y seguimiento de la primera semana. El cliente siente que tienes un equipo más grande que tú.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[8]!.jobSteps[0]!.step,
          title: 'Activador de un acuerdo o pago firmado',
          body: 'Duet mira Stripe, HubSpot, Attio, Pipedrive, DocuSign o una aprobación manual. Cuando se cierra un trato, se inicia el flujo de trabajo de incorporación con el cliente, el plan, el alcance y el propietario ya adjuntos.',
        },
        {
          step: EN_USE_CASE_JOBS[8]!.jobSteps[1]!.step,
          title: 'Enviar el email de inicio',
          body: 'Duet redacta la nota de bienvenida con tu voz, presenta el ritmo de trabajo, vincula el formulario de admisión y explica exactamente lo que sucede a continuación. No hay inicio de página en blanco cada vez que un cliente firma.',
        },
        {
          step: EN_USE_CASE_JOBS[8]!.jobSteps[2]!.step,
          title: 'Reúna los activos adecuados',
          body: 'Archivos de marca, inicios de sesión, acceso a análisis, notas de audiencia, plazos, restricciones legales, detalles de facturas: Duet solicita lo que este cliente necesita, no un formulario de admisión genérico e inflado.',
        },
        {
          step: EN_USE_CASE_JOBS[8]!.jobSteps[3]!.step,
          title: 'Crear el workspace y las primeras tareas.',
          body: 'Duet crea el workspace de Notion, Linear, Asana, ClickUp, Google Drive o Slack a partir de tu plantilla, completa los detalles del cliente, asigna propietarios y abre las tareas de la primera semana.',
        },
        {
          step: EN_USE_CASE_JOBS[8]!.jobSteps[4]!.step,
          title: 'Reserva el inicio y busque las entradas faltantes',
          body: 'Duet programa la llamada inicial, envía recordatorios y realiza un seguimiento de los activos faltantes sin que tú te conviertas en el director del proyecto incluso antes de que comience.',
        },
        {
          step: EN_USE_CASE_JOBS[8]!.jobSteps[5]!.step,
          title: 'Enviar el resumen de estado de la primera semana',
          body: 'Después de la primera semana, Duet resume lo que se recibió, lo que está bloqueado, lo que se envió y lo que el cliente debe hacer a continuación. La relación comienza con impulso en lugar de confusión.',
        },
      ],
      faqs: [
        {
          q: '¿Puede Duet personalizar la incorporación por paquete o tipo de cliente?',
          a: 'Sí. Diferentes paquetes pueden activar diferentes formularios, workspaces, agendas de inicio y solicitudes de activos. Una auditoría ligera y un contrato completo no deberían generar el mismo flujo de incorporación.',
        },
        {
          q: '¿Qué herramientas de proyecto puede configurar?',
          a: 'Duet puede configurar espacios de proyecto mediante integraciones administradas, API, carpetas compartidas, CSV o configuración personalizada según la herramienta. Para Notion, Google Drive, Slack, Linear, Asana, ClickUp, Trello, Airtable o portales de clientes, define los permisos exactos de creación y actualización durante la configuración.',
        },
        {
          q: '¿El cliente sabrá que un AI está coordinando la incorporación?',
          a: 'Solo si quieres que eso sea explícito. Muchos equipos utilizan Duet detrás de escena para redactar, crear y perseguir, mientras los mensajes aún provienen de la empresa con una voz coherente.',
        },
        {
          q: '¿Cómo evita Duet pedir cosas a los clientes dos veces?',
          a: 'Almacena lo que el cliente ya proporcionó, verifica el workspace antes de preparar recordatorios y solo pregunta por los elementos que faltan. El seguimiento es específico: el logo está adentro, aún falta el acceso a análisis.',
        },
        {
          q: '¿Puede manejar el cumplimiento o los pasos legales?',
          a: 'Sí, como lista de verificación y capa de enrutamiento. Duet puede recopilar documentos, enviar los formularios correctos y escalar revisiones legales, pero no emite juicios legales sin un propietario humano.',
        },
        {
          q: '¿Esto es sólo para agencias?',
          a: 'No. Las agencias se benefician de inmediato, pero los consultores, las empresas de servicios, los equipos de incorporación de software y los fundadores con muchas operaciones utilizan el mismo patrón: activar, recopilar, crear un workspace, realizar un seguimiento.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[8]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[8]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[8]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[9]!.slug,
      title: 'Informes internos',
      h1: 'Ejecuta informes internos con un compañero de AI',
      metaTitle: 'AI para informes internos | Resúmenes, Métricas | Duet',
      metaDescription:
        'Duet ejecuta informes internos: extrae métricas, explica los cambios, crea resúmenes diarios o semanales y envía las siguientes acciones a tu equipo.',
      intro:
        'Los informes deberían hacer que el próximo paso sea obvio. En cambio, los equipos lean pierden horas colocando los mismos números en las mismas diapositivas. Duet conecta las fuentes, elabora el resumen diario o semanal, explica qué cambió y envía un puñado de decisiones importantes. El informe se convierte en la reunión.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[9]!.jobSteps[0]!.step,
          title: 'Conecta las fuentes de métricas',
          body: 'Duet lee Stripe, PostHog, GA4, Search Console, HubSpot, Attio, Shopify, QuickBooks, hojas de cálculo y bases de datos. Tú define el puñado de métricas que impulsan el negocio en lugar de volcar cada gráfico en un panel.',
        },
        {
          step: EN_USE_CASE_JOBS[9]!.jobSteps[1]!.step,
          title: 'Definir el breve que leerá la gente.',
          body: 'Elige la cadencia y la audiencia: pulso diario del fundador, resumen de ingresos del lunes, informe del cliente del viernes, paquete mensual de la junta directiva. Duet da forma a la salida para el lector en lugar de reutilizar un panel gigante para todos.',
        },
        {
          step: EN_USE_CASE_JOBS[9]!.jobSteps[2]!.step,
          title: 'Extraiga números y compárelos con la línea de base',
          body: 'Duet busca las métricas más recientes, las compara con la semana pasada, el mes pasado, el pronóstico o el objetivo, y señala los cambios que son lo suficientemente grandes como para importar. El ruido queda fuera del programa.',
        },
        {
          step: EN_USE_CASE_JOBS[9]!.jobSteps[3]!.step,
          title: 'Explica qué cambió',
          body: 'Cuando los registros disminuyen, la rotación aumenta, el tráfico se mueve o el efectivo se reduce, Duet verifica los eventos circundantes: lanzamientos, campañas, volumen de soporte, interrupciones, estacionalidad. El informe dice por qué probablemente sucedió, no sólo que sucedió.',
        },
        {
          step: EN_USE_CASE_JOBS[9]!.jobSteps[4]!.step,
          title: 'Enviar el informe donde se realiza el trabajo.',
          body: 'Correo electrónico, Slack, Archivos de Duet, Notion, Presentaciones de Google o PDF: Duet publica el resumen terminado con los enlaces de respaldo adjuntos. Los humanos leen el resumen y hacen clic en él solo cuando necesitan detalles.',
        },
        {
          step: EN_USE_CASE_JOBS[9]!.jobSteps[5]!.step,
          title: 'Seguimiento de acciones de seguimiento',
          body: 'Si el informe recomienda una verificación de precios, una respuesta de soporte, una revisión de abandono o una corrección de SEO, Duet crea la tarea y realiza un seguimiento la próxima semana. Los informes se convierten en un bucle operativo, no en un artefacto estático.',
        },
      ],
      faqs: [
        {
          q: '¿En qué se diferencia esto de un tablero?',
          a: 'Un panel espera a que lo interpretes. Duet saca los números, explica el cambio, vincula la evidencia y recomienda la siguiente acción. Es una capa de analista que una pequeña empresa puede ejecutar sin agregar un analista de tiempo completo.',
        },
        {
          q: '¿Puede Duet crear informes orientados al cliente?',
          a: 'Sí. Duet puede crear informes de clientes pulidos con solo las métricas que cada cliente debería ver, además de comentarios en lenguaje natural y los próximos pasos. Las agencias utilizan esto para reemplazar la recopilación de informes repetitivos.',
        },
        {
          q: '¿Puede enviar informes programados?',
          a: 'Sí. Los informes pueden ejecutarse según un cronograma diario, semanal, mensual o personalizado. Puedes solicitar aprobación para informes externos y al mismo tiempo permitir que se envíen resúmenes internos según las reglas que establezcas.',
        },
        {
          q: '¿Qué formatos puede producir?',
          a: 'Se admiten email, publicaciones de Slack, Archivos de Duet, páginas de Notion, Markdown, Google Docs, Google Slides, CSV y PDF. El mismo resumen fuente puede adoptar múltiples formatos.',
        },
        {
          q: '¿Puede manejar datos desordenados de hojas de cálculo?',
          a: 'Sí. Duet puede normalizar hojas, detectar columnas faltantes, conciliar discrepancias de nombres y marcar filas que necesitan limpieza. No inventará silenciosamente datos limpios donde la fuente esté rota.',
        },
        {
          q: '¿Quién debería utilizar primero los informes internos AI?',
          a: 'Fundadores, operadores, agencias y equipos pequeños con repetidos dolores de cabeza en los informes semanales. Si alguien pasa cada semana haciendo el mismo informe, Duet debería ser el propietario de ese trabajo.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[9]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[9]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[9]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[10]!.slug,
      title: 'Manejo de documentos',
      h1: 'Manejar documentos comerciales con un compañero de AI',
      metaTitle: 'AI para Documentos | Extraer, revisar, archivar | Duet',
      metaDescription:
        'Duet maneja documentos comerciales: extrae términos, resume contratos, señala riesgos, cambia el nombre de archivos, dirige aprobaciones y mantiene registros organizados.',
      intro:
        'Cada pequeña empresa tiene un cementerio de documentos: contratos, facturas, archivos PDF, mazos, recibos, formularios, extractos. Duet los lee, extrae los campos útiles, señala las partes riesgosas, las archiva donde pertenecen y convierte la pila en un sistema. No se requiere plataforma de documentos empresariales.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[10]!.jobSteps[0]!.step,
          title: 'Conecta los lugares donde aterrizan los documentos',
          body: 'Duet supervisa las cargas de Gmail, Google Drive, Dropbox, Notion, Slack y carpetas compartidas. También puede procesar archivos PDF, escaneos, imágenes y documentos de Word únicos que agregues a Archivos.',
        },
        {
          step: EN_USE_CASE_JOBS[10]!.jobSteps[1]!.step,
          title: 'Extrae los campos que importan',
          body: 'Para facturas, contratos, recibos, estados de cuenta y formularios, Duet extrae nombres, fechas, montos, términos de renovación, términos de pago, obligaciones y propietarios en una tabla o registro CRM.',
        },
        {
          step: EN_USE_CASE_JOBS[10]!.jobSteps[2]!.step,
          title: 'Resumir y marcar el riesgo',
          body: 'Duet resume el documento en un lenguaje sencillo y señala cláusulas inusuales, firmas faltantes, renovaciones automáticas, cargos por pagos atrasados, totales no coincidentes o cualquier cosa que deba enviarse a un humano antes de tu aprobación.',
        },
        {
          step: EN_USE_CASE_JOBS[10]!.jobSteps[3]!.step,
          title: 'Cambiar el nombre y archivar con reglas de enrutamiento',
          body: 'Los archivos cambian de nombre con un patrón consistente y se enrutan a la carpeta o registro correcto. Dejas de buscar “final_final_contract_signed_v3.pdf” y comienzas a abrir el registro del cliente.',
        },
        {
          step: EN_USE_CASE_JOBS[10]!.jobSteps[4]!.step,
          title: 'Aprobaciones de ruta y recordatorios',
          body: 'Duet hace ping al propietario adecuado para tu aprobación, realiza un seguimiento antes de las fechas de renovación y crea tareas para documentos que necesitan firmas o faltan archivos adjuntos. El documento se convierte en un flujo de trabajo, no en un archivo muerto.',
        },
        {
          step: EN_USE_CASE_JOBS[10]!.jobSteps[5]!.step,
          title: 'Construye una memoria empresarial con capacidad de búsqueda',
          body: 'Los campos extraídos y los resúmenes viven en la memoria Duet, por lo que preguntas futuras como "¿qué proveedores renuevan en junio?" o "¿a qué aceptó este cliente?" Obtén respuesta sin abrir un laberinto de carpetas.',
        },
      ],
      faqs: [
        {
          q: '¿Puede Duet leer archivos PDF e imágenes escaneados?',
          a: 'Sí. Duet puede escanear archivos PDF e imágenes con OCR, luego extraer campos estructurados y resumir el documento. El OCR de baja confianza se marca en lugar de tratarse como verdad.',
        },
        {
          q: '¿Es esta revisión legal?',
          a: 'No. Duet puede resumir términos, señalar cláusulas inusuales y preparar preguntas para los abogados, pero no es un abogado. La aprobación legal queda en manos de un ser humano.',
        },
        {
          q: '¿Puede organizar Google Drive?',
          a: 'Sí. Duet puede cambiar el nombre de archivos, crear carpetas, mover documentos, adjuntarlos a CRM o registros de proyectos y mantener un registro de los cambios.',
        },
        {
          q: '¿Qué tipos de documentos funcionan mejor?',
          a: 'Contratos, facturas, recibos, extractos bancarios, formularios de proveedores, resúmenes de clientes, documentos de incorporación, paquetes de impuestos, archivos PDF, imágenes, documentos de Word y presentaciones funcionan bien cuando los campos a extraer están claros.',
        },
        {
          q: '¿Cómo evita Duet la filtración de documentos confidenciales?',
          a: 'Cada workspace se ejecuta en tu propio servidor en la nube aislado y los resultados de los documentos permanecen dentro de ese workspace a menos que los compartas o exportes explícitamente. También puedes mantener la aprobación requerida antes de que algo salga del sistema.',
        },
        {
          q: '¿Puede crear un archivo con capacidad de búsqueda a partir de documentos antiguos?',
          a: 'Sí. Duet puede procesar una carpeta de documentos antiguos, extraer metadatos, escribir resúmenes y crear un índice para que el archivo se convierta en una memoria empresarial con capacidad de búsqueda en lugar de un desorden de almacenamiento.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[10]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[10]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[10]!.lastUpdated,
    },
    {
      slug: EN_USE_CASE_JOBS[11]!.slug,
      title: 'Creación de apps',
      h1: 'Crea apps para pequeñas empresas con un compañero de AI',
      metaTitle: 'AI Creador de apps para pequeñas empresas | Construir + Ejecutar | Duet',
      metaDescription:
        'Duet crea y ejecuta apps para pequeñas empresas: paneles, portales, calculadoras, formularios, automatizaciones y herramientas internas alojadas desde tu workspace.',
      intro:
        'Las pequeñas empresas a menudo tienen apps pequeñas que necesitan y no tienen ningún motivo para contratar un equipo de ingeniería completo: una calculadora de cotizaciones, un portal de clientes, un rastreador de facturas, un formulario de admisión, un panel de KPI, una cola de aprobación. Duet crea la app y la ejecuta desde el mismo workspace, para que la herramienta no se convierta en otra cosa que tenga que operar.',
      jobSteps: [
        {
          step: EN_USE_CASE_JOBS[11]!.jobSteps[0]!.step,
          title: 'Describe el trabajo que debe hacer la app.',
          body: 'Dile a Duet el flujo de trabajo en un lenguaje sencillo: quién lo usa, a qué ingresa, qué sucede a continuación y qué sistemas debe tocar. La app parte del proceso de negocio, no de una elección de marco.',
        },
        {
          step: EN_USE_CASE_JOBS[11]!.jobSteps[1]!.step,
          title: 'Conecta las fuentes de datos',
          body: 'Duet puede conectar hojas de cálculo, CRM, herramientas de pago, calendarios, bases de datos, archivos o API a través de integraciones, credenciales o configuraciones específicas disponibles. Si la primera versión se puede ejecutar en una hoja de cálculo, Duet comienza allí en lugar de compilarla en exceso.',
        },
        {
          step: EN_USE_CASE_JOBS[11]!.jobSteps[2]!.step,
          title: 'Generar la primera versión funcional.',
          body: 'Duet crea la interfaz de usuario, la base de datos, los permisos y la lógica del flujo de trabajo y luego te proporciona una URL activa. Lo prueba con datos reales en lugar de leer una especificación durante dos semanas.',
        },
        {
          step: EN_USE_CASE_JOBS[11]!.jobSteps[3]!.step,
          title: 'Iterar con las personas que lo usarán.',
          body: 'Solicita cambios en la misma sesión: agrega un filtro, cambia el nombre de un campo, exporta CSV, haz que la vista móvil sea menos abarrotada, envía un email cuando cambie el estado. Duet envía las ediciones y recuerda por qué se realizaron.',
        },
        {
          step: EN_USE_CASE_JOBS[11]!.jobSteps[4]!.step,
          title: 'Alojar y monitorear la app',
          body: 'La app se ejecuta desde tu workspace Duet con registros, archivos, memoria, trabajos programados e integraciones cercanas. Construir y ejecutar permanecen juntos, que es la diferencia entre una demostración y una herramienta empresarial.',
        },
        {
          step: EN_USE_CASE_JOBS[11]!.jobSteps[5]!.step,
          title: 'Convierta el trabajo repetido en automatización',
          body: 'Una vez que la app esté estable, Duet agrega el cron, el webhook, el paso de aprobación o el informe que le permite ejecutarse según la programación y tus reglas. La app se convierte en un flujo de trabajo operado por compañeros de trabajo, no en otro panel para cuidar niños.',
        },
      ],
      faqs: [
        {
          q: '¿Es Duet un creador de apps sin código?',
          a: 'No exactamente. Los constructores sin código te brindan bloques para ensamblar. Duet te brinda un compañero de AI con un servidor, sistema de archivos, memoria, ejecución de código e integraciones. Tú describes el trabajo empresarial y este construye la herramienta.',
        },
        {
          q: '¿Qué tipo de apps son mejores para Duet?',
          a: 'Las herramientas internas, los portales de clientes, las calculadoras, los paneles, los formularios de admisión, las colas de aprobación, las apps de informes, los CRM livianos y las herramientas de flujo de trabajo son ideales. Duet no intenta reemplazar un equipo completo de ingeniería de productos para software de consumo complejo.',
        },
        {
          q: '¿Pueden los usuarios no técnicos realizar cambios?',
          a: 'Sí. Preguntas en lenguaje natural y Duet edita la app. Los usuarios técnicos pueden inspeccionar el código y los registros, pero los propietarios de pequeñas empresas no necesitan aprender una interfaz de creación para cambiar un campo o enviar un nuevo flujo.',
        },
        {
          q: '¿Dónde están alojadas las apps?',
          a: 'Las apps se alojan desde el workspace Duet en un subdominio o dominio personalizado Duet. El mismo workspace que creó la app puede ejecutar trabajos programados, administrar archivos y conectarse a las herramientas que la app necesita.',
        },
        {
          q: '¿Puede Duet mantener la app después del lanzamiento?',
          a: 'Sí. Ese es el punto. Duet puede monitorear registros, corregir copias, agregar campos, actualizar integraciones, generar informes y mantener la app alineada con el flujo de trabajo a medida que cambia tu negocio.',
        },
        {
          q: '¿En qué se diferencia esto de contratar a un desarrollador para una herramienta pequeña?',
          a: 'Un desarrollador puede crear la primera versión, pero luego cada cambio se convierte en un ticket. Duet construye la primera versión y sigue funcionando junto a ella, por lo que se realizan pequeñas mejoras cuando la empresa las solicita.',
        },
      ],
      relatedPersonas: EN_USE_CASE_JOBS[11]!.relatedPersonas,
      relatedLeaves: EN_USE_CASE_JOBS[11]!.relatedLeaves,
      lastUpdated: EN_USE_CASE_JOBS[11]!.lastUpdated,
    },
  ],
} satisfies Record<AppLocale, UseCaseJob[]>

export function getUseCasePersonas(locale: AppLocale = 'en'): UseCasePersona[] {
  return useCasePersonasCopy[locale]
}

export function getUseCaseJobs(locale: AppLocale = 'en'): UseCaseJob[] {
  return useCaseJobsCopy[locale]
}

export function getUseCasePersona(
  slug: string,
  locale: AppLocale = 'en',
): UseCasePersona | undefined {
  return useCasePersonasCopy[locale].find(persona => persona.slug === slug)
}

export function getRelatedPersonas(
  persona: UseCasePersona,
  locale: AppLocale = 'en',
): UseCasePersona[] {
  return persona.relatedSlugs
    .map(slug => getUseCasePersona(slug, locale))
    .filter((related): related is UseCasePersona => Boolean(related))
}

export function getUseCaseLeaf(
  personaSlug: string,
  leafSlug: string,
  locale: AppLocale = 'en',
): { persona: UseCasePersona; leaf: UseCasePersonaLeaf } | undefined {
  const persona = getUseCasePersona(personaSlug, locale)
  const leaf = persona?.leaves.find(candidate => candidate.slug === leafSlug)
  return persona && leaf ? { persona, leaf } : undefined
}

export function getAllPersonaLeafParams(
  locale: AppLocale = 'en',
): Array<{ persona: string; leaf: string }> {
  return useCasePersonasCopy[locale].flatMap(persona =>
    persona.leaves.map(leaf => ({ persona: persona.slug, leaf: leaf.slug })),
  )
}

export function getUseCaseJob(slug: string, locale: AppLocale = 'en'): UseCaseJob | undefined {
  return useCaseJobsCopy[locale].find(job => job.slug === slug)
}

export function getAllJobParams(locale: AppLocale = 'en'): Array<{ slug: string }> {
  return useCaseJobsCopy[locale].map(job => ({ slug: job.slug }))
}

export function getRelatedPersonasForJob(
  job: UseCaseJob,
  locale: AppLocale = 'en',
): UseCasePersona[] {
  return job.relatedPersonas
    .map(slug => getUseCasePersona(slug, locale))
    .filter((persona): persona is UseCasePersona => Boolean(persona))
}

export function getRelatedLeavesForJob(
  job: UseCaseJob,
  locale: AppLocale = 'en',
): Array<{ persona: UseCasePersona; leaf: UseCasePersonaLeaf }> {
  return job.relatedLeaves.flatMap(reference => {
    const [personaSlug, leafSlug] = reference.split('/')
    if (!personaSlug || !leafSlug) return []
    const resolved = getUseCaseLeaf(personaSlug, leafSlug, locale)
    return resolved ? [resolved] : []
  })
}
