import 'server-only'

import { siteConfig } from '../site-config'
import { browserSessionService } from './convex-browser-session'
import { createDuetProxy } from './duet-proxy'

export const duetProxy = createDuetProxy({
  apiOrigin: siteConfig().apiBaseUrl,
  browserSessions: browserSessionService,
})
