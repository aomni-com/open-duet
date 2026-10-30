export type SpaRoutingMode = { kind: 'browser' } | { kind: 'memory'; initialPath: string }

/**
 * `initialPath` is an explicit fixture boundary. Production always follows
 * browser history; its server-only location hint is carried separately.
 */
export function routingModeForInitialPath(initialPath: string | undefined): SpaRoutingMode {
  return initialPath === undefined ? { kind: 'browser' } : { kind: 'memory', initialPath }
}
