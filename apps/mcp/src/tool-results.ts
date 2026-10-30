import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export async function jsonResult(response: Response): Promise<CallToolResult> {
  const body = (await response.json()) as Record<string, unknown>
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  }
}

export async function toolErrorFromApi(
  response: Response,
  requiredScopes: readonly string[],
  details: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const body = await readApiError(response)
  const missingScopes = typeof body.scope === 'string' ? [body.scope] : requiredScopes
  const error = {
    error: body.error,
    status: response.status,
    requiredScopes,
    missingScopes: response.status === 403 ? missingScopes : undefined,
    ...details,
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error) }],
    structuredContent: error,
  }
}

export function internalToolError(
  error: string,
  requiredScopes: readonly string[],
  details: Record<string, unknown> = {},
): CallToolResult {
  const toolError = {
    error,
    status: 500,
    requiredScopes,
    ...details,
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(toolError) }],
    structuredContent: toolError,
  }
}

async function readApiError(response: Response): Promise<{ error: string; scope?: string }> {
  try {
    const body = (await response.json()) as { error?: unknown; scope?: unknown }
    return {
      error: typeof body.error === 'string' ? body.error : `http_${response.status}`,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    }
  } catch {
    return { error: `http_${response.status}` }
  }
}
