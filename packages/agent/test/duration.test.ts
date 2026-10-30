import { describe, expect, test } from "bun:test";
import { parseDurationToMs, parseWakeAtToMs } from "../src/turn-runner/duration.js";

describe("duration helpers", () => {
  describe("parseDurationToMs", () => {
    test("accepts a positive millisecond number", () => {
      expect(parseDurationToMs(5_000, "label")).toBe(5_000);
    });

    test("parses ms-style duration strings", () => {
      expect(parseDurationToMs("30s", "label")).toBe(30_000);
      expect(parseDurationToMs("15m", "label")).toBe(15 * 60_000);
      expect(parseDurationToMs("3h", "label")).toBe(3 * 60 * 60_000);
      expect(parseDurationToMs("5d", "label")).toBe(5 * 24 * 60 * 60_000);
    });

    test("trims whitespace around duration strings", () => {
      expect(parseDurationToMs("  3h  ", "label")).toBe(3 * 60 * 60_000);
    });

    test("rejects unparseable duration strings", () => {
      expect(() => parseDurationToMs("not-a-duration", "field")).toThrow(/could not parse/);
    });

    test("rejects empty strings", () => {
      expect(() => parseDurationToMs("   ", "field")).toThrow(/non-empty/);
    });

    test("rejects non-positive numbers", () => {
      expect(() => parseDurationToMs(0, "field")).toThrow(/positive/);
      expect(() => parseDurationToMs(-1, "field")).toThrow(/positive/);
    });

    test("rejects unsupported types", () => {
      expect(() => parseDurationToMs(undefined, "field")).toThrow();
      expect(() => parseDurationToMs(null, "field")).toThrow();
      expect(() => parseDurationToMs({}, "field")).toThrow();
    });
  });

  describe("parseWakeAtToMs", () => {
    test("accepts a Unix-epoch millisecond number", () => {
      expect(parseWakeAtToMs(1_716_543_600_000, "label")).toBe(1_716_543_600_000);
    });

    test("parses ISO 8601 strings", () => {
      const iso = "2026-05-24T18:00:00Z";
      expect(parseWakeAtToMs(iso, "label")).toBe(Date.parse(iso));
    });

    test("rejects unparseable date strings", () => {
      expect(() => parseWakeAtToMs("not-a-date", "field")).toThrow(/could not parse/);
    });

    test("rejects unsupported types", () => {
      expect(() => parseWakeAtToMs(undefined, "field")).toThrow();
      expect(() => parseWakeAtToMs({}, "field")).toThrow();
    });
  });
});
