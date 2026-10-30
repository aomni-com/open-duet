import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { TRIAL_DAYS } from '../lib/public-site-config'

const LANDER_ROOT = path.resolve(import.meta.dir, '..')
const PRODUCT_COPY_OWNERS = [
  'lib/i18n/page-copy.ts',
  'components/landing/vs/vs-spec.ts',
  'components/landing/use-cases/use-cases-spec.ts',
  'components/landing/organization-json-ld.tsx',
  'app/[locale]/terms/page.tsx',
  'app/[locale]/privacy-policy/page.tsx',
] as const
type CopyRule = { pattern: RegExp; reason: string }
type ProductCopyDecision =
  | { kind: 'allowed'; reason: string }
  | { kind: 'removed'; reason: string }
  | { kind: 'review'; reason: string }
  | { kind: 'unrelated' }

const retiredBillingClaims: ReadonlyArray<CopyRule> = [
  {
    pattern:
      /(?:\$\s*\d+(?:\.\d+)?[^\n]{0,40}(?:trial|free credits?|trial credits?)|(?:trial|free credits?|trial credits?)[^\n]{0,40}\$\s*\d+(?:\.\d+)?)/i,
    reason: 'the public trial is time-boxed and must not advertise a dollar-valued credit grant',
  },
  {
    pattern: /\bpay[- ]as[- ]you[- ]go\b|\bpaga(?:s)? por uso\b/i,
    reason: 'Duet requires a monthly subscription after the trial',
  },
  {
    pattern:
      /\b(?:no|zero) platform fees?\b|\bno platform (?:markup|charge)\b|\bsin (?:cargos?|comisiones?) de plataforma\b/i,
    reason: 'the launch offer is a monthly plan rather than a fee-free usage-only rail',
  },
  {
    pattern: /\bno subscription required\b|\bsin suscripci[oó]n(?: necesaria|required)?\b/i,
    reason: 'an active subscription is required after the trial',
  },
  {
    pattern:
      /\b(?:only|just) pay for (?:the )?(?:tokens?|usage|what you use)\b|\bpay only for (?:the )?(?:LLM )?tokens?\b|\b(?:usage-based pricing|priced? (?:only )?(?:around|by|on) usage)\b|\b(?:tokens?|token costs?) (?:are )?(?:passed through|billed|priced) at cost\b|\bsolo pagas? por (?:los )?(?:tokens?|lo que usas?)\b|\bpaga solo por (?:los )?tokens?\b/i,
    reason: 'Duet pricing must describe the subscription and paid-reserve overage together',
  },
]

const thirdPartyBillingContext =
  /\b(?:OpenClaw|Codex|Claude|Anthropic|OpenAI|ChatGPT|Cursor|Lovable|Viktor|Retool|API|AWS|DigitalOcean)\b/i

export function classifyBillingCopyLine(line: string): ProductCopyDecision {
  const trialDuration =
    /\b(?:trial|(?:la|una) prueba(?: gratis)?|prueba gratis|per[ií]odo de prueba)\b/i.test(line)
      ? line.match(/\b(\d+)(?:-days?|\s+days?|\s+d[ií]as?)\b/i)
      : null
  if (trialDuration && Number(trialDuration[1]) !== TRIAL_DAYS) {
    return {
      kind: 'removed',
      reason: `the public trial duration must match the ${TRIAL_DAYS}-day contract timebox`,
    }
  }
  if (/\bno subscription to Retool\b|\bsin suscripci[oó]n a Retool\b/i.test(line)) {
    return { kind: 'allowed', reason: 'a replaced third-party subscription, not Duet entitlement' }
  }
  const retired = retiredBillingClaims.find(rule => rule.pattern.test(line))
  if (!retired) return { kind: 'unrelated' }
  if (thirdPartyBillingContext.test(line) && !/\bDuet\b/i.test(line)) {
    return { kind: 'allowed', reason: 'a third-party pricing model, not a Duet billing promise' }
  }
  return { kind: 'removed', reason: retired.reason }
}

