import type { ServiceDefinition } from '../../src/index'
import { free, route } from '../../src/vendor-helpers'
import { elevenCredits, withElevenlabsVoiceLabels } from './hooks'

export const elevenlabs: ServiceDefinition = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  summary: 'Speech, dialogue, sound effects, music, and voice tools.',
  category: 'audio',
  docsUrl: 'https://elevenlabs.io/docs',
  llmsTxtUrl: 'https://elevenlabs.io/docs/llms.txt',
  notes: 'Created voices are shared-pool resources with a 24-hour lifetime.',
  baseUrl: 'https://api.elevenlabs.io',
  auth: { kind: 'header', name: 'xi-api-key' },
  unit: { name: 'credit', microUsdPerUnit: 80 },
  usage: {
    path: '/v1/usage/character-stats',
    read: json => {
      const usage = (json as { usage?: unknown } | null)?.usage
      if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return {}
      return Object.fromEntries(
        Object.entries(usage).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isFinite(entry[1]),
        ),
      )
    },
  },
  routes: [
    route('tts', 'POST', '/v1/text-to-speech/:voiceId', 'generate', elevenCredits, {
      probe: {
        path: '/v1/text-to-speech/CPEHCHnlRsWkpvhbDlfn',
        json: { text: 'Hi', model_id: 'eleven_flash_v2_5' },
      },
    }),
    route('tts-stream', 'POST', '/v1/text-to-speech/:voiceId/stream', 'generate', elevenCredits, {
      probe: {
        path: '/v1/text-to-speech/CPEHCHnlRsWkpvhbDlfn/stream',
        json: { text: 'Hi', model_id: 'eleven_flash_v2_5' },
      },
    }),
    route('dialogue', 'POST', '/v1/text-to-dialogue', 'generate', elevenCredits),
    route('sound-effects', 'POST', '/v1/sound-generation', 'generate', elevenCredits, {
      probe: { json: { text: 'short click', duration_seconds: 0.5 } },
    }),
    route('music', 'POST', '/v1/music', 'generate', elevenCredits, {
      probe: {
        json: { prompt: 'single soft tone', music_length_ms: 10000, force_instrumental: true },
      },
    }),
    route('stt', 'POST', '/v1/speech-to-text', 'generate', elevenCredits),
    route('models', 'GET', '/v1/models', 'publicRead', free),
    // The curated shared library is reusable vendor content; unlike /v2/voices
    // it does not enumerate Duet-created workspace resources.
    route('shared-voices', 'GET', '/v1/shared-voices', 'publicRead', free),
    route('voice-create', 'POST', '/v1/voices/add', 'sharedPool', free, {
      pool: { pool: 'voice', role: 'create', idFrom: 'voice_id' },
    }),
    route(
      'voice-create-library',
      'POST',
      '/v1/voices/add/:publicUserId/:voiceId',
      'sharedPool',
      free,
      { pool: { pool: 'voice', role: 'create', idFrom: 'voice_id' } },
    ),
    route('voice-create-design', 'POST', '/v1/text-to-voice', 'sharedPool', free, {
      pool: { pool: 'voice', role: 'create', idFrom: 'voice_id' },
    }),
    route('voice-get', 'GET', '/v1/voices/:voiceId', 'sharedPool', free, {
      pool: { pool: 'voice', role: 'read' },
    }),
    route('voice-edit', 'POST', '/v1/voices/:voiceId/edit', 'sharedPool', free, {
      pool: { pool: 'voice', role: 'mutate', idParam: 'voiceId' },
    }),
    route('voice-delete', 'DELETE', '/v1/voices/:voiceId', 'sharedPool', free, {
      pool: { pool: 'voice', role: 'delete', idParam: 'voiceId' },
    }),
  ],
  pools: [
    {
      id: 'voice',
      ttlMs: 24 * 60 * 60 * 1000,
      expire: { method: 'DELETE', path: '/v1/voices/:voiceId' },
      quota: { read: 'voice_slots_used' },
    },
  ],
  hooks: {
    needs: { requestJson: true, responseJson: false },
    beforeForward: withElevenlabsVoiceLabels,
  },
}
