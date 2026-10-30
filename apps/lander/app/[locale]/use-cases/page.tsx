import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BrainIcon,
  CheckCircleIcon,
  HammerIcon,
  LightningIcon,
} from '@phosphor-icons/react/dist/ssr'
import type { Metadata } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import Image from 'next/image'
import { type ReactNode } from 'react'

import { LandingChrome } from '@/components/landing/landing-chrome'
import { LandingFooter } from '@/components/landing/landing-footer'
import { LandingNav } from '@/components/landing/landing-nav'
import { serifStyle } from '@/components/landing/landing-styles'
import { UseCasesHubGrid } from '@/components/landing/use-cases/use-cases-hub-grid'
import { UseCasesJsonLd } from '@/components/landing/use-cases/use-cases-json-ld'
import { UseCasesSharedCta } from '@/components/landing/use-cases/use-cases-shared-cta'
import {
  getUseCasePersonas,
  type UseCasePersona,
  type UseCasePersonaFaq,
} from '@/components/landing/use-cases/use-cases-spec'
import { Link } from '@/i18n/navigation'
import { getAlternateLocale, localeMetadata, type AppLocale } from '@/lib/i18n/locales'
import { LANDER_ORIGIN } from '@/lib/i18n/metadata'
import { localizedCanonical } from '@/lib/i18n/metadata'
import { safeJsonLd } from '@/lib/json-ld'

const CANONICAL_PATH = '/use-cases'
// Visible freshness marker for the hub. Bumped whenever the hub or
// any persona page below it gets a meaningful content edit so the
// "Last updated" line near the hero stays honest. Mirrors the
// per-persona `lastUpdated` in use-cases-spec.ts.
const HUB_LAST_UPDATED = '2026-05-21'

// Definitional answer to "What is an AI coworker?" — rendered as a
// bold H2 + 2-3 sentence answer near the top of the hub so Google AI
// Overview / Perplexity have a citation-ready paragraph to lift
// (I/O 2026 adapt).
const HUB_DEFINITION_BY_LOCALE: Record<AppLocale, { heading: string; body: string }> = {
  en: {
    heading: 'What is an AI coworker?',
    body: 'An AI coworker is a persistent, cloud-based AI teammate that lives in its own workspace, remembers your business, and runs recurring work end-to-end \u2014 building tools, drafting communication, triaging inboxes, and shipping reports. Unlike a chatbot or a sidebar assistant, it operates with its own files, schedules, integrations, and memory, so the work compounds across sessions instead of restarting from scratch every morning.',
  },
  'es-419': {
    heading: '\u00bfQu\u00e9 es un compa\u00f1ero de trabajo con IA?',
    body: 'Un compa\u00f1ero de trabajo con IA es un compa\u00f1ero de IA persistente, en la nube, que vive en su propio workspace, recuerda tu negocio y ejecuta el trabajo recurrente de extremo a extremo: construye herramientas, redacta comunicaciones, clasifica bandejas de entrada y env\u00eda reportes. A diferencia de un chatbot o de un asistente en sidebar, opera con sus propios archivos, schedules, integraciones y memoria, para que el trabajo se acumule entre sesiones en lugar de empezar de cero cada ma\u00f1ana.',
  },
}
// Lander OG image is the canonical brand image used by the root
// layout's metadata. Re-using it here keeps the hub on-brand in
// Slack / Twitter / iMessage unfurls until a use-cases-specific OG
// image is designed.
const OG_IMAGE = `${LANDER_ORIGIN}/landing/duet-lander-image.jpg`

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'useCasesHub' })
  const url = localizedCanonical(CANONICAL_PATH, locale)
  const metaTitle = t('metaTitle')
  const metaDescription = t('metaDescription')
  const ogAlt = t('ogAlt')
  return {
    title: metaTitle,
    description: metaDescription,
    // Spanish variant discontinued — `/es/...` now 308s to EN
    // (isDiscontinuedEsMarketingPath), so no `es` hreflang alternate.
    alternates: {
      canonical: url,
    },
    openGraph: {
      title: metaTitle,
      description: metaDescription,
      url,
      siteName: 'Duet',
      type: 'website',
      locale: localeMetadata[locale].ogLocale,
      alternateLocale: [localeMetadata[getAlternateLocale(locale)].ogLocale],
      images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: ogAlt }],
    },
    twitter: {
      card: 'summary_large_image',
      title: metaTitle,
      description: metaDescription,
      images: [OG_IMAGE],
    },
  }
}

// Featured strip — exactly one representative use case per persona.
// Hand-picked so each row carries its own outcome word (build, draft,
// enrich, schedule, ship) and no two rows overlap. Adding a sixth
// persona means appending a row keyed on the spec.
const FEATURED_USE_CASE_IDS: Record<string, string> = {
  'small-businesses': 'website',
  agencies: 'concepts',
  founders: 'mvp',
  'sales-teams': 'enrichment',
  operations: 'scheduling',
}

type CapabilityCard = {
  icon: typeof HammerIcon
  title: string
  body: string
}

// The "Lean operator stack" — Build, Run, Remember. Each card
// represents one new capability an SMB gets the moment it hires its
// first AI coworker. Three on purpose: this is the spine of the SMB
// pillar narrative.
const CAPABILITIES_BY_LOCALE: Record<AppLocale, CapabilityCard[]> = {
  en: [
    {
      icon: HammerIcon,
      title: 'Build',
      body: 'Your coworker writes the apps you have been meaning to build for too long. Customer dashboards, quote generators, lead-routing scripts, pricing calculators — anything you would hire a developer for, except now it can ship from the same workspace.',
    },
    {
      icon: LightningIcon,
      title: 'Run',
      body: 'Your coworker does not just build — it operates. Crons fire, inboxes get triaged, reports get sent, customers get followed up with. The ops layer you have been duct-taping with Zapier and Make becomes one place owned by one teammate.',
    },
    {
      icon: BrainIcon,
      title: 'Remember',
      body: 'Every conversation, every file, every decision lives in the same workspace. Your coworker today knows what your coworker agreed to earlier. There is no "starting over" with AI anymore — the context compounds.',
    },
  ],
  'es-419': [
    {
      icon: HammerIcon,
      title: 'Crear',
      body: 'Tu compañero escribe las apps que llevas tiempo queriendo construir. Dashboards de clientes, generadores de cotizaciones, scripts de ruteo de leads, calculadoras de precios — cualquier cosa para la que contratarías a un dev, pero ahora se entrega desde el mismo espacio de trabajo.',
    },
    {
      icon: LightningIcon,
      title: 'Operar',
      body: 'Tu compañero no solo crea — opera. Los crons disparan, el inbox se organiza, los reportes se envían, los clientes reciben seguimiento. La capa de ops que armas con Zapier y Make se convierte en un solo lugar bajo un solo dueño.',
    },
    {
      icon: BrainIcon,
      title: 'Recordar',
      body: 'Cada conversación, cada archivo, cada decisión vive en el mismo espacio de trabajo. Tu compañero de hoy sabe lo que tu compañero acordó antes. Ya no hay que "empezar de cero" con AI — el contexto se acumula.',
    },
  ],
}