const retiredSurfaceClaims: ReadonlyArray<CopyRule> = [
  {
    pattern:
      /Duet(?:'s)?\s+(?:public\s+)?skills?\s+(?:catalog|section|manager|library)|skills?\s+(?:catalog|section|manager)\s+in\s+Duet/i,
    reason: 'the current release has no Duet skills catalog or management surface',
  },
  {
    pattern:
      /(?:per-org prepaid credits|\$100\/month per org|\$100\/mes por organizaci[oó]n|cr[eé]ditos prepagos por organizaci[oó]n)/i,
    reason: 'billing is user-owned through the workspace-designated payer',
  },
]

const candidateTerms =
  /\b(?:channels?|threads?|chat|mentions?|unreads?|relays?|workos|canal(?:es)?|hilos?|mensajes?|menciones?)\b/i

const removedProductClaims: ReadonlyArray<CopyRule> = [
  {
    pattern:
      /team collaboration app, with messaging|app de colaboraci[oó]n[^.]*mensajer[ií]a|operates directly in DMs and group channels|opera directamente en DMs y canales grupales|combines chat, agents|combine chat, agentes|consolidate chat, agents|consolidar chat, agentes/i,
    reason: 'Duet sessions replace the old internal messaging product model',
  },
  {
    pattern:
      /workspace files, apps, chats|shared chat workspace|workspace de chat compartido|Duet channel|canal(?:es)? (?:de )?Duet|drop into a channel|same chat|mismo chat|Duet Chat|workspace your team chats in|comparten canales, hilos|chat del equipo|el chat y los canales compartidos/i,
    reason: 'Duet copy must describe sessions, files, apps, or workspace history',
  },
  {
    pattern: /\bDuet(?:'s)?\s+(?:chat|channels?)\b|\b(?:chat|channels?)\s+(?:inside|in)\s+Duet\b/i,
    reason: 'Duet no longer has an internal team-chat or channel surface',
  },
  {
    pattern:
      /\b(?:each|every)\s+(?:client|project|repo)\b[^.]{0,100}\b(?:dedicated|own)\s+channels?\b|\bproject channels?\b|\bclient(?:'s)? channels?\b/i,
    reason: 'work belongs in workspaces, files, and sessions rather than product channels',
  },
  {
    pattern:
      /\b(?:cada|todos? los?)\s+(?:cliente|proyecto|repo)\b[^.]{0,120}\bcanal(?:es)?\s+(?:dedicados?|propios?)\b|\bcanales?\s+de\s+proyecto\b|\bcanal(?:es)?\s+del\s+cliente\b/i,
    reason: 'el trabajo vive en workspaces, archivos y sesiones, no en canales del producto',
  },
  {
    pattern:
      /\b(?:humans?\s+and\s+AI|AI\s+and\s+humans?)\b[^.]{0,100}\bshared channels?\b|\b(?:humanos?\s+y\s+(?:la\s+)?AI|(?:la\s+)?AI\s+y\s+los\s+humanos?)\b[^.]{0,100}\bcanales? compartidos?\b/i,
    reason: 'people and AI collaborate through sessions and event history, not shared channels',
  },
  {
    pattern:
      /\bDuet(?:'s)?\b[^.]{0,120}\b(?:shared|team|internal|own) channels?\b|\bDuet\b[^.]{0,120}\bcanales? (?:compartidos?|del equipo|internos?|propios?)\b|\bmensajes?\s+Duet\b|\bDuet\s+mensajes?\b/i,
    reason: 'Duet has sessions and files rather than an internal messaging surface',
  },
  {
    pattern: /@\s?duet\b.*\bthread\b/i,
    reason: 'Duet sessions do not expose mention-driven threads',
  },
  {
    pattern: /@\s?duet\b.*\bhilo\b/i,
    reason: 'Duet no longer has Spanish channel/thread product claims',
  },
  {
    pattern: /"channelName"\s*:/,
    reason: 'the retired sign-in channel showcase must not return',
  },
  {
    pattern: /\b(?:relays?|workos)\b/i,
    reason: 'retired Relay and WorkOS product claims must not return',
  },
]

const legitimateContexts: ReadonlyArray<CopyRule> = [
  {
    pattern: /^\s*channels:\s*(?:string\[\]|\[)/,
    reason: 'canvas delivery destinations, not Duet navigation',
  },
  {
    pattern:
      /\b(?:Slack|Teams|Discord|email|correo|inboxes|inbox|bandeja|support|soporte|tickets?|senders?|remitentes?|recruiters?|reclutadores?|Messenger|WhatsApp|IMAP|CRM)\b[^\n]*(?:channels?|threads?|chat|canal(?:es)?|hilos?)|(?:channels?|threads?|chat|canal(?:es)?|hilos?)[^\n]*\b(?:Slack|Teams|Discord|email|correo|inboxes|inbox|bandeja|support|soporte|tickets?|senders?|remitentes?|recruiters?|reclutadores?|Messenger|WhatsApp|IMAP|CRM)\b/i,
    reason: 'an external messaging, inbox, or support workflow',
  },
  {
    pattern:
      /\b(?:ChatGPT|Claude|Lovable|Cursor|Viktor|Pumble|Mattermost|Sai)\b[^\n]*(?:channels?|threads?|chat|canal(?:es)?|hilos?)|(?:channels?|threads?|chat|canal(?:es)?|hilos?)[^\n]*\b(?:ChatGPT|Claude|Lovable|Cursor|Viktor|Pumble|Mattermost|Sai)\b/i,
    reason: 'a third-party or competitor capability',
  },
  {
    pattern:
      /\b(?:LinkedIn|TikTok|Twitter|X thread|social media|redes sociales|newsletter|bolet[ií]n|content|contenido|posts?|publicaciones|topics?|temas|distribution|distribuci[oó]n|marketing|ventas|outbound|salientes?|prospects?|prospectos?|leads?|clientes? potenciales?)\b[^\n]*(?:channels?|threads?|canal(?:es)?|hilos?)|(?:channels?|threads?|canal(?:es)?|hilos?)[^\n]*\b(?:LinkedIn|TikTok|Twitter|social media|redes sociales|newsletter|bolet[ií]n|content|contenido|posts?|publicaciones|topics?|temas|distribution|distribuci[oó]n|marketing|ventas|outbound|salientes?|prospects?|prospectos?|leads?|clientes? potenciales?)\b/i,
    reason: 'a publishing or marketing distribution channel',
  },
  {
    pattern:
      /(?:per-platform bot tokens.*messaging channel|team channel or email|canal del equipo o email)/i,
    reason: 'an external messaging destination',
  },
  {
    pattern:
      /(?:ephemeral|stateless)\s+(?:AI\s+)?chat|chat\s+session|whether or not anyone opens a chat|chat de AI ef[ií]mero|sesi[oó]n de chat sin estado/i,
    reason: 'a comparison with a transient chat interface',
  },
]

const managedProductContext =
  /\bDuet(?:'s)?\b[^\n]*(?:channels?|threads?|chat|canal(?:es)?|hilos?)|(?:channels?|threads?|chat|canal(?:es)?|hilos?)[^\n]*\bDuet(?:'s)?\b|\bDuet(?:'s)?\s+mensajes?\b|\bmensajes?\s+Duet(?:'s)?\b/i

export function classifyProductCopyLine(line: string): ProductCopyDecision {
  const retired = retiredSurfaceClaims.find(rule => rule.pattern.test(line))
  if (retired) return { kind: 'removed', reason: retired.reason }

  if (!candidateTerms.test(line)) return { kind: 'unrelated' }

  const removed = removedProductClaims.find(rule => rule.pattern.test(line))
  if (removed) return { kind: 'removed', reason: removed.reason }

  const legitimate = legitimateContexts.find(rule => rule.pattern.test(line))
  if (legitimate) return { kind: 'allowed', reason: legitimate.reason }

  if (managedProductContext.test(line)) {
    return {
      kind: 'review',
      reason: 'Duet product copy must name sessions, files, apps, or workspace history explicitly',
    }
  }

  return { kind: 'allowed', reason: 'unbranded editorial discussion' }
}

async function main() {
  const productCopyFiles = new Set([
    ...PRODUCT_COPY_OWNERS,
    ...collect('content', '**/*.mdx'),
    ...collect('messages', '*/marketing.json'),
  ])
  const files = [
    ...collect('app', '**/*.{ts,tsx,md,mdx,json}'),
    ...collect('components', '**/*.{ts,tsx,md,mdx,json}'),
    ...collect('content', '**/*.{ts,tsx,md,mdx,json}'),
    ...collect('lib', '**/*.{ts,tsx,md,mdx,json}'),
    ...collect('messages', '**/*.{ts,tsx,md,mdx,json}'),
  ]
  const failures: string[] = []
  let reviewed = 0
  const allowedByReason = new Map<string, number>()

  for (const relativePath of [...new Set(files)].sort()) {
    const source = await readFile(path.join(LANDER_ROOT, relativePath), 'utf8')
    for (const [index, line] of source.split('\n').entries()) {
      const billingDecision = classifyBillingCopyLine(line)
      if (billingDecision.kind === 'removed' || billingDecision.kind === 'review') {
        failures.push(`${relativePath}:${index + 1}: ${billingDecision.reason}`)
        continue
      }
      if (!productCopyFiles.has(relativePath)) continue
      const decision = classifyProductCopyLine(line)
      if (decision.kind === 'unrelated') continue
      reviewed += 1
      if (decision.kind === 'removed' || decision.kind === 'review') {
        failures.push(`${relativePath}:${index + 1}: ${decision.reason}`)
        continue
      }
      allowedByReason.set(decision.reason, (allowedByReason.get(decision.reason) ?? 0) + 1)
    }
  }

  if (failures.length > 0) {
    console.error(
      ['Product copy boundary failed:', ...failures.map(failure => `- ${failure}`)].join('\n'),
    )
    process.exit(1)
  }

  console.log(`Product copy boundary reviewed ${reviewed} channel/thread/chat terms:`)
  for (const [reason, count] of allowedByReason) console.log(`- ${count} ${reason}`)
}

function collect(root: string, pattern: string): string[] {
  return [
    ...new Bun.Glob(pattern).scanSync({ cwd: path.join(LANDER_ROOT, root), onlyFiles: true }),
  ].map(relative => path.posix.join(root, relative))
}

if (import.meta.main) await main()
