import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { toJSONSchema } from 'zod'

import { DEVELOPER_API_ENDPOINTS, PUBLIC_API_ENDPOINT_CATEGORIES } from '@repo/contract'

import { ENDPOINT_CATEGORY_ROUTES } from '../lib/docs'

const DOCS_ROOT = path.resolve(import.meta.dir, '..')
const LEDGER_PATH = path.join(DOCS_ROOT, 'tests/endpoint-coverage.generated.json')
const ids = new Set<string>()
const failures: string[] = []

for (const endpoint of DEVELOPER_API_ENDPOINTS) {
  if (ids.has(endpoint.id)) failures.push(`duplicate endpoint id: ${endpoint.id}`)
  ids.add(endpoint.id)
  if (!endpoint.path.startsWith('/v1/'))
    failures.push(`unversioned endpoint path: ${endpoint.path}`)
  if (!ENDPOINT_CATEGORY_ROUTES.has(endpoint.category)) {
    failures.push(`endpoint category has no docs route: ${endpoint.category}`)
  }
  if (endpoint.requestSchema !== undefined && endpoint.requestBody !== undefined) {
    failures.push(`endpoint declares two request body owners: ${endpoint.id}`)
  }
  const responseOwnerCount = [
    endpoint.responseSchema,
    endpoint.responseBody,
    endpoint.successResponses,
  ].filter(owner => owner !== undefined).length
  if (responseOwnerCount > 1) {
    failures.push(`endpoint declares multiple response owners: ${endpoint.id}`)
  }
  if (
    endpoint.requestSchema === undefined &&
    endpoint.requestBody !== 'binary' &&
    endpoint.requestBody !== 'none' &&
    endpoint.method !== 'GET' &&
    endpoint.method !== 'DELETE'
  ) {
    failures.push(`write endpoint has no request schema: ${endpoint.id}`)
  }
  if (responseOwnerCount === 0) failures.push(`endpoint has no response metadata: ${endpoint.id}`)
  for (const [label, schema, io] of [
    ['request', endpoint.requestSchema, 'input'],
    ['query', endpoint.querySchema, 'input'],
    ['response', endpoint.responseSchema, 'output'],
    ['error', endpoint.errorSchema, 'output'],
  ] as const) {
    if (schema === undefined) continue
    try {
      toJSONSchema(schema, { io })
    } catch (error) {
      failures.push(
        `${endpoint.id}: ${label} schema cannot render as JSON Schema (${String(error)})`,
      )
    }
  }
  if (endpoint.successResponses !== undefined) {
    const statuses = new Set<number>()
    for (const response of endpoint.successResponses) {
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
        failures.push(`${endpoint.id}: invalid success status ${response.status}`)
      }
      if (statuses.has(response.status)) {
        failures.push(`${endpoint.id}: duplicate success status ${response.status}`)
      }
      statuses.add(response.status)
      if (response.responseSchema !== undefined) {
        try {
          toJSONSchema(response.responseSchema, { io: 'output' })
        } catch (error) {
          failures.push(
            `${endpoint.id}: ${response.status} response schema cannot render as JSON Schema (${String(error)})`,
          )
        }
      }
    }
  }
}

const coveredCategories = new Set(DEVELOPER_API_ENDPOINTS.map(endpoint => endpoint.category))
const unpublishedCategories = PUBLIC_API_ENDPOINT_CATEGORIES.filter(
  category => !coveredCategories.has(category),
)
if (unpublishedCategories.length > 0) {
  failures.push(`public categories have no endpoint metadata: ${unpublishedCategories.join(', ')}`)
}
const ledger = `${JSON.stringify(
  {
    endpointCount: DEVELOPER_API_ENDPOINTS.length,
    documentedEndpointIds: [...ids].sort(),
    unpublishedCategories,
  },
  null,
  2,
)}\n`

if (process.argv.includes('--write')) {
  await writeFile(LEDGER_PATH, ledger)
  console.log(`Wrote ${path.relative(DOCS_ROOT, LEDGER_PATH)}.`)
} else {
  const committed = await readFile(LEDGER_PATH, 'utf8').catch(() => '')
  if (committed !== ledger)
    failures.push('endpoint coverage ledger drifted; run endpoint:coverage:write')
}

if (failures.length > 0) {
  console.error(
    ['Endpoint metadata verification failed:', ...failures.map(failure => `- ${failure}`)].join(
      '\n',
    ),
  )
  process.exit(1)
}

console.log(`Verified ${DEVELOPER_API_ENDPOINTS.length} contract-owned public endpoints.`)
