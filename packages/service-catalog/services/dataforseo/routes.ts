import { free, proxyRoutes } from '../../src/vendor-helpers'
import type { PriceRule } from '../../src/index'

export const dataforseoCost: PriceRule = { kind: 'responseJson', path: 'cost' }

export const dataforseoCostRouteEntries = [
  ['ai-keyword-volume', 'POST', '/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live'],
  ['ai-mode', 'POST', '/v3/serp/google/ai_mode/live/advanced'],
  ['ai-organic', 'POST', '/v3/serp/google/organic/live/advanced'],
  ['llm-mentions-search', 'POST', '/v3/ai_optimization/llm_mentions/search/live'],
  ['llm-mentions-aggregated', 'POST', '/v3/ai_optimization/llm_mentions/aggregated_metrics/live'],
  ['llm-mentions-top-domains', 'POST', '/v3/ai_optimization/llm_mentions/top_domains/live'],
  ['llm-mentions-top-pages', 'POST', '/v3/ai_optimization/llm_mentions/top_pages/live'],
  [
    'llm-mentions-cross-aggregated',
    'POST',
    '/v3/ai_optimization/llm_mentions/cross_aggregated_metrics/live',
  ],
  ['amazon-related-keywords', 'POST', '/v3/dataforseo_labs/amazon/related_keywords/live'],
  ['amazon-bulk-volume', 'POST', '/v3/dataforseo_labs/amazon/bulk_search_volume/live'],
  ['amazon-product-competitors', 'POST', '/v3/dataforseo_labs/amazon/product_competitors/live'],
  [
    'amazon-product-intersections',
    'POST',
    '/v3/dataforseo_labs/amazon/product_keyword_intersections/live',
  ],
  ['amazon-ranked-keywords', 'POST', '/v3/dataforseo_labs/amazon/ranked_keywords/live'],
  ['amazon-task-post', 'POST', '/v3/merchant/amazon/products/task_post'],
  ['amazon-task-get', 'GET', '/v3/merchant/amazon/products/task_get/:id', 'ownedById'],
  ['apple-keywords', 'POST', '/v3/dataforseo_labs/apple/keywords_for_app/live'],
  ['apple-competitors', 'POST', '/v3/dataforseo_labs/apple/app_competitors/live'],
  ['apple-intersection', 'POST', '/v3/dataforseo_labs/apple/app_intersection/live'],
  ['apple-bulk-metrics', 'POST', '/v3/dataforseo_labs/apple/bulk_app_metrics/live'],
  ['apple-searches-post', 'POST', '/v3/app_data/apple/app_searches/task_post'],
  ['apple-searches-get', 'GET', '/v3/app_data/apple/app_searches/task_get/:id', 'ownedById'],
  ['apple-reviews', 'POST', '/v3/app_data/apple/app_reviews/task_post'],
  ['apple-list', 'POST', '/v3/app_data/apple/app_list/task_post'],
  ['google-keywords', 'POST', '/v3/dataforseo_labs/google/keywords_for_app/live'],
  ['google-competitors', 'POST', '/v3/dataforseo_labs/google/app_competitors/live'],
  ['google-intersection', 'POST', '/v3/dataforseo_labs/google/app_intersection/live'],
  ['google-bulk-metrics', 'POST', '/v3/dataforseo_labs/google/bulk_app_metrics/live'],
  ['google-searches-post', 'POST', '/v3/app_data/google/app_searches/task_post'],
  ['google-reviews', 'POST', '/v3/app_data/google/app_reviews/task_post'],
  ['google-list', 'POST', '/v3/app_data/google/app_list/task_post'],
  ['domain-technologies', 'POST', '/v3/domain_analytics/technologies/domain_technologies/live'],
  ['google-ads-volume', 'POST', '/v3/keywords_data/google_ads/search_volume/live'],
  ['google-shopping-post', 'POST', '/v3/merchant/google/products/task_post'],
  ['google-shopping-get', 'GET', '/v3/merchant/google/products/task_get/:id', 'ownedById'],
  ['google-sellers-post', 'POST', '/v3/merchant/google/sellers/task_post'],
  ['google-product-spec', 'POST', '/v3/merchant/google/product_spec/task_post'],
  ['google-shopping-serp', 'POST', '/v3/serp/google/shopping/live/regular'],
  ['google-keyword-suggestions', 'POST', '/v3/dataforseo_labs/google/keyword_suggestions/live'],
  ['google-related-keywords', 'POST', '/v3/dataforseo_labs/google/related_keywords/live'],
  ['google-keywords-for-site', 'POST', '/v3/dataforseo_labs/google/keywords_for_site/live'],
  ['google-ranked-keywords', 'POST', '/v3/dataforseo_labs/google/ranked_keywords/live'],
  ['google-keyword-ideas', 'POST', '/v3/dataforseo_labs/google/keyword_ideas/live'],
  ['google-bulk-difficulty', 'POST', '/v3/dataforseo_labs/google/bulk_keyword_difficulty/live'],
  ['google-domain-intersection', 'POST', '/v3/dataforseo_labs/google/domain_intersection/live'],
  ['google-serp-competitors', 'POST', '/v3/dataforseo_labs/google/serp_competitors/live'],
  ['google-ads-keywords-for-site', 'POST', '/v3/keywords_data/google_ads/keywords_for_site/live'],
  ['google-ads-keywords-for-keywords', 'POST', '/v3/keywords_data/google_ads/keywords_for_keywords/live'],
  ['google-organic-regular', 'POST', '/v3/serp/google/organic/live/regular'],
  ['google-app-searches-get', 'GET', '/v3/app_data/google/app_searches/task_get/:id', 'ownedById'],
  ['google-app-reviews-get', 'GET', '/v3/app_data/google/app_reviews/task_get/:id', 'ownedById'],
  ['google-app-list-get', 'GET', '/v3/app_data/google/app_list/task_get/:id', 'ownedById'],
  ['apple-reviews-get', 'GET', '/v3/app_data/apple/app_reviews/task_get/:id', 'ownedById'],
  ['apple-list-get', 'GET', '/v3/app_data/apple/app_list/task_get/:id', 'ownedById'],
] as const

export const dataforseoRoutes = [
  ...proxyRoutes('dataforseo', dataforseoCostRouteEntries, dataforseoCost),
  ...proxyRoutes('dataforseo', [
    ['locations-and-languages', 'GET', '/v3/dataforseo_labs/locations_and_languages', 'publicRead'],
    ['ai-locations-and-languages', 'GET', '/v3/ai_optimization/ai_keyword_data/locations_and_languages', 'publicRead'],
  ], free),
]