// Five concrete steps to hire your first AI employee. Mirrors the
// onboarding flow on the product side so the marketing promise and
// the in-product reality stay in lockstep.
type HireStep = { n: string; title: string; body: string }
const HIRE_STEPS_BY_LOCALE: Record<AppLocale, HireStep[]> = {
  en: [
    {
      n: '01',
      title: 'Tell Duet what your business does',
      body: 'Drop in your URL. Duet reads your website and builds a brief on who you are, what you sell, and who you sell to.',
    },
    {
      n: '02',
      title: 'Pick a job to start with',
      body: 'Inbox triage. Outbound. Bookkeeping. Customer support. Do not try to automate everything — start with the one task that eats your week.',
    },
    {
      n: '03',
      title: 'Run it manually with your coworker once',
      body: 'Walk through the workflow together. Show your coworker the inputs, the steps, the edge cases.',
    },
    {
      n: '04',
      title: 'Run it on a schedule',
      body: 'Set a cron. Set a Slack or email trigger. Set a rule. The workflow you walked through once now runs on a schedule under your rules.',
    },
    {
      n: '05',
      title: 'Add the next job',
      body: 'A small business with one AI coworker has ten jobs you can hand off. Each new job takes less than the last because your coworker already knows your business.',
    },
  ],
  'es-419': [
    {
      n: '01',
      title: 'Cuéntale a Duet qué hace tu negocio',
      body: 'Pega tu URL. Duet lee tu sitio y arma un brief sobre quién eres, qué vendes y a quién le vendes.',
    },
    {
      n: '02',
      title: 'Elige un trabajo para empezar',
      body: 'Triage del inbox. Outbound. Contabilidad. Soporte al cliente. No intentes automatizar todo — empieza por la tarea que se come tu semana.',
    },
    {
      n: '03',
      title: 'Hazlo manual con tu compañero una vez',
      body: 'Recorran el workflow juntos. Muéstrale a tu compañero las entradas, los pasos y los casos límite.',
    },
    {
      n: '04',
      title: 'Ponlo en horario',
      body: 'Define un cron. Define un trigger por Slack o email. Define una regla. El workflow que recorriste una vez ahora corre en horario bajo tus reglas.',
    },
    {
      n: '05',
      title: 'Agrega el siguiente trabajo',
      body: 'Un pequeño negocio con un compañero de AI tiene diez trabajos por delegar. Cada trabajo nuevo cuesta menos que el anterior porque tu compañero ya conoce tu negocio.',
    },
  ],
}

// 12 jobs that a small business can hand to its first AI coworker
// today. Each card links into the `/use-cases/by-job/*` tree so the
// hub doubles as an internal-link rail across the job axis.
type HandoffJob = { title: string; body: string; href: string }
const HANDOFF_JOBS_BY_LOCALE: Record<AppLocale, HandoffJob[]> = {
  en: [
    {
      title: 'Inbox triage',
      body: 'Read every email, summarize, draft replies, flag the urgent ones, label the rest for review.',
      href: '/use-cases/by-job/inbox-triage',
    },
    {
      title: 'Customer support',
      body: 'Respond to FAQs in your voice, escalate the real ones to you, log every ticket.',
      href: '/use-cases/by-job/customer-support',
    },
    {
      title: 'Lead research & outbound',
      body: 'Find prospects, enrich them, write personalized first touches, follow up on a schedule.',
      href: '/use-cases/by-job/sales-outbound',
    },
    {
      title: 'Bookkeeping',
      body: 'Categorize transactions, reconcile accounts, flag anomalies, generate monthly P&L.',
      href: '/use-cases/by-job/bookkeeping',
    },
    {
      title: 'Content marketing',
      body: 'Research, draft, schedule, repurpose across channels — all in your voice.',
      href: '/use-cases/by-job/content-marketing',
    },
    {
      title: 'SEO operations',
      body: 'Keyword research, on-page audits, internal linking, monthly reports.',
      href: '/use-cases/by-job/seo',
    },
    {
      title: 'Newsletter operations',
      body: "Pull the week's wins, draft the email, send it, track the results.",
      href: '/use-cases/by-job/newsletter',
    },
    {
      title: 'Invoicing & collections',
      body: 'Generate invoices, send them, follow up on late ones politely and persistently.',
      href: '/use-cases/by-job/invoicing',
    },
    {
      title: 'Onboarding new clients',
      body: 'Kickoff email, intake form, calendar booking, project setup — start-to-finish.',
      href: '/use-cases/by-job/client-onboarding',
    },
    {
      title: 'Internal reporting',
      body: 'Daily, weekly, or monthly business snapshots delivered to your inbox or Slack.',
      href: '/use-cases/by-job/reporting',
    },
    {
      title: 'Document handling',
      body: 'Read contracts, extract terms, flag risks, file them in the right place.',
      href: '/use-cases/by-job/documents',
    },
    {
      title: 'App building',
      body: 'Small internal tools that you would never get around to building yourself.',
      href: '/use-cases/by-job/app-building',
    },
  ],
  'es-419': [
    {
      title: 'Triage del inbox',
      body: 'Lee cada email, resume, redacta respuestas, marca los urgentes y etiqueta el resto para revisión.',
      href: '/use-cases/by-job/inbox-triage',
    },
    {
      title: 'Soporte al cliente',
      body: 'Responde FAQs en tu voz, te escala los casos reales y registra cada ticket.',
      href: '/use-cases/by-job/customer-support',
    },
    {
      title: 'Investigación y outbound',
      body: 'Encuentra prospectos, los enriquece, escribe primeros contactos personalizados y hace seguimiento en horario.',
      href: '/use-cases/by-job/sales-outbound',
    },
    {
      title: 'Contabilidad',
      body: 'Categoriza transacciones, concilia cuentas, marca anomalías y genera el P&L mensual.',
      href: '/use-cases/by-job/bookkeeping',
    },
    {
      title: 'Content marketing',
      body: 'Investiga, redacta, programa y repurposea por canal — todo en tu voz.',
      href: '/use-cases/by-job/content-marketing',
    },
    {
      title: 'Operaciones de SEO',
      body: 'Keyword research, auditorías on-page, linking interno, reportes mensuales.',
      href: '/use-cases/by-job/seo',
    },
    {
      title: 'Operaciones de newsletter',
      body: 'Junta los hitos de la semana, redacta el email, lo envía y mide los resultados.',
      href: '/use-cases/by-job/newsletter',
    },
    {
      title: 'Facturación y cobranza',
      body: 'Genera facturas, las envía, hace seguimiento a las atrasadas con persistencia y buena onda.',
      href: '/use-cases/by-job/invoicing',
    },
    {
      title: 'Onboarding de clientes nuevos',
      body: 'Email de bienvenida, formulario de intake, agendado de calendario, setup del proyecto — de principio a fin.',
      href: '/use-cases/by-job/client-onboarding',
    },
    {
      title: 'Reporting interno',
      body: 'Snapshots diarios, semanales o mensuales del negocio entregados a tu inbox o a Slack.',
      href: '/use-cases/by-job/reporting',
    },
    {
      title: 'Manejo de documentos',
      body: 'Lee contratos, extrae términos, marca riesgos y los archiva donde corresponde.',
      href: '/use-cases/by-job/documents',
    },
    {
      title: 'Crear apps',
      body: 'Herramientas internas pequeñas que nunca te darías el tiempo de construir tú mismo.',
      href: '/use-cases/by-job/app-building',
    },
  ],
}

