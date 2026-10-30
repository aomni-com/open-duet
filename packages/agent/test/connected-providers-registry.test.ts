import { afterEach, describe, expect, test } from "bun:test";
import {
  connectedProviders,
  resolveConnectedProviderAlias,
} from "../src/connected-providers/registry.js";
import {
  FAKE_ISSUER_ENV,
  installFakeIssuerIfConfigured,
  resetFakeIssuer,
} from "../src/connected-providers/fake-issuer.js";

afterEach(() => resetFakeIssuer());

function codexProvider() {
  const entry = connectedProviders().find(({ id }) => id === "openai-codex");
  if (!entry) throw new Error("openai-codex is not a connected provider");
  return entry.provider();
}

describe("connected provider registry", () => {
  test("resolves user aliases and canonical provider ids", () => {
    expect(resolveConnectedProviderAlias("chatgpt")).toBe("openai-codex");
    expect(resolveConnectedProviderAlias("openai-codex")).toBe("openai-codex");
    expect(resolveConnectedProviderAlias("copilot")).toBe("github-copilot");
    expect(resolveConnectedProviderAlias("github-copilot")).toBe("github-copilot");
    expect(resolveConnectedProviderAlias("unknown")).toBeUndefined();
  });

  // The registry is the seam the rest of the agent reads a provider through,
  // so a fake issuer is only actually installed if it is visible here.
  test("fake issuer installation is unset-safe and idempotent", () => {
    const realBaseUrl = codexProvider().baseUrl;
    expect(installFakeIssuerIfConfigured({})).toBe("skipped");
    expect(codexProvider().baseUrl).toBe(realBaseUrl);

    const env = { [FAKE_ISSUER_ENV]: "http://127.0.0.1:43210" };
    expect(installFakeIssuerIfConfigured(env)).toBe("installed");
    const installed = codexProvider();
    expect(installed.baseUrl).toBe("http://127.0.0.1:43210");
    // Idempotent means the same instance, not merely an equal one: a rebuild
    // on every read would drop an in-flight login's state.
    expect(installFakeIssuerIfConfigured(env)).toBe("installed");
    expect(codexProvider()).toBe(installed);

    resetFakeIssuer();
    expect(codexProvider().baseUrl).toBe(realBaseUrl);
  });
});
