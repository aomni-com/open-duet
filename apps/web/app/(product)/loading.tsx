import { headers } from 'next/headers'

import { DriveBootstrapShell } from '../../spa/drive/bootstrap-shell'
import { productLocationFromHeaders } from '../../src/routing/product-request-path'

/**
 * Next streams the route-correct product shell while the dynamic page reads
 * the HttpOnly session and resolves identity. The same destination skeleton
 * remains in place through client hydration and route/data loading.
 */
export default async function ProductLoading() {
  const initialPath = productLocationFromHeaders(await headers())
  return <DriveBootstrapShell initialPath={initialPath} />
}
