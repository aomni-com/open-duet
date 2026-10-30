import type { AttributionSignals, JsonObject } from '@repo/contract'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface DeliveryView {
  conversionId: string
  occurredAt: number
  attributionCreatedAt: number
  campaignSlug: string
  attributionSignals: AttributionSignals
  sourceUrl?: string
  userId?: string
  eventName: string
  value?: number
  currency?: string
  properties: JsonObject
}

export interface DeliveryIdentity {
  email?: string
  externalId?: string
  ipAddress?: string
  userAgent?: string
}

export interface DisabledDestinationConfig {
  enabled: false
}

interface ValueDefaults {
  defaultValue?: number
  defaultCurrency?: string
}

export type MetaDestinationConfig =
  | DisabledDestinationConfig
  | ({
      enabled: true
      apiVersion: string
      pixelId: string
      eventName: string
    } & ValueDefaults)

export type GoogleDestinationConfig =
  | DisabledDestinationConfig
  | ({
      enabled: true
      accountId: string
      loginAccountId?: string
      conversionActionId: string
    } & ValueDefaults)

export type RedditDestinationConfig =
  | DisabledDestinationConfig
  | ({
      enabled: true
      pixelId: string
      trackingType: string
      customEventName?: string
    } & ValueDefaults)

export type OpenAiDestinationConfig =
  | DisabledDestinationConfig
  | ({
      enabled: true
      pixelId: string
      eventType: string
      customEventName?: string
      dataType: 'contents' | 'customer_action' | 'plan_enrollment' | 'custom'
      currencyExponents: Readonly<Record<string, number>>
    } & ValueDefaults)

export interface MetaCredentials {
  accessToken: string
}

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface RedditCredentials {
  accessToken: string
}

export interface OpenAiCredentials {
  apiKey: string
}

export async function deliverMeta(
  delivery: DeliveryView,
  identity: DeliveryIdentity,
  config: Extract<MetaDestinationConfig, { enabled: true }>,
  credentials: MetaCredentials,
  fetch: FetchLike,
): Promise<void> {
  const sourceUrl = requiredSourceUrl(delivery, 'Meta')
  const { value, currency } = resolvedValue(delivery, config)
  const userData = compact({
    em: identity.email === undefined ? undefined : [await hashNormalizedEmail(identity.email)],
    external_id:
      identity.externalId === undefined ? undefined : [await sha256(identity.externalId.trim())],
    client_ip_address: identity.ipAddress,
    client_user_agent: identity.userAgent,
    fbc:
      delivery.attributionSignals.fbclid === undefined
        ? undefined
        : `fb.1.${delivery.attributionCreatedAt}.${delivery.attributionSignals.fbclid}`,
  })
  if (Object.keys(userData).length === 0) {
    throw new Error('Meta delivery requires at least one user identifier')
  }

  const response = await fetch(
    `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.pixelId)}/events`,
    {
      method: 'POST',
      headers: jsonBearerHeaders(credentials.accessToken),
      body: JSON.stringify({
        data: [
          {
            action_source: 'website',
            event_id: delivery.conversionId,
            event_name: delivery.eventName,
            event_source_url: sourceUrl,
            event_time: Math.floor(delivery.occurredAt / 1_000),
            user_data: userData,
            ...(value === undefined && currency === undefined
              ? {}
              : { custom_data: compact({ value, currency }) }),
          },
        ],
      }),
    },
  )
  assertSuccess('Meta delivery', response)
}

export async function deliverGoogle(
  delivery: DeliveryView,
  identity: DeliveryIdentity,
  config: Extract<GoogleDestinationConfig, { enabled: true }>,
  credentials: GoogleCredentials,
  fetch: FetchLike,
): Promise<void> {
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })
  assertSuccess('Google OAuth refresh', tokenResponse)
  const token = await tokenResponse.json().catch(() => null)
  if (
    typeof token !== 'object' ||
    token === null ||
    typeof (token as { access_token?: unknown }).access_token !== 'string' ||
    !(token as { access_token: string }).access_token
  ) {
    throw new Error('Google OAuth refresh returned no access token')
  }

  const { value, currency } = resolvedValue(delivery, config)
  const adIdentifiers = selectGoogleClickId(delivery.attributionSignals)
  const emailAddress =
    identity.email === undefined ? undefined : await hashNormalizedEmail(identity.email)
  const response = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
    method: 'POST',
    headers: jsonBearerHeaders((token as { access_token: string }).access_token),
    body: JSON.stringify({
      destinations: [
        {
          ...(config.loginAccountId === undefined
            ? {}
            : {
                loginAccount: {
                  accountId: config.loginAccountId,
                  accountType: 'GOOGLE_ADS',
                },
              }),
          operatingAccount: {
            accountId: config.accountId,
            accountType: 'GOOGLE_ADS',
          },
          productDestinationId: config.conversionActionId,
        },
      ],
      ...(emailAddress === undefined ? {} : { encoding: 'HEX' }),
      events: [
        {
          ...(adIdentifiers === undefined ? {} : { adIdentifiers }),
          ...(value === undefined ? {} : { conversionValue: value }),
          ...(currency === undefined ? {} : { currency }),
          eventSource: 'WEB',
          eventTimestamp: new Date(delivery.occurredAt).toISOString(),
          transactionId: delivery.conversionId,
          ...(emailAddress === undefined
            ? {}
            : { userData: { userIdentifiers: [{ emailAddress }] } }),
        },
      ],
      validateOnly: false,
    }),
  })
  assertSuccess('Google delivery', response)
}

