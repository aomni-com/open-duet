import { buildLlmsIndex } from '@/lib/llms/index-text'
import { AGENT_TEXT_CACHE_CONTROL } from '@/lib/llms/markdown'

/**
 * The llms.txt index. Prerendered at build like the sitemap: its content is a
 * pure function of the repo, so serving it dynamically would only add a cold
 * start.
 */
export const dynamic = 'force-static'

export async function GET(): Promise<Response> {
  return new Response(await buildLlmsIndex(), {
    headers: {
      // text/plain, not text/markdown: the file is meant to open in a browser
      // as readable text, and the llms.txt convention serves it that way.
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': AGENT_TEXT_CACHE_CONTROL,
    },
  })
}
