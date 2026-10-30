import { DOCS_ROUTES } from '../../lib/docs'

export interface DocsVisualRoute {
  readonly route: string
  readonly captureRoute: string
  readonly visualId: string
}

export const DOCS_VISUAL_ROUTES: readonly DocsVisualRoute[] = [
  ...DOCS_ROUTES.map(route => ({
    route: route.href,
    captureRoute: route.href,
    visualId: route.visualId,
  })),
  {
    route: '/404',
    captureRoute: '/missing-document-for-visual-coverage',
    visualId: 'docs-not-found',
  },
]