export async function deliverReddit(
  delivery: DeliveryView,
  identity: DeliveryIdentity,
  config: Extract<RedditDestinationConfig, { enabled: true }>,
  credentials: RedditCredentials,
  fetch: FetchLike,
): Promise<void> {
  const { value, currency } = resolvedValue(delivery, config)
  const user = compact({
    email: identity.email === undefined ? undefined : await hashRedditEmail(identity.email),
    external_id:
      identity.externalId === undefined ? undefined : await sha256(identity.externalId.trim()),
    ip_address: identity.ipAddress,
    user_agent: identity.userAgent,
  })
  const response = await fetch(
    `https://ads-api.reddit.com/api/v3/pixels/${encodeURIComponent(config.pixelId)}/conversion_events`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...jsonBearerHeaders(credentials.accessToken),
      },
      body: JSON.stringify({
        data: {
          events: [
            {
              action_source: 'WEBSITE',
              ...(delivery.attributionSignals.rdt_cid === undefined
                ? {}
                : { click_id: delivery.attributionSignals.rdt_cid }),
              event_at: delivery.occurredAt,
              ...(sourceUrl(delivery) === undefined
                ? {}
                : { event_source_url: sourceUrl(delivery) }),
              metadata: compact({
                conversion_id: delivery.conversionId,
                value,
                currency,
              }),
              type: compact({
                tracking_type: delivery.eventName,
                custom_event_name: config.customEventName,
              }),
              ...(Object.keys(user).length === 0 ? {} : { user }),
            },
          ],
        },
      }),
    },
  )
  assertSuccess('Reddit delivery', response)
}

export async function deliverOpenAi(
  delivery: DeliveryView,
  identity: DeliveryIdentity,
  config: Extract<OpenAiDestinationConfig, { enabled: true }>,
  credentials: OpenAiCredentials,
  fetch: FetchLike,
): Promise<void> {
  const resolvedSourceUrl = requiredSourceUrl(delivery, 'OpenAI')
  const { value, currency } = resolvedValue(delivery, config)
  const amount =
    value === undefined
      ? undefined
      : toMinorUnits(value, requiredCurrency(currency), config.currencyExponents)
  const user = compact({
    email_sha256:
      identity.email === undefined ? undefined : await hashNormalizedEmail(identity.email),
    external_id_sha256:
      identity.externalId === undefined ? undefined : await sha256(identity.externalId.trim()),
    ip_address: identity.ipAddress,
    user_agent: identity.userAgent,
  })
  const response = await fetch(
    `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(config.pixelId)}`,
    {
      method: 'POST',
      headers: jsonBearerHeaders(credentials.apiKey),
      body: JSON.stringify({
        events: [
          {
            action_source: 'web',
            data: compact({
              amount,
              currency: amount === undefined ? undefined : currency,
              type: config.dataType,
            }),
            id: delivery.conversionId,
            ...(config.customEventName === undefined
              ? {}
              : { custom_event_name: config.customEventName }),
            ...(delivery.attributionSignals.oppref === undefined
              ? {}
              : { oppref: delivery.attributionSignals.oppref }),
            source_url: resolvedSourceUrl,
            timestamp_ms: delivery.occurredAt,
            type: delivery.eventName,
            ...(Object.keys(user).length === 0 ? {} : { user }),
          },
        ],
        validate_only: false,
      }),
    },
  )
  assertSuccess('OpenAI delivery', response)
}

export function selectGoogleClickId(
  signals: AttributionSignals,
): { gclid: string } | { gbraid: string } | { wbraid: string } | undefined {
  if (signals.gclid !== undefined) return { gclid: signals.gclid }
  if (signals.gbraid !== undefined) return { gbraid: signals.gbraid }
  if (signals.wbraid !== undefined) return { wbraid: signals.wbraid }
  return undefined
}

function sourceUrl(delivery: DeliveryView): string | undefined {
  return delivery.sourceUrl ?? delivery.attributionSignals.sourceUrl
}

function requiredSourceUrl(delivery: DeliveryView, provider: string): string {
  const value = sourceUrl(delivery)
  if (value === undefined) throw new Error(`${provider} website delivery requires a source URL`)
  return value
}

function resolvedValue(
  delivery: DeliveryView,
  config: ValueDefaults,
): { value?: number; currency?: string } {
  return {
    value: delivery.value ?? config.defaultValue,
    currency: delivery.currency ?? config.defaultCurrency,
  }
}

function requiredCurrency(currency: string | undefined): string {
  if (currency === undefined) {
    throw new Error('OpenAI monetary delivery requires a currency')
  }
  return currency.toUpperCase()
}

function toMinorUnits(
  value: number,
  currency: string,
  exponents: Readonly<Record<string, number>>,
): number {
  const exponent = exponents[currency]
  if (exponent === undefined || !Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new Error(`OpenAI currency exponent is not configured for ${currency}`)
  }
  const amount = Math.round(value * 10 ** exponent)
  if (!Number.isSafeInteger(amount)) throw new Error('OpenAI minor-unit amount exceeds safe range')
  return amount
}

async function hashNormalizedEmail(value: string): Promise<string> {
  return await sha256(value.trim().toLowerCase())
}

async function hashRedditEmail(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase()
  const separator = normalized.lastIndexOf('@')
  if (separator <= 0 || separator === normalized.length - 1) return await sha256(normalized)
  const local = normalized.slice(0, separator)
  const domain = normalized.slice(separator + 1)
  const canonicalLocal = (local.split('+')[0] ?? '').replaceAll('.', '')
  return await sha256(`${canonicalLocal}@${domain}`)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function jsonBearerHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function compact<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function assertSuccess(label: string, response: Response): void {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`)
}
