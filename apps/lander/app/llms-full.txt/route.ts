import { buildLlmsFullText } from '@/lib/llms/index-text'
import { AGENT_TEXT_CACHE_CONTROL } from '@/lib/llms/markdown'

/** Every page the index lists, concatenated as one markdown document. */
export const dynamic = 'force-static'

export async function GET(): Promise<Response> {
  return new Response(await buildLlmsFullText(), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': AGENT_TEXT_CACHE_CONTROL,
    },
  })
}
