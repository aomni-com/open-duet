import { crustdata } from '../services/crustdata/definition'
import { dataforseo } from '../services/dataforseo/definition'
import { elevenlabs } from '../services/elevenlabs/definition'
import { firecrawl } from '../services/firecrawl/definition'
import { fullenrich } from '../services/fullenrich/definition'
import { socialapi } from '../services/socialapi/definition'

export { crustdata, dataforseo, elevenlabs, firecrawl, fullenrich, socialapi }

export const SERVICE_DEFINITIONS = [
  firecrawl,
  crustdata,
  fullenrich,
  dataforseo,
  elevenlabs,
  socialapi,
] as const
