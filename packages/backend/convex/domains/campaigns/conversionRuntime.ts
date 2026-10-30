import type { JsonObject } from '@repo/contract'

import { campaignBySlug, type CampaignDefinition } from './config'
import type { ConversionFunctionContext, ConversionResult } from './conversionTypes'

export interface ConfiguredConversionResult {
  functionName: string
  result: ConversionResult
}

export async function runConfiguredConversion(
  campaignSlug: string,
  context: Omit<ConversionFunctionContext<JsonObject>, 'config'>,
  lookup: (slug: string) => CampaignDefinition | undefined = campaignBySlug,
): Promise<ConfiguredConversionResult> {
  const conversion = lookup(campaignSlug)?.conversion
  if (conversion === undefined) {
    throw new Error(`Campaign ${campaignSlug} has no live conversion`)
  }
  return {
    functionName: conversion.run.name,
    result: await conversion.run({
      ...context,
      config: conversion.config,
    }),
  }
}