// The four pillars Duet was built on, from the SMB perspective. Sits
// under "Built for small businesses, by small business" and supersedes
// the older corporate-leaning differentiator copy.
const SMB_PILLARS_BY_LOCALE: Record<AppLocale, { title: string; body: string }[]> = {
  en: [
    {
      title: 'Monthly plans, not seat tax',
      body: 'Your AI coworker is not another headcount. Plans include shared monthly credits, and the paid reserve covers overage.',
    },
    {
      title: 'Its own server, not a shared pool',
      body: 'Every workspace runs on an isolated cloud server. Your data is not training somebody else’s model.',
    },
    {
      title: 'Persistent by default',
      body: 'Memory, files, decisions, and running crons all survive logout. That is how a coworker works.',
    },
    {
      title: 'Build + run in one place',
      body: 'You do not ship the app and then ship yourself the ops problem. The same workspace that builds your tool is the one that runs it.',
    },
  ],
  'es-419': [
    {
      title: 'Plan mensual, sin impuesto por asiento',
      body: 'Tu compañero de AI no es una contratación más. El plan incluye créditos compartidos y la reserva pagada cubre el uso adicional.',
    },
    {
      title: 'Su propio servidor, no un pool compartido',
      body: 'Cada espacio de trabajo corre en un servidor cloud aislado. Tus datos no entrenan el modelo de nadie más.',
    },
    {
      title: 'Persistente por defecto',
      body: 'La memoria, los archivos, las decisiones y los crons activos sobreviven al logout. Así trabaja un compañero.',
    },
    {
      title: 'Crear + operar en un solo lugar',
      body: 'No entregas la app y te quedas con el problema de ops. El mismo espacio que construye tu herramienta es el que la opera.',
    },
  ],
}

// Hub FAQ — the ten questions from the SMB pillar draft. Each answer
// has both a plain text version (`a`) for the FAQPage JSON-LD and a
// rendered version (`answer`) with at least one inline link to a
// persona / `/vs/*` / `/pricing` / `/guides` so the page hits its
// internal-link target without stuffing the prose.
type HubFaq = UseCasePersonaFaq & { answer: ReactNode }

