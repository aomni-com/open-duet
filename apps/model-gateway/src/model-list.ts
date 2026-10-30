export async function validateModelListResponse(upstream: Response): Promise<Response> {
  if (!upstream.ok) return upstream

  let body: unknown
  try {
    body = await upstream.json()
  } catch {
    return invalidModelListResponse()
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return invalidModelListResponse()
  }

  const record = body as Record<string, unknown>
  if (!Array.isArray(record.data)) return invalidModelListResponse()

  const data = record.data.filter(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false
    return typeof (entry as Record<string, unknown>).id === 'string'
  })

  return Response.json(
    { ...record, data },
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    },
  )
}

function invalidModelListResponse(): Response {
  return Response.json(
    {
      error: 'The upstream model catalog returned an invalid response.',
      code: 'invalid_upstream_response',
    },
    { status: 502 },
  )
}
