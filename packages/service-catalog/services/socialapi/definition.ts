import type { ServiceDefinition } from '../../src/index'
import { flat, free, route } from '../../src/vendor-helpers'

export const socialapi: ServiceDefinition = {
  id: 'socialapi',
  name: 'SocialAPI',
  summary: 'Social platform search and public data access.',
  category: 'social',
  docsUrl: 'https://docs.socialapi.me',
  notes: 'Use public search and lookup routes; account surfaces are private.',
  baseUrl: 'https://api.socialapi.me',
  auth: { kind: 'bearer' },
  unit: { name: 'call', microUsdPerUnit: 50000 },
  routes: [
    route('search', 'GET', '/twitter/search', 'generate', flat, {
      probe: { query: { query: 'example' } },
    }),
    route('lookup', 'GET', '/twitter/user/:id', 'generate', free),
    route('search-users', 'GET', '/twitter/search-users', 'generate', flat),
    route('tweet-get', 'GET', '/twitter/tweets/:id', 'generate', free),
    route('tweet-comments', 'GET', '/twitter/tweets/:id/comments', 'generate', flat),
    route('tweet-thread', 'GET', '/twitter/thread/:id', 'generate', flat),
    route('tweet-liking-users', 'GET', '/twitter/tweets/:id/liking_users', 'generate', flat),
    route('tweet-retweeted-by', 'GET', '/twitter/tweets/:id/retweeted_by', 'generate', flat),
    route('user-tweets', 'GET', '/twitter/user/:id/tweets', 'generate', flat),
    route('user-tweets-and-replies', 'GET', '/twitter/user/:id/tweets-and-replies', 'generate', flat),
    route('user-likes', 'GET', '/twitter/user/:id/likes', 'generate', flat),
    route('user-highlights', 'GET', '/twitter/user/:id/highlights', 'generate', flat),
    route('followers-list', 'GET', '/twitter/followers/list', 'generate', flat),
    route('friends-list', 'GET', '/twitter/friends/list', 'generate', flat),
  ],
}