const HUB_FAQS_EN: HubFaq[] = [
  {
    q: 'What is an AI coworker?',
    a: "An AI teammate that has its own computer, its own memory, and its own task list — not a chatbot you talk to one question at a time. Duet's AI coworker lives on its own cloud server, remembers the work in your workspace, runs scheduled jobs, asks for approval when needed, and reports back.",
    answer: (
      <>
        An AI teammate that has its own computer, its own memory, and its own task list — not a
        chatbot you talk to one question at a time. Duet&rsquo;s AI coworker lives on its own cloud
        server, remembers the work in your workspace, runs scheduled jobs, asks for approval when
        needed, and reports back. See the{' '}
        <Link
          href="/use-cases/small-businesses"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          small business use cases
        </Link>{' '}
        for the jobs people hand off first.
      </>
    ),
  },
  {
    q: 'How is Duet different from ChatGPT or Claude?',
    a: 'ChatGPT and Claude are AI tools — you ask a question, you get an answer. Duet is an AI coworker — you assign a job, it runs scheduled work, asks for approval when needed, and reports back. Duet remembers across conversations and can build and host apps for you.',
    answer: (
      <>
        ChatGPT and Claude are AI tools — you ask a question, you get an answer. Duet is an AI
        coworker — you assign a job, it runs scheduled work, asks for approval when needed, and
        reports back. Duet remembers across conversations and can build and host apps for you. See
        the full lineup in our{' '}
        <Link
          href="/vs"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          honest comparisons
        </Link>
        .
      </>
    ),
  },
  {
    q: 'How is Duet different from Lovable or Replit?',
    a: 'Lovable and Replit build an app and leave. Duet builds an app and runs it. The same workspace that built your customer dashboard is the one that operates it, monitors it, and maintains it.',
    answer: (
      <>
        Lovable and Replit build an app and leave. Duet builds an app and runs it. The same
        workspace that built your customer dashboard is the one that operates it, monitors it, and
        maintains it. See the full comparison in{' '}
        <Link
          href="/vs/lovable"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          Duet vs. Lovable
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Can a non-technical small-business owner use Duet?',
    a: "Yes — that's who we built it for. You don't write code. You describe what you want, and your AI coworker figures out the how.",
    answer: (
      <>
        Yes — that&rsquo;s who we built it for. You don&rsquo;t write code. You describe what you
        want, and your AI coworker figures out the how. The{' '}
        <Link
          href="/use-cases/small-businesses"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          small business use cases
        </Link>{' '}
        page walks through real prompts non-technical owners send every day.
      </>
    ),
  },
  {
    q: 'What does it cost to "hire an AI coworker"?',
    a: 'Duet has monthly plans with included credits, and a paid reserve for overage. Compare the plan against the tools and labor it would actually replace for your workflow.',
    answer: (
      <>
        Duet has monthly plans with included credits, and a paid reserve for overage. Compare the
        plan against the tools and labor it would actually replace for your workflow; see{' '}
        <Link
          href="/pricing"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          pricing
        </Link>{' '}
        for current plans.
      </>
    ),
  },
  {
    q: 'How long does it take to get my first job automated?',
    a: 'Start by connecting one workflow and tightening it over time. The harder part is choosing which job to hand off first — we recommend inbox triage or outbound.',
    answer: (
      <>
        Start by connecting one workflow and tightening it over time. The harder part is choosing
        which job to hand off first — we recommend{' '}
        <Link
          href="/use-cases/by-job/inbox-triage"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          inbox triage
        </Link>{' '}
        or{' '}
        <Link
          href="/use-cases/by-job/sales-outbound"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          outbound
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Is my business data safe?',
    a: "Each Duet workspace runs on its own isolated server. Your data isn't pooled with other customers. Your conversations aren't used to train shared models.",
    answer: (
      <>
        Each Duet workspace runs on its own isolated server. Your data isn&rsquo;t pooled with other
        customers. Your conversations aren&rsquo;t used to train shared models. The deeper how it
        works lives in{' '}
        <Link
          href="/guides"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          the guides
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Can my whole team share one AI coworker?',
    a: 'Yes. Duet is team-native — your AI coworker is shared across the team like a real teammate. Multiple humans, one AI, one shared context.',
    answer: (
      <>
        Yes. Duet is team-native — your AI coworker is shared across the team like a real teammate.
        Multiple humans, one AI, one shared context. Active teams include{' '}
        <Link
          href="/use-cases/small-businesses"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          small businesses
        </Link>
        ,{' '}
        <Link
          href="/use-cases/agencies"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          agencies
        </Link>
        , and{' '}
        <Link
          href="/use-cases/founders"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          founders
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Does it integrate with my tools?',
    a: 'Duet connects to many apps through managed integrations and supports direct API calls for many services when credentials, permissions, and documentation are available; unusual or private APIs may need scoped setup.',
    answer: (
      <>
        Duet connects to many apps through managed integrations and supports direct API calls for
        many services when credentials, permissions, and documentation are available; unusual or
        private APIs may need scoped setup. The integration list is documented in{' '}
        <Link
          href="/guides"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          the guides
        </Link>
        .
      </>
    ),
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Monthly plans, no contracts. Your workspace and data are yours to export.',
    answer: (
      <>
        Yes. Monthly plans, no contracts. Your workspace and data are yours to export. See{' '}
        <Link
          href="/pricing"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          pricing
        </Link>{' '}
        for the full terms.
      </>
    ),
  },
]

// Spanish hub FAQ — translated answers with inline links into the
// localized persona/comparison/pricing tree. Plain-text `a` ships into
// the FAQPage JSON-LD; `answer` is the JSX rendered on screen.
const HUB_FAQS_ES_419: HubFaq[] = [
  {
    q: '¿Qué es un compañero de AI?',
    a: 'Un compañero de AI tiene su propia computadora, su propia memoria y su propia lista de tareas — no es un chatbot al que le haces una pregunta a la vez. El compañero de AI de Duet vive en su propio servidor cloud, recuerda el trabajo en tu espacio, ejecuta trabajos programados, pide aprobación cuando hace falta y reporta de vuelta.',
    answer: (
      <>
        Un compañero de AI tiene su propia computadora, su propia memoria y su propia lista de
        tareas — no es un chatbot al que le haces una pregunta a la vez. El compañero de AI de Duet
        vive en su propio servidor cloud, recuerda el trabajo en tu espacio, ejecuta trabajos
        programados, pide aprobación cuando hace falta y reporta de vuelta. Mira los{' '}
        <Link
          href="/use-cases/small-businesses"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          casos de uso para pequeños negocios
        </Link>{' '}
        para ver los trabajos que la gente delega primero.
      </>
    ),
  },
  {
    q: '¿En qué se diferencia Duet de ChatGPT o Claude?',
    a: 'ChatGPT y Claude son herramientas de AI — haces una pregunta, recibes una respuesta. Duet es un compañero de AI — le asignas un trabajo, ejecuta tareas programadas, pide aprobación cuando hace falta y reporta de vuelta. Duet recuerda entre conversaciones y puede crear y hospedar apps por ti.',
    answer: (
      <>
        ChatGPT y Claude son herramientas de AI — haces una pregunta, recibes una respuesta. Duet es
        un compañero de AI — le asignas un trabajo, ejecuta tareas programadas, pide aprobación
        cuando hace falta y reporta de vuelta. Duet recuerda entre conversaciones y puede crear y
        hospedar apps por ti. Mira la lista completa en nuestras{' '}
        <Link
          href="/vs"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          comparaciones honestas
        </Link>
        .
      </>
    ),
  },
  {
    q: '¿En qué se diferencia Duet de Lovable o Replit?',
    a: 'Lovable y Replit construyen una app y se van. Duet construye una app y la opera. El mismo espacio de trabajo que armó el dashboard de tu cliente es el que lo opera, lo monitorea y lo mantiene.',
    answer: (
      <>
        Lovable y Replit construyen una app y se van. Duet construye una app y la opera. El mismo
        espacio de trabajo que armó el dashboard de tu cliente es el que lo opera, lo monitorea y lo
        mantiene. Mira la comparación completa en{' '}
        <Link
          href="/vs/lovable"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          Duet vs. Lovable
        </Link>
        .
      </>
    ),
  },
  {
    q: '¿Puede un dueño de pequeño negocio sin perfil técnico usar Duet?',
    a: 'Sí — para eso lo construimos. No escribes código. Describes lo que quieres y tu compañero de AI se encarga del cómo.',
    answer: (
      <>
        Sí — para eso lo construimos. No escribes código. Describes lo que quieres y tu compañero de
        AI se encarga del cómo. La página de{' '}
        <Link
          href="/use-cases/small-businesses"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          casos de uso para pequeños negocios
        </Link>{' '}
        recorre prompts reales que dueños sin perfil técnico envían cada día.
      </>
    ),
  },
  {
    q: '¿Cuánto cuesta "contratar a un compañero de AI"?',
    a: 'Duet ofrece planes mensuales con créditos incluidos y una reserva pagada para uso adicional. Compáralo con las herramientas y el trabajo humano que reemplazaría en tu workflow.',
    answer: (
      <>
        Duet ofrece planes mensuales con créditos incluidos y una reserva pagada para uso adicional.
        Compáralo con las herramientas y el trabajo humano que reemplazaría en tu workflow; mira{' '}
        <Link
          href="/pricing"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          precios
        </Link>{' '}
        para los planes actuales.
      </>
    ),
  },
  {
    q: '¿Cuánto tarda en automatizarse mi primer trabajo?',
    a: 'Empieza conectando un workflow y ajústalo con el tiempo. La parte difícil es elegir qué trabajo delegar primero — recomendamos triage del inbox u outbound.',
    answer: (
      <>
        Empieza conectando un workflow y ajústalo con el tiempo. La parte difícil es elegir qué
        trabajo delegar primero — recomendamos{' '}
        <Link
          href="/use-cases/by-job/inbox-triage"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          triage del inbox
        </Link>{' '}
        u{' '}
        <Link
          href="/use-cases/by-job/sales-outbound"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          outbound
        </Link>
        .
      </>
    ),
  },
  {
    q: '¿Mis datos de negocio están seguros?',
    a: 'Cada espacio de trabajo de Duet corre en su propio servidor aislado. Tus datos no se mezclan con los de otros clientes. Tus conversaciones no se usan para entrenar modelos compartidos.',
    answer: (
      <>
        Cada espacio de trabajo de Duet corre en su propio servidor aislado. Tus datos no se mezclan
        con los de otros clientes. Tus conversaciones no se usan para entrenar modelos compartidos.
        El detalle más profundo está en{' '}
        <Link
          href="/guides"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          las guías
        </Link>
        .
      </>
    ),
  },
  {
    q: '¿Mi equipo puede compartir un mismo compañero de AI?',
    a: 'Sí. Duet es nativo de equipo — tu compañero de AI se comparte entre el equipo como un compañero real. Varios humanos, una AI, un solo contexto compartido.',
    answer: (
      <>
        Sí. Duet es nativo de equipo — tu compañero de AI se comparte entre el equipo como un
        compañero real. Varios humanos, una AI, un solo contexto compartido. Hay equipos activos en{' '}
        <Link
          href="/use-cases/small-businesses"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          pequeños negocios
        </Link>
        ,{' '}
        <Link
          href="/use-cases/agencies"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          agencias
        </Link>{' '}
        y{' '}
        <Link
          href="/use-cases/founders"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          founders
        </Link>
        .
      </>
    ),
  },
  {
    q: '¿Se integra con mis herramientas?',
    a: 'Duet se conecta a muchas apps mediante integraciones gestionadas y soporta llamadas directas a APIs cuando hay credenciales, permisos y documentación disponibles; las APIs poco comunes o privadas pueden requerir un setup específico.',
    answer: (
      <>
        Duet se conecta a muchas apps mediante integraciones gestionadas y soporta llamadas directas
        a APIs cuando hay credenciales, permisos y documentación disponibles; las APIs poco comunes
        o privadas pueden requerir un setup específico. La lista de integraciones está documentada
        en{' '}
        <Link
          href="/guides"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          las guías
        </Link>
        .
      </>
    ),
  },
  {
    q: '¿Puedo cancelar cuando quiera?',
    a: 'Sí. Planes mensuales, sin contratos. Tu espacio de trabajo y tus datos son tuyos para exportar.',
    answer: (
      <>
        Sí. Planes mensuales, sin contratos. Tu espacio de trabajo y tus datos son tuyos para
        exportar. Mira{' '}
        <Link
          href="/pricing"
          className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
        >
          precios
        </Link>{' '}
        para los términos completos.
      </>
    ),
  },
]

const HUB_FAQS_BY_LOCALE: Record<AppLocale, HubFaq[]> = {
  en: HUB_FAQS_EN,
  'es-419': HUB_FAQS_ES_419,
}

// ItemList JSON-LD for the five persona pages. Crawlers use this to
// understand that /use-cases is the canonical index for the persona
// tree, which helps the hub rank on the SMB pillar keyword while the
// individual pages compete on their narrower keywords.
type ShellT = Awaited<ReturnType<typeof getTranslations<'useCasesShell'>>>
type HubT = Awaited<ReturnType<typeof getTranslations<'useCasesHub'>>>

function HubItemListJsonLd({ personas, hubT }: { personas: UseCasePersona[]; hubT: HubT }) {
  const itemList = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${LANDER_ORIGIN}${CANONICAL_PATH}#personas`,
    name: hubT('smbAriaLabel'),
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    numberOfItems: personas.length,
    itemListElement: personas.map((p, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: p.name,
      url: `${LANDER_ORIGIN}${CANONICAL_PATH}/${p.slug}`,
    })),
  }
  return (
    <script
      type="application/ld+json"
      // safeJsonLd escapes `<` to `\u003c` per Next.js docs so any
      // future schema field containing `</script>` can never break
      // out of the surrounding tag.
      dangerouslySetInnerHTML={{ __html: safeJsonLd(itemList) }}
    />
  )
}

// Section: hero. Mirrors the persona-page hero's soft radial gradient
// so visitors who land on /use-cases first and then drill into a
// persona feel like they're in the same place. The SMB pillar copy
// lives here — "Run your small business with AI / Operate like a
// giant. Stay lean."
// Format an ISO date (YYYY-MM-DD) as a locale-aware, human-readable
// freshness label. UTC-pinned so the same string renders regardless
// of where the build runs.
function formatHubLastUpdated(iso: string, locale: AppLocale): string {
  const intlLocale = locale === 'es-419' ? 'es-419' : 'en-US'
  return new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`))
}

function HubHero({ locale, shellT, hubT }: { locale: AppLocale; shellT: ShellT; hubT: HubT }) {
  return (
    <section
      aria-labelledby="hub-hero-heading"
      className="relative overflow-hidden px-4 pb-20 pt-16 sm:px-6 sm:pt-20 lg:px-8 lg:pb-28 lg:pt-28"
    >
      {/* Soft brand-blue daylight wash — same recipe used on each
          persona page so the section feels visually contiguous. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-32 -z-10 h-[480px] bg-[radial-gradient(ellipse_at_top,var(--lv2-accent-soft),transparent_70%)]"
      />

      <div className="mx-auto flex max-w-4xl flex-col items-center text-center">
        <span className="lv2-eyebrow mb-5">{hubT('heroEyebrow')}</span>
        <h1
          id="hub-hero-heading"
          className="text-balance text-5xl font-semibold leading-[1.02] tracking-tight text-[var(--lv2-fg)] sm:text-6xl lg:text-7xl"
          style={serifStyle}
        >
          <span className="block font-sans tracking-tight">{hubT('heroH1Line1')}</span>
          {/* Serif italic on the second line — H1 splits the value
              prop across a sans lead and a serif highlight, matching
              every persona hero on this section. */}
          <span className="mt-2 block tracking-tight" style={serifStyle}>
            {hubT('heroH1Line2Pre')}{' '}
            <em className="italic text-[var(--lv2-accent)]" style={serifStyle}>
              {hubT('heroH1Line2Em')}
            </em>
          </span>
        </h1>
        <p
          className="mt-6 text-2xl italic leading-snug text-[var(--lv2-fg-soft)] sm:text-3xl"
          style={serifStyle}
        >
          {hubT('heroTagline')}
        </p>
        <p className="mt-7 max-w-2xl text-balance text-lg leading-relaxed text-[var(--lv2-fg-soft)] sm:text-xl">
          {hubT('heroBody')}
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <UseCasesSharedCta size="lg" halo>
            {shellT('hireAiCoworker')}
          </UseCasesSharedCta>
          <Link
            // Smooth anchor jump to the persona grid — no JS handler
            // needed thanks to the global `scroll-behavior: smooth`
            // applied by landing-styles.css.
            href="#by-role"
            className="group inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {shellT('browseByRole')}
            <ArrowRightIcon
              weight="bold"
              className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>

        {/* Visible freshness marker — same quiet style as the persona
            pages so AI overviews / Google can see the cluster is
            maintained (I/O 2026 adapt). */}
        <p className="mt-6 text-xs uppercase tracking-[0.18em] text-[var(--lv2-muted)]">
          <time dateTime={HUB_LAST_UPDATED}>
            {shellT('lastUpdatedLabel', {
              date: formatHubLastUpdated(HUB_LAST_UPDATED, locale),
            })}
          </time>
        </p>

        {/* Editorial hero illustration — matches the blog cover
            pattern (16:9 cover, rounded border, soft card shadow).
            Above the fold on /use-cases so `priority` preloads. */}
        <div className="relative mt-14 w-full max-w-3xl aspect-video overflow-hidden rounded-2xl border border-lv2-line shadow-lv2-card">
          <Image
            src="/use-cases/hub.webp"
            alt={hubT('ogAlt')}
            fill
            sizes="(min-width: 1024px) 768px, (min-width: 640px) 90vw, 100vw"
            className="object-cover"
            // 200KB monochrome ASCII PNG — already smaller than any
            // optimization variant Next would emit. Bypasses Vercel's
            // Image Optimization (which was failing builds on this
            // branch).
            unoptimized
            priority
          />
        </div>
      </div>
    </section>
  )
}

// Section: definitional answer. Sits directly after the hero so
// crawlers (and AI overview lifters) hit a citation-ready paragraph
// answering "What is an AI coworker?" before the longer marketing
// scroll begins (I/O 2026 adapt). Copy lives in
// `HUB_DEFINITION_BY_LOCALE` so EN and ES stay in lockstep.
function HubDefinition({ locale }: { locale: AppLocale }) {
  const def = HUB_DEFINITION_BY_LOCALE[locale]
  return (
    <section aria-labelledby="hub-definition-heading" className="px-4 pb-4 pt-2 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h2
          id="hub-definition-heading"
          className="text-balance text-2xl font-bold leading-snug tracking-tight text-[var(--lv2-fg)] sm:text-3xl"
        >
          {def.heading}
        </h2>
        <p className="mt-4 max-w-[68ch] text-base leading-relaxed text-[var(--lv2-fg-soft)] sm:text-lg">
          {def.body}
        </p>
      </div>
    </section>
  )
}

// Section: AI tools vs assistants vs coworkers. SMBs often can't tell
// these apart — naming the three categories on the hub disarms the
// "isn't this just ChatGPT?" objection before it lands.
const HUB_CATEGORIES_BY_LOCALE: Record<
  AppLocale,
  { label: string; title: string; body: string }[]
> = {
  en: [
    {
      label: '01',
      title: 'AI tools',
      body: 'ChatGPT, Claude, Midjourney. You type, it answers. The work goes back into your head and your tabs. It usually doesn’t own the workflow or run your business process end-to-end.',
    },
    {
      label: '02',
      title: 'AI assistants',
      body: 'Sidebar agents inside SaaS apps. Useful inside that one app. Helpless outside it. You still own the workflow, the context, and the glue.',
    },
    {
      label: '03',
      title: 'AI coworkers',
      body: 'A teammate, not a tool. Has its own computer, its own memory, and its own task list. You assign work, it runs scheduled pieces under your rules, asks for approval when needed, and reports back. This is Duet.',
    },
  ],
  'es-419': [
    {
      label: '01',
      title: 'Herramientas de AI',
      body: 'ChatGPT, Claude, Midjourney. Escribes, te responde. El trabajo vuelve a tu cabeza y a tus pestañas. Normalmente no opera el workflow ni mantiene el proceso de tu negocio de principio a fin.',
    },
    {
      label: '02',
      title: 'Asistentes de AI',
      body: 'Agentes en sidebar dentro de apps SaaS. Útiles dentro de esa app. Inútiles fuera. Tú sigues siendo el dueño del workflow, del contexto y del pegamento.',
    },
    {
      label: '03',
      title: 'Compañeros de AI',
      body: 'Un compañero, no una herramienta. Tiene su propia computadora, su propia memoria y su propia lista de tareas. Le asignas trabajo, ejecuta tareas programadas bajo tus reglas, pide aprobación cuando hace falta y reporta de vuelta. Esto es Duet.',
    },
  ],
}

function HubCategories({ locale, hubT }: { locale: AppLocale; hubT: HubT }) {
  const categories = HUB_CATEGORIES_BY_LOCALE[locale]
  return (
    <section
      aria-labelledby="hub-categories-heading"
      className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('categoriesEyebrow')}</span>
          <h2
            id="hub-categories-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('categoriesHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{hubT('categoriesHeadingEm')}</em>{' '}
            {hubT('categoriesHeadingTail')}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {hubT('categoriesBody')}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {categories.map(c => (
            <article
              key={c.title}
              className="flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
            >
              <span className="lv2-eyebrow text-[var(--lv2-muted)]">{c.label}</span>
              <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                {c.title}
              </h3>
              <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{c.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

// Section: the lean operator stack. Build / Run / Remember. This is
// the spine of the SMB narrative — the three capabilities a small
// business unlocks the moment it hires its first AI coworker.
function HubLeanStack({ locale, hubT }: { locale: AppLocale; hubT: HubT }) {
  const capabilities = CAPABILITIES_BY_LOCALE[locale]
  return (
    <section
      aria-labelledby="hub-stack-heading"
      className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('leanStackEyebrow')}</span>
          <h2
            id="hub-stack-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('leanStackHeadingLead')}{' '}
            <em className="text-[var(--lv2-muted)]">{hubT('leanStackHeadingEm')}</em>
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {capabilities.map(card => {
            const Icon = card.icon
            return (
              <article
                key={card.title}
                className="flex flex-col gap-3 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
              >
                <span
                  // Icon tile mirrors the trust-strip chip style on
                  // /pricing so the visual vocabulary stays consistent.
                  className="grid size-10 place-items-center rounded-xl bg-[var(--lv2-accent-soft)] text-[var(--lv2-accent-strong)]"
                  aria-hidden="true"
                >
                  <Icon weight="duotone" className="size-5" />
                </span>
                <h3 className="text-lg font-semibold leading-tight text-[var(--lv2-fg)]">
                  {card.title}
                </h3>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{card.body}</p>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}

// Section: hire your first AI employee in 5 steps. Mirrors the
// in-product onboarding so the marketing promise and the live
// experience tell the same story.
function HubHireSteps({ locale, hubT }: { locale: AppLocale; hubT: HubT }) {
  const steps = HIRE_STEPS_BY_LOCALE[locale]
  return (
    <section aria-labelledby="hub-hire-heading" className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('hireStepsEyebrow')}</span>
          <h2
            id="hub-hire-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('hireStepsHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{hubT('hireStepsHeadingEm')}</em>{' '}
            {hubT('hireStepsHeadingTail')}
          </h2>
        </div>

        <ol className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {steps.map(step => (
            <li
              key={step.n}
              className="flex gap-4 rounded-2xl border border-lv2-line bg-lv2-surface p-5 shadow-lv2-card"
            >
              <span
                aria-hidden="true"
                className="font-mono text-xs font-semibold text-[var(--lv2-accent)]"
              >
                {step.n}
              </span>
              <div className="flex flex-col gap-1.5">
                <h3 className="text-base font-semibold leading-tight text-[var(--lv2-fg)]">
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10 flex justify-start">
          <UseCasesSharedCta size="lg">{hubT('hireStepsCta')}</UseCasesSharedCta>
        </div>
      </div>
    </section>
  )
}

// Section: by role. The 5-up persona grid lives in the shared
// component so the hub and the future search/menu surfaces all stay
// in lockstep. The id is the anchor target for the hero scroll link.
function HubByRole({ personas, hubT }: { personas: UseCasePersona[]; hubT: HubT }) {
  return (
    <section
      id="by-role"
      aria-labelledby="hub-by-role-heading"
      // Scroll margin offsets the sticky nav so the heading isn't
      // hidden behind the chrome when users smooth-scroll into the
      // section from the hero anchor.
      className="scroll-mt-24 bg-lv2-band-cool px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('byRoleEyebrow')}</span>
          <h2
            id="hub-by-role-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('byRoleHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{hubT('byRoleHeadingEm')}</em>
          </h2>
          <p className="mt-5 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {hubT('byRoleBody')}
          </p>
        </div>

        <UseCasesHubGrid personas={personas} />
      </div>
    </section>
  )
}

// Section: jobs your AI coworker can handle today. 12 entries pulled
// straight from the SMB draft. Each row is also the internal-link
// rail into the published `/use-cases/by-job/*` tree.
function HubByJob({ locale, hubT }: { locale: AppLocale; hubT: HubT }) {
  const handoffJobs = HANDOFF_JOBS_BY_LOCALE[locale]
  return (
    <section aria-labelledby="hub-by-job-heading" className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('byJobEyebrow')}</span>
          <h2
            id="hub-by-job-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('byJobHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{hubT('byJobHeadingEm')}</em>{' '}
            {hubT('byJobHeadingTail')}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {hubT('byJobBodyLead')}{' '}
            <Link
              href="/use-cases/by-job"
              className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
            >
              /use-cases/by-job
            </Link>
            {hubT('byJobBodyTrail')}
          </p>
        </div>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {handoffJobs.map(job => (
            <li key={job.title}>
              <Link
                href={job.href}
                className="group flex h-full flex-col gap-1.5 rounded-xl border border-lv2-line bg-lv2-surface p-4 transition-colors hover:border-lv2-line-strong"
              >
                <span className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold leading-tight text-[var(--lv2-fg)]">
                    {job.title}
                  </h3>
                  <ArrowUpRightIcon
                    weight="bold"
                    className="size-4 text-[var(--lv2-muted)] transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    aria-hidden="true"
                  />
                </span>
                <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{job.body}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// Section: featured. Keeps the spec-driven "one job per persona" tour
// so each persona page still gets an internal-link entry from the
// hub. Lives below the by-job rail because the SMB narrative leads
// with jobs, not personas.
function HubFeatured({ personas, hubT }: { personas: UseCasePersona[]; hubT: HubT }) {
  // Resolve the featured row in spec order so the strip matches the
  // persona grid above. `useCases` is non-empty per the spec contract
  // (each persona ships exactly 4), so the fallback to index 0 is safe
  // — but we narrow with a non-null assertion to keep the strip type
  // clean for the JSX consumer below.
  const rows = personas.map((persona: UseCasePersona) => {
    const featuredId = FEATURED_USE_CASE_IDS[persona.slug]
    const useCase = persona.useCases.find(uc => uc.id === featuredId) ?? persona.useCases[0]!
    return { persona, useCase }
  })

  return (
    <section
      aria-labelledby="hub-featured-heading"
      className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('featuredEyebrow')}</span>
          <h2
            id="hub-featured-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('featuredHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{hubT('featuredHeadingEm')}</em>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {hubT('featuredBody')}
          </p>
        </div>

        <ul className="divide-y divide-[var(--lv2-line)] rounded-2xl border border-lv2-line bg-lv2-surface shadow-lv2-card">
          {rows.map(({ persona, useCase }) => (
            <li key={persona.slug}>
              <Link
                href={`/use-cases/${persona.slug}`}
                // Whole row is one anchor so the click target is huge
                // on mobile. Grid keeps the three columns aligned even
                // when the outcome chip wraps.
                className="group grid grid-cols-1 items-center gap-3 px-5 py-5 transition-colors hover:bg-[var(--lv2-band-warm)] sm:grid-cols-[160px_1fr_auto] sm:gap-6 sm:px-6"
              >
                <span className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full bg-[var(--lv2-accent)] shadow-[0_0_0_3px_var(--lv2-accent-soft)]"
                  />
                  <span className="lv2-eyebrow">{persona.shortName}</span>
                </span>
                <span className="flex flex-col gap-1">
                  <span className="text-base font-semibold leading-snug text-[var(--lv2-fg)] sm:text-lg">
                    {useCase.title}
                  </span>
                  <span className="text-sm text-[var(--lv2-muted)]">{useCase.outcome}</span>
                </span>
                <span
                  className="hidden items-center gap-1.5 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors group-hover:text-[var(--lv2-accent-strong)] sm:inline-flex"
                  aria-hidden="true"
                >
                  {hubT('featuredSeeAll')}
                  <ArrowUpRightIcon
                    weight="bold"
                    className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// Section: how to choose. The honest comparison table — Duet vs.
// ChatGPT, Lovable, and the sidebar-agent category. Internal-links
// the `/vs/*` tree so the SMB pillar feeds the comparison hub and
// vice versa.
type ChooseRow = {
  need: string
  fit: string
  href: string | null
  duet?: true
}

const HUB_CHOOSE_ROWS_BY_LOCALE: Record<AppLocale, ChooseRow[]> = {
  en: [
    {
      need: 'Trying to draft one email faster',
      fit: 'ChatGPT or Claude',
      href: null,
    },
    {
      need: 'Building one app to launch and forget',
      fit: 'Lovable or Replit',
      href: '/vs/lovable',
    },
    {
      need: 'Looking for a sidebar inside one SaaS',
      fit: 'Sidebar agents (Claude for Small Business, etc.)',
      href: '/vs/anthropic-small-business',
    },
    {
      need: 'Running a coding agent inside the terminal',
      fit: 'Claude Code',
      href: '/vs/claude-code',
    },
    {
      need: 'Trying to run an entire small business with leverage',
      fit: 'Duet',
      href: null,
      duet: true,
    },
  ],
  'es-419': [
    {
      need: 'Quieres redactar un email más rápido',
      fit: 'ChatGPT o Claude',
      href: null,
    },
    {
      need: 'Quieres construir una app para lanzar y olvidarte',
      fit: 'Lovable o Replit',
      href: '/vs/lovable',
    },
    {
      need: 'Buscas un sidebar dentro de un SaaS',
      fit: 'Agentes en sidebar (Claude for Small Business, etc.)',
      href: '/vs/anthropic-small-business',
    },
    {
      need: 'Buscas un agente de código dentro de la terminal',
      fit: 'Claude Code',
      href: '/vs/claude-code',
    },
    {
      need: 'Quieres operar un pequeño negocio entero con apalancamiento',
      fit: 'Duet',
      href: null,
      duet: true,
    },
  ],
}

function HubHowToChoose({ locale, hubT }: { locale: AppLocale; hubT: HubT }) {
  const rows = HUB_CHOOSE_ROWS_BY_LOCALE[locale]
  return (
    <section aria-labelledby="hub-choose-heading" className="px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('chooseEyebrow')}</span>
          <h2
            id="hub-choose-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('chooseHeadingLead')}{' '}
            <em className="text-[var(--lv2-muted)]">{hubT('chooseHeadingEm')}</em>
          </h2>
          <p className="mt-4 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {hubT('chooseBody')}
          </p>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-lv2-line bg-lv2-surface shadow-lv2-card">
          <table className="w-full min-w-[560px] text-left">
            <thead className="bg-[var(--lv2-band-cool)]">
              <tr>
                <th
                  scope="col"
                  className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--lv2-muted)] sm:px-6"
                >
                  {hubT('chooseColIfYoure')}
                </th>
                <th
                  scope="col"
                  className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--lv2-muted)] sm:px-6"
                >
                  {hubT('chooseColBestFit')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--lv2-line)]">
              {rows.map(row => (
                <tr key={row.need}>
                  <td className="px-5 py-4 text-sm text-[var(--lv2-fg-soft)] sm:px-6 sm:text-base">
                    {row.need}
                  </td>
                  <td className="px-5 py-4 text-sm sm:px-6 sm:text-base">
                    {row.href ? (
                      <Link
                        href={row.href}
                        className="font-medium text-[var(--lv2-fg)] underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
                      >
                        {row.fit}
                      </Link>
                    ) : row.duet ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--lv2-accent-strong)]">
                        <CheckCircleIcon weight="fill" className="size-4" aria-hidden="true" />
                        {row.fit}
                      </span>
                    ) : (
                      <span className="text-[var(--lv2-fg)]">{row.fit}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-[var(--lv2-fg-soft)]">
          <span className="lv2-eyebrow">{hubT('chooseCompareDuetTo')}</span>
          <Link
            href="/vs/lovable"
            className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
          >
            Lovable
          </Link>
          <Link
            href="/vs/claude-code"
            className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
          >
            Claude Code
          </Link>
          <Link
            href="/vs/codex"
            className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
          >
            Codex
          </Link>
          <Link
            href="/vs"
            className="underline decoration-[var(--lv2-line-strong)] underline-offset-4 hover:decoration-[var(--lv2-accent)]"
          >
            {hubT('chooseComparisonHub')}
          </Link>
        </div>
      </div>
    </section>
  )
}

// Section: built for small businesses, by small business. Supersedes
// the older corporate-leaning "what makes Duet different" copy with
// the four SMB-shaped pillars from the draft.
function HubBuiltForSmb({ locale, hubT }: { locale: AppLocale; hubT: HubT }) {
  const pillars = SMB_PILLARS_BY_LOCALE[locale]
  return (
    <section
      aria-labelledby="hub-built-heading"
      className="bg-lv2-band-cool relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-5xl">
        <div className="mb-12 max-w-2xl">
          <span className="lv2-eyebrow">{hubT('builtEyebrow')}</span>
          <h2
            id="hub-built-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('builtHeadingLead')}{' '}
            <em className="text-[var(--lv2-accent)]">{hubT('builtHeadingEm')}</em>
          </h2>
          <p className="mt-5 text-base leading-relaxed text-[var(--lv2-fg-soft)]">
            {hubT('builtBody')}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {pillars.map(p => (
            <article
              key={p.title}
              className="flex flex-col gap-2 rounded-2xl border border-lv2-line bg-lv2-surface p-6 shadow-lv2-card"
            >
              <h3 className="text-base font-semibold leading-tight text-[var(--lv2-fg)]">
                {p.title}
              </h3>
              <p className="text-sm leading-relaxed text-[var(--lv2-fg-soft)]">{p.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

// Section: FAQ. Native <details> for keyboard-accessible disclosure
// without JS; the matching FAQPage JSON-LD ships server-side via
// `UseCasesJsonLd` so the on-screen list and the schema stay in
// lockstep. Ten questions from the SMB pillar draft — covers the
// "what is this / how is it different / how much / how soon / is it
// safe" cluster Google rewards on category hubs.
function HubFaq({ locale, shellT, hubT }: { locale: AppLocale; shellT: ShellT; hubT: HubT }) {
  const faqs = HUB_FAQS_BY_LOCALE[locale]
  return (
    <section
      aria-labelledby="hub-faq-heading"
      className="bg-lv2-band-warm relative px-4 py-20 sm:px-6 sm:py-24 lg:px-8"
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-10">
          <span className="lv2-eyebrow">{shellT('faq')}</span>
          <h2
            id="hub-faq-heading"
            className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-4xl"
            style={serifStyle}
          >
            {hubT('hubFaqHeadingLead')}{' '}
            <em className="text-[var(--lv2-muted)]">{hubT('hubFaqHeadingEm')}</em>
          </h2>
        </div>

        <div className="divide-y divide-[var(--lv2-line)]">
          {faqs.map(faq => (
            <details key={faq.q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <h3 className="text-base font-semibold leading-snug text-[var(--lv2-fg)] sm:text-lg">
                  {faq.q}
                </h3>
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-full border border-lv2-line text-[var(--lv2-fg-soft)] transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              {/* `answer` is JSX with inline <Link>s for the page;
                  `a` (plain text) is what we ship in the JSON-LD so
                  schema validators don't see anchor markup. */}
              <p className="mt-3 max-w-[60ch] text-sm leading-relaxed text-[var(--lv2-fg-soft)] sm:text-base">
                {faq.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

// Section: final CTA. Same shape as the persona pages so the close
// reads as a single section pattern, not a different layout per page.
function HubFinalCta({ shellT, hubT }: { shellT: ShellT; hubT: HubT }) {
  return (
    <section
      aria-labelledby="hub-final-cta-heading"
      className="relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32 lg:px-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-[radial-gradient(ellipse_at_center,var(--lv2-accent-soft),transparent_60%)]"
      />
      <div className="mx-auto max-w-3xl">
        <h2
          id="hub-final-cta-heading"
          className="text-4xl font-semibold leading-tight tracking-tight text-[var(--lv2-fg)] sm:text-5xl"
          style={serifStyle}
        >
          {hubT('hubFinalHeadingLead')}{' '}
          <em className="text-[var(--lv2-accent)]">{hubT('hubFinalHeadingEm')}</em>
        </h2>
        <p className="mt-5 text-lg text-[var(--lv2-fg-soft)]">{hubT('hubFinalBody')}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <UseCasesSharedCta size="lg" halo magnetic>
            {shellT('startFree')}
          </UseCasesSharedCta>
          <Link
            href="/pricing"
            className="rounded-full px-4 py-2 text-sm font-medium text-[var(--lv2-fg-soft)] transition-colors hover:text-[var(--lv2-fg)]"
          >
            {shellT('seePricing')}
          </Link>
        </div>
      </div>
    </section>
  )
}

/**
 * /use-cases — the SMB pillar hub.
 *
 * SEO target: "run small business with AI" / "AI for small business"
 * / "AI coworker for small business". Every persona below ranks for
 * its narrower keyword; every `/use-cases/by-job/*` page below ranks
 * for its job keyword; this page is the canonical pillar that ties
 * the cluster together.
 *
 * Three JSON-LD blocks ship server-side: BreadcrumbList + FAQPage
 * (via `UseCasesJsonLd`, shared with the persona pages) and ItemList
 * (inline below) so Google sees the persona index on first byte.
 */
export default async function UseCasesHubPage({
  params,
}: {
  params: Promise<{ locale: AppLocale }>
}) {
  const { locale } = await params
  setRequestLocale(locale)
  const personas = getUseCasePersonas(locale)
  const shellT = await getTranslations({ locale, namespace: 'useCasesShell' })
  const hubT = await getTranslations({ locale, namespace: 'useCasesHub' })

  return (
    <LandingChrome noAmbient>
      {/* FAQPage + BreadcrumbList JSON-LD — shared helper keeps the
          hub and the persona pages emitting the same schema shape.
          Passing `faqs` triggers the FAQPage block (10 Q&As on the
          hub). The helper always emits BreadcrumbList for "Home ›
          Use cases". */}
      <UseCasesJsonLd slug="index" name={shellT('useCases')} faqs={HUB_FAQS_BY_LOCALE[locale]} />
      {/* ItemList JSON-LD — explicit index of the five persona pages
          so crawlers attribute the cluster to this hub. */}
      <HubItemListJsonLd personas={personas} hubT={hubT} />

      <LandingNav sticky />
      <HubHero locale={locale} shellT={shellT} hubT={hubT} />
      <HubDefinition locale={locale} />
      <HubCategories locale={locale} hubT={hubT} />
      <HubLeanStack locale={locale} hubT={hubT} />
      <HubHireSteps locale={locale} hubT={hubT} />
      <HubByRole personas={personas} hubT={hubT} />
      <HubByJob locale={locale} hubT={hubT} />
      <HubFeatured personas={personas} hubT={hubT} />
      <HubHowToChoose locale={locale} hubT={hubT} />
      <HubBuiltForSmb locale={locale} hubT={hubT} />
      <HubFaq locale={locale} shellT={shellT} hubT={hubT} />
      <HubFinalCta shellT={shellT} hubT={hubT} />
      <LandingFooter />
    </LandingChrome>
  )
}
