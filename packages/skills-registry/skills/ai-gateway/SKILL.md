---
name: ai-gateway
target: both
description: Call AI models through Duet's model gateway using DUET_GATEWAY_BASE_URL and DUET_API_KEY. Supports Vercel AI SDK, OpenAI-compatible, and Anthropic-compatible APIs.
---

# AI Gateway

Duet's model gateway is available at `DUET_GATEWAY_BASE_URL` and authenticates
with `DUET_API_KEY`. Both variables are system-managed. Model discovery lists
the full upstream model catalog, including uncatalogued image/video models and
unfamiliar model types. The gateway checks workspace spend before generation;
upstream validates the chosen model and operation.

Choose a model dynamically from `GET /v1/models`; do not embed a provider/model
slug in authored code or prose. The injected
`../media-creation/reference/models.json` maps stable Duet roles to the gateway
slugs those endpoints take, when a role-based choice is more appropriate.

## Model Discovery

```bash
curl -fsS "$DUET_GATEWAY_BASE_URL/v1/models" \
  -H "Authorization: Bearer $DUET_API_KEY"
```

This OpenAI-compatible model-list route preserves upstream model entries and
metadata. A listed model type does not add a new CLI operation.
For the examples below, select an appropriate id from that response and export
it as `MODEL_ID`.

App chat and embedding calls bill at provider cost. Set `x-duet-tier: services`
explicitly; omitting the header also defaults to provider-cost billing. Invalid
tier values are rejected. Model availability is separate from the workspace's
credit balance and spending eligibility.

Native image/video endpoints use the existing $2 reservation and actual-cost
settlement. That hold is an estimate, not a final-cost ceiling. Image-producing
language models use the language operation; known product media hints retain
reservation behavior, while uncatalogued language calls bill after the response.

## AI SDK

```typescript
import { createGateway } from 'ai'
import { streamText } from 'ai'

const gateway = createGateway({
  baseURL: `${process.env.DUET_GATEWAY_BASE_URL}/v4/ai`,
  headers: { 'x-duet-tier': 'services' },
  apiKey: process.env.DUET_API_KEY,
})

const result = streamText({
  model: gateway(process.env.MODEL_ID!),
  prompt: 'Hello!',
})
```

## OpenAI-compatible API

```typescript
import OpenAI from 'openai'

const client = new OpenAI({
  defaultHeaders: { 'x-duet-tier': 'services' },
  apiKey: process.env.DUET_API_KEY,
  baseURL: `${process.env.DUET_GATEWAY_BASE_URL}/v1`,
})

const response = await client.chat.completions.create({
  model: process.env.MODEL_ID!,
  messages: [{ role: 'user', content: 'Hello!' }],
})
```

## Anthropic-compatible API

```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  defaultHeaders: { 'x-duet-tier': 'services' },
  apiKey: process.env.DUET_API_KEY,
  baseURL: process.env.DUET_GATEWAY_BASE_URL,
})

const message = await client.messages.create({
  model: process.env.MODEL_ID!,
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
})
```

The selected model must support the API surface being used. Re-query
`/v1/models` to verify the model ID when a request is rejected; a billing or
authentication error is not evidence that only smaller models are available.
