import { toJSONSchema, type ZodType } from 'zod'

import {
  ApiRateLimitErrorSchema,
  DEVELOPER_API_ENDPOINTS,
  PUBLIC_API_ENDPOINT_CATEGORIES,
  type PublicApiEndpointCategory,
} from '@repo/contract'

export function EndpointReference({ category }: { category?: PublicApiEndpointCategory }) {
  const endpoints = DEVELOPER_API_ENDPOINTS.filter(
    endpoint => category === undefined || endpoint.category === category,
  )

  if (endpoints.length === 0) {
    return (
      <aside className="endpoint-pending" role="note">
        <strong>
          Reference pending{category === undefined ? '' : ` — ${categoryLabel(category)}`}
        </strong>
        <p>
          This workflow is documented conceptually, but no final public endpoint metadata is
          published for it yet. Method, path, scope, and wire-schema details will appear here only
          after the shared contract declares them.
        </p>
      </aside>
    )
  }

  const categories =
    category === undefined
      ? PUBLIC_API_ENDPOINT_CATEGORIES.filter(value =>
          endpoints.some(endpoint => endpoint.category === value),
        )
      : [category]

  return (
    <div className="endpoint-groups">
      <aside className="endpoint-pending" role="note">
        <strong>Common authenticated backpressure</strong>
        <p>
          Authenticated operations also share the general API budget. A refusal carries a{' '}
          <code>Retry-After</code> header and this common body; operation-specific errors remain
          listed with their endpoint.
        </p>
        <SchemaDetails label="429 error body" schema={ApiRateLimitErrorSchema} />
      </aside>
      {categories.map(value => (
        <EndpointGroup
          category={value}
          endpoints={endpoints.filter(endpoint => endpoint.category === value)}
          key={value}
        />
      ))}
    </div>
  )
}

function EndpointGroup({
  category,
  endpoints,
}: {
  category: PublicApiEndpointCategory
  endpoints: typeof DEVELOPER_API_ENDPOINTS
}) {
  const headingId = `${category}-endpoints`
  return (
    <section className="endpoint-group" aria-labelledby={headingId}>
      <header className="endpoint-group-heading">
        <h2 id={headingId}>{categoryLabel(category)}</h2>
        <span>
          {endpoints.length} {endpoints.length === 1 ? 'operation' : 'operations'}
        </span>
      </header>
      <div className="endpoint-list">
        {endpoints.map(endpoint => (
          <section className="endpoint" id={endpoint.id} key={endpoint.id}>
            <div className="endpoint-heading">
              <span className={`method method-${endpoint.method.toLowerCase()}`}>
                {endpoint.method}
              </span>
              <code>{breakablePath(endpoint.path)}</code>
            </div>
            <p>{endpoint.summary}</p>
            <dl>
              <div>
                <dt>Scope</dt>
                <dd>
                  <span className="scope-list">
                    {(Array.isArray(endpoint.scope) ? endpoint.scope : [endpoint.scope]).map(
                      (scope, index) => (
                        <span key={scope}>
                          {index === 0 ? null : ' or '}
                          <code>{scope}</code>
                        </span>
                      ),
                    )}
                    {endpoint.additionalScopes?.map(scope => (
                      <span key={scope}>
                        {' and '}
                        <code>{scope}</code>
                      </span>
                    ))}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Request</dt>
                <dd>
                  {endpoint.requestBody === 'binary' ? (
                    'Raw byte stream'
                  ) : endpoint.requestBody === 'none' ? (
                    'No request body'
                  ) : endpoint.requestSchema === undefined ? (
                    'No JSON request body'
                  ) : (
                    <SchemaDetails label="Request" schema={endpoint.requestSchema} io="input" />
                  )}
                </dd>
              </div>
              {endpoint.querySchema === undefined ? null : (
                <div>
                  <dt>Query</dt>
                  <dd>
                    <SchemaDetails
                      label="Query parameters"
                      schema={endpoint.querySchema}
                      io="input"
                    />
                  </dd>
                </div>
              )}
              {endpoint.requestHeaders === undefined ? null : (
                <div>
                  <dt>Headers</dt>
                  <dd>
                    <ul className="header-list">
                      {endpoint.requestHeaders.map(header => (
                        <li key={header.name}>
                          <code>{header.name}</code> — {header.description}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              <div>
                <dt>Response</dt>
                <dd>
                  {endpoint.successResponses !== undefined ? (
                    <ul>
                      {endpoint.successResponses.map(response => (
                        <li key={response.status}>
                          <code>{response.status}</code>{' '}
                          {response.responseBody === 'binary' ? (
                            'Raw byte stream'
                          ) : response.responseBody !== undefined ? (
                            'No structured response body'
                          ) : (
                            <SchemaDetails
                              label={`${response.status} response`}
                              schema={response.responseSchema}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : endpoint.responseBody === 'binary' ? (
                    'Raw byte stream'
                  ) : endpoint.responseSchema === undefined ? (
                    'No structured response body'
                  ) : (
                    <SchemaDetails label="Response" schema={endpoint.responseSchema} />
                  )}
                </dd>
              </div>
              {endpoint.errorSchema === undefined ? null : (
                <div>
                  <dt>Errors</dt>
                  <dd>
                    <SchemaDetails label="Error body" schema={endpoint.errorSchema} />
                  </dd>
                </div>
              )}
              <div>
                <dt>Delivery</dt>
                <dd>
                  {endpoint.streaming === 'sse' ? 'Server-sent event stream' : 'Standard response'}
                </dd>
              </div>
              <div>
                <dt>Retry</dt>
                <dd>
                  {endpoint.idempotent === true ? 'Declared idempotent' : 'Not declared idempotent'}
                </dd>
              </div>
            </dl>
          </section>
        ))}
      </div>
    </section>
  )
}

function breakablePath(path: string) {
  return path.split('/').map((segment, index) => (
    <span key={`${index}:${segment}`}>
      {index === 0 ? null : '/'}
      {segment}
      <wbr />
    </span>
  ))
}

function categoryLabel(category: PublicApiEndpointCategory): string {
  const label = category.replaceAll('-', ' ')
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

function SchemaDetails({
  label,
  schema,
  io = 'output',
}: {
  label: string
  schema: ZodType
  io?: 'input' | 'output'
}) {
  return (
    <details className="schema-details">
      <summary>{schema.description ?? `${label} JSON schema`}</summary>
      <pre>{JSON.stringify(toJSONSchema(schema, { io }), null, 2)}</pre>
    </details>
  )
}
