import { describe, expect, test } from 'bun:test'

import { classifyBillingCopyLine, classifyProductCopyLine } from './check-product-copy'
import { TRIAL_DAYS } from '../lib/public-site-config'

describe('billing copy policy', () => {
  test.each([
    'Start with a $10 trial.',
    'Duet is pay-as-you-go.',
    'No platform fee. You only pay for the tokens you use.',
    'No subscription required.',
    `Start with a ${TRIAL_DAYS + 1}-day free trial.`,
    'Paga por uso, sin cargos de plataforma.',
  ])('rejects a retired Duet billing claim: %s', claim => {
    expect(classifyBillingCopyLine(claim).kind).toBe('removed')
  })

  test.each([
    'OpenClaw is open source, so you only pay for AI API usage.',
    'Prueba el servicio al cliente durante 3 días.',
    `Start with a ${TRIAL_DAYS}-day free trial.`,
    'The subscription includes monthly credits, then overage draws from your paid reserve.',
    'Every Duet charge produces an invoice.',
  ])('allows current or third-party billing context: %s', claim => {
    expect(classifyBillingCopyLine(claim).kind).not.toBe('removed')
  })
})

describe('product copy policy', () => {
  test.each([
    'Each client gets a dedicated channel where the AI maintains full history.',
    'Duet work happens in shared channels where the whole team messages the agent.',
    'Cada proyecto tiene un canal dedicado donde todos hablan con la AI.',
    'Humans and AI collaborate in shared channels.',
    'Los humanos y la AI colaboran en canales compartidos.',
    'Duet lets teams collaborate in shared channels alongside Slack.',
    'Correo electrónico, Slack y mensajes Duet mantienen al equipo al día.',
    'Correo electrónico, Slack y canal Duet mantienen al equipo al día.',
    'Duet has team channels alongside Slack.',
  ])('rejects a retired managed-product claim: %s', claim => {
    expect(['removed', 'review']).toContain(classifyProductCopyLine(claim).kind)
  })

  test.each([
    'Duet sends a summary to your Slack channel after every run.',
    'Duet reads each email thread and drafts a support reply.',
    'Turn the article into a LinkedIn post and an X thread.',
    'ChatGPT is a chat window; Duet keeps durable sessions and files.',
    'A forum thread can reveal the language customers actually use.',
  ])('allows a concrete external or editorial use: %s', claim => {
    expect(classifyProductCopyLine(claim).kind).toBe('allowed')
  })
})
