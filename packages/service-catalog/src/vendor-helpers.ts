import type { Route } from './index'

export const free: Route['price'] = { kind: 'free' }
export const flat: Route['price'] = { kind: 'flat', units: 1 }

export function route(
  id: string,
  method: Route['method'],
  path: string,
  admission: Route['admission'],
  price: Route['price'] = flat,
  extra: Partial<Route> = {},
): Route {
  return { id, method, path, admission, price, ...extra }
}

export function proxyRoutes(
  prefix: string,
  entries: ReadonlyArray<readonly [string, Route['method'], string, Route['admission']?]>,
  price: Route['price'] = flat,
): Route[] {
  return entries.map(([id, method, path, admission = 'generate']) =>
    route(`${prefix}-${id}`, method, path, admission, price),
  )
}
