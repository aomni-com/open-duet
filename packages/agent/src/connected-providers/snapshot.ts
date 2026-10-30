import { configuredRouterProviders } from "../model-resolution/resolver.js";
import type { TransportSnapshot } from "./transport-preference.js";
import { loadConnectedTokensSnapshot } from "./tokens.js";

process.env.DUET_CODEX_ORIGINATOR ??= "duet";

let transportSnapshot: TransportSnapshot = Object.freeze({ connections: Object.freeze([]) });
let transportSnapshotLoad: Promise<void> | undefined;

/**
 * Test-only: pin or reset the process-global transport snapshot. The global
 * leaks across test files in one worker; suites that assert transport
 * choices must pin it instead of inheriting whichever file loaded first.
 */
export function setConnectedTransportSnapshotForTest(snapshot?: TransportSnapshot): void {
  transportSnapshot = Object.freeze(snapshot ?? { connections: Object.freeze([]) });
  transportSnapshotLoad = snapshot === undefined ? undefined : Promise.resolve();
}

/**
 * Read connected-provider routing state once for this CLI process and seed the
 * synchronous token cache from the same records. Later store changes become
 * visible on the next CLI invocation, keeping model resolution free of I/O.
 */
export function loadConnectedTransportSnapshot(): Promise<void> {
  transportSnapshotLoad ??= loadConnectedTokensSnapshot().then((connections) => {
    transportSnapshot = Object.freeze({
      connections: Object.freeze(
        connections.map(({ provider, eligibility }) => ({ provider, eligibility })),
      ),
      configuredRouters: Object.freeze(configuredRouterProviders()),
    });
  });
  return transportSnapshotLoad;
}

/** Immutable connected-provider routing state captured at CLI boot. */
export function connectedTransportSnapshot(): TransportSnapshot {
  return transportSnapshot;
}

/** Demote one connection for the lifetime of this CLI session without touching disk. */
export function demoteConnectedTransport(
  provider: TransportSnapshot["connections"][number]["provider"],
): void {
  transportSnapshot = Object.freeze({
    ...transportSnapshot,
    connections: Object.freeze(
      transportSnapshot.connections.map((connection) =>
        connection.provider === provider
          ? { ...connection, eligibility: "plan_ineligible" as const }
          : connection,
      ),
    ),
  });
}
