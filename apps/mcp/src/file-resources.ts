import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import {
  FileResourceSchema,
  VmUploadGrantSchema,
  type FileResource,
  type VmUploadGrant,
} from '@repo/contract'

import type { McpToolContext } from './server'
import { internalToolError, toolErrorFromApi } from './tool-results'

type FileResourceResult =
  | { ok: true; resource: FileResource }
  | { ok: false; result: CallToolResult }

type FileUploadGrantResult =
  | { ok: true; grant: VmUploadGrant }
  | { ok: false; result: CallToolResult }

export async function createFileResource(
  context: McpToolContext,
  workspace: string,
  path: string,
  requiredScopes: readonly string[],
  errorDetails: Record<string, unknown> = {},
): Promise<FileResourceResult> {
  let response: Response
  try {
    response = await context.fetch(`${context.apiBaseUrl}/v1/ws/${workspace}/file-downloads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ path }),
    })
  } catch {
    return {
      ok: false,
      result: internalToolError('file_resource_request_failed', requiredScopes, errorDetails),
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      result: await toolErrorFromApi(response, requiredScopes, errorDetails),
    }
  }

  try {
    const parsed = FileResourceSchema.safeParse(await response.json())
    if (parsed.success) return { ok: true, resource: parsed.data }
  } catch {
    // Invalid success responses are mapped to the same stable tool error below.
  }
  return {
    ok: false,
    result: internalToolError('invalid_file_resource', requiredScopes, errorDetails),
  }
}

export async function createFileUploadGrant(
  context: McpToolContext,
  workspace: string,
  pathPrefix: string,
  requiredScopes: readonly string[],
): Promise<FileUploadGrantResult> {
  let response: Response
  try {
    response = await context.fetch(`${context.apiBaseUrl}/v1/ws/${workspace}/file-uploads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${context.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ pathPrefix }),
    })
  } catch {
    return {
      ok: false,
      result: internalToolError('file_upload_grant_request_failed', requiredScopes),
    }
  }
  if (!response.ok) {
    return { ok: false, result: await toolErrorFromApi(response, requiredScopes) }
  }

  try {
    const parsed = VmUploadGrantSchema.safeParse(await response.json())
    if (parsed.success) return { ok: true, grant: parsed.data }
  } catch {
    // Invalid success responses are mapped to the same stable tool error below.
  }
  return {
    ok: false,
    result: internalToolError('invalid_file_upload_grant', requiredScopes),
  }
}

export function toResourceLink(resource: FileResource) {
  return {
    type: 'resource_link' as const,
    ...resource,
  }
}
