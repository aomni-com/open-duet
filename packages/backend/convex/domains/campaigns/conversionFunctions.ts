import { microUsdToDollars, type JsonObject, type JsonValue } from '@repo/contract'

import type { ConversionFunction } from './conversionTypes'

// Signup and purchase are two outcomes of one journey: signup credits
// acquisition immediately so ad platforms keep learning on volume, and the
// first paid subscription credits revenue and ends the journey.
export const convertOnSignupAndPurchase: ConversionFunction<JsonObject> = async context => {
  const event = context.trigger.kind === 'event' ? context.trigger.event : undefined

  if (event?.name === 'user.signed_up') {
    return {
      state: {},
      eligible: true,
      done: false,
      id: `signup:${context.attribution.attributionId}`,
    }
  }

  if (event?.name === 'subscription.started') {
    const value = conversionValue(event.properties.monthlyPriceMicroUsd)
    return {
      state: {},
      eligible: true,
      done: true,
      id: `purchase:${context.attribution.attributionId}`,
      // A purchase is a conversion whether or not the amount is readable; the
      // value is extra context for bidding, never the eligibility criterion.
      ...(value === undefined ? {} : { value, currency: 'USD' }),
    }
  }

  return { state: context.state, eligible: false, done: false }
}

function conversionValue(microUsd: JsonValue | undefined): number | undefined {
  if (typeof microUsd !== 'number' || !Number.isFinite(microUsd)) return undefined
  return microUsdToDollars(microUsd)
}
