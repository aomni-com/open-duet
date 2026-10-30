import { agentInstallText } from '../../src/install-copy'
import { siteConfig } from '../../src/site-config'

export function GET() {
  return new Response(agentInstallText(siteConfig()), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  })
}
