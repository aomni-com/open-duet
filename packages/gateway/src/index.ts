import { runDesktopBrowserCli } from './desktop/browser-cli'
import { startGatewayFromEnv } from './runtime/http'

export function gatewayEntryMode(argv: string[]): 'desktop-browser' | 'gateway' {
  return argv[2] === '--desktop-browser-cli' ? 'desktop-browser' : 'gateway'
}

if (import.meta.main) {
  if (gatewayEntryMode(process.argv) === 'desktop-browser') {
    void runDesktopBrowserCli().catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
  } else {
    startGatewayFromEnv()
  }
}
