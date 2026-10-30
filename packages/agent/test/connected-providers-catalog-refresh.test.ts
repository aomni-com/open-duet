import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as catalog from "../src/model-resolution/catalog.js";
import { createConnectedTokenManager } from "../src/connected-providers/tokens.js";
import { connectedProviders } from "../src/connected-providers/registry.js";
import { resolveModelName, resolveModelReference } from "../src/model-resolution/resolver.js";
import { duetStreamFn } from "../src/model-resolution/models.js";
import type { ConnectedProviderStore, ConnectionRecord } from "../src/connected-providers/store.js";

let savedSelection: ReturnType<typeof spyOn>;
function fixtureSavedSelection(selection: string): string;
function fixtureSavedSelection(selection: string | undefined): string | undefined;
function fixtureSavedSelection(selection: string | undefined): string | undefined {
  return selection === "github-copilot:retired-worker"
    ? "github-copilot:claude-opus-5.5"
    : selection;
}
beforeEach(() => {
  savedSelection = spyOn(catalog, "normalizeSavedModelSelection").mockImplementation(
    fixtureSavedSelection,
  );
});
afterEach(() => savedSelection.mockRestore());

test("launch refreshes retired Copilot availability before dispatching on the connected plan", async () => {
  const store = staleCopilotStore();
  const manager = createConnectedTokenManager({
    store,
    now: () => 1_000,
    refreshCredentials: async (provider, credentials) => {
      expect(provider).toBe("github-copilot");
      return { ...credentials, access: "new-valid-token", availableModelIds: ["claude-opus-5.5"] };
    },
  });
  const connections = await manager.loadSnapshot();
  await manager.ensureFreshTokens();
  const previousKey = process.env.DUET_API_KEY;
  process.env.DUET_API_KEY = "metered-fallback-key";
  try {
    const reference = resolveModelReference("github-copilot:claude-opus-5.5", {
      snapshot: () => ({ connections }),
      apiKey: (provider) => manager.apiKey(provider),
      applyHook: (provider, model) => {
        const credentials = manager.credentials(provider);
        const filter = connectedProviders()
          .find((entry) => entry.id === provider)
          ?.provider().filterModels;
        return !credentials ||
          !filter ||
          filter([model as never], { ...credentials, type: "oauth" }).length
          ? model
          : undefined;
      },
      refresh: (provider) => manager.refreshInBackground(provider),
    });
    const model = resolveModelName(reference);
    const requests: Array<{ url: string; model: unknown }> = [];
    const stream = duetStreamFn(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        apiKey: manager.apiKey("github-copilot"),
        fetch: (async (input: unknown, init?: RequestInit) => {
          requests.push({ url: String(input), model: JSON.parse(String(init?.body)).model });
          return new Response("controlled provider edge", { status: 500 });
        }) as never,
      },
    );
    for await (const _event of await stream) void _event;
    expect(requests).toEqual([
      { url: expect.stringContaining("githubcopilot.com"), model: "claude-opus-5.5" },
    ]);
    expect((await store.get("github-copilot"))?.credentials.availableModelIds).toEqual([
      "claude-opus-5.5",
    ]);
  } finally {
    if (previousKey === undefined) delete process.env.DUET_API_KEY;
    else process.env.DUET_API_KEY = previousKey;
  }
});

test("concurrent launches wait for the same availability refresh instead of using the stale token", async () => {
  const store = staleCopilotStore();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const manager = createConnectedTokenManager({
    store,
    now: () => 1000,
    refreshCredentials: async (provider, credentials) => {
      expect(provider).toBe("github-copilot");
      entered.resolve();
      await release.promise;
      return { ...credentials, access: "new-valid-token", availableModelIds: ["claude-opus-5.5"] };
    },
  });
  await manager.loadSnapshot();
  const first = manager.ensureFreshToken("github-copilot");
  await entered.promise;
  const second = manager.ensureFreshToken("github-copilot");
  release.resolve();
  expect(await Promise.all([first, second])).toEqual(["new-valid-token", "new-valid-token"]);
});

test("an account that still denies the successor is refreshed only once per boot", async () => {
  const store = staleCopilotStore();
  let refreshes = 0;
  const manager = createConnectedTokenManager({
    store,
    now: () => 1000,
    refreshCredentials: async (provider, credentials) => {
      expect(provider).toBe("github-copilot");
      refreshes += 1;
      return { ...credentials, access: "refreshed-token" };
    },
  });
  await manager.loadSnapshot();
  await manager.ensureFreshTokens();
  await manager.ensureFreshTokens();
  expect(refreshes).toBe(1);
  expect(manager.credentials("github-copilot")?.availableModelIds).toEqual(["retired-worker"]);
  expect(manager.apiKey("github-copilot")).toBe("refreshed-token");
});

function staleCopilotStore(): ConnectedProviderStore {
  const initial: ConnectionRecord = {
    provider: "github-copilot",
    connectedAt: 1,
    eligibility: "eligible",
    credentials: {
      access: "old-valid-token",
      refresh: "refresh-token",
      expires: 1_000_000,
      availableModelIds: ["retired-worker"],
    },
  };
  const records = new Map([[initial.provider, initial]]);
  return {
    async read() {
      return [...records.values()];
    },
    async get(id) {
      return records.get(id);
    },
    async remove(id) {
      records.delete(id);
    },
    async withLock(id, mutate) {
      const update = await mutate(records.get(id));
      if (update.next) records.set(id, update.next);
      return update.result;
    },
  };
}
