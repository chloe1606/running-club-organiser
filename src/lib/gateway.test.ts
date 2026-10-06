import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayError, mutateSheet } from "./gateway";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function configure(body: unknown) {
  vi.stubEnv("APPS_SCRIPT_GATEWAY_URL", "https://example.com/gateway");
  vi.stubEnv("APPS_SCRIPT_GATEWAY_SECRET", "test-only-placeholder");
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("gateway boundary", () => {
  it("accepts Apps Script null success fields", async () => {
    configure({ ok: true, code: null, message: null, data: { status: "confirmed" } });
    expect(await mutateSheet("book", {})).toEqual({ status: "confirmed" });
  });
  it.each([["FORBIDDEN", 403], ["STALE_VERSION", 409], ["LOCK_TIMEOUT", 503], ["RATE_LIMITED", 429]])(
    "maps %s even though Apps Script returns HTTP 200", async (code, status) => {
      configure({ ok: false, code, message: "Rejected" });
      await expect(mutateSheet("book", {})).rejects.toMatchObject({ status, code });
    },
  );
  it("does not allow payload to replace trusted credentials or operation", async () => {
    const fetcher = configure({ ok: true });
    await mutateSheet("book", { secret: "untrusted", operation: "authDeleteUser" });
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.operation).toBe("book");
    expect(body.secret).toBe("test-only-placeholder");
  });
  it("fails safely for invalid schemas, network or missing config", async () => {
    configure({ status: "success" });
    await expect(mutateSheet("book", {})).rejects.toMatchObject({ status: 502, code: "INVALID_RESPONSE" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("sensitive upstream URL")));
    await expect(mutateSheet("book", {})).rejects.toThrow("unavailable");
    vi.stubEnv("APPS_SCRIPT_GATEWAY_URL", "");
    await expect(mutateSheet("book", {})).rejects.toBeInstanceOf(GatewayError);
  });
  it("distinguishes a Google HTML deployment page from a network failure without exposing its content", async () => {
    configure({ ok: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>private upstream content</html>", {
      headers: { "Content-Type": "text/html" },
    })));
    await expect(mutateSheet("authGetUserByAccount", {})).rejects.toMatchObject({
      status: 502, code: "NON_JSON_RESPONSE",
      message: "The club gateway returned a non-JSON response. Check its deployment URL and access settings.",
    });
  });
  it("never sends the shared secret over plaintext", async () => {
    const fetcher = configure({ ok: true });
    vi.stubEnv("APPS_SCRIPT_GATEWAY_URL", "http://example.com/gateway");
    await expect(mutateSheet("book", {})).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("treats bad server gateway credentials as service configuration failure, not member sign-out", async () => {
    configure({ ok: false, code: "UNAUTHORIZED", message: "Invalid gateway credentials." });
    await expect(mutateSheet("book", {})).rejects.toMatchObject({ status: 503 });
  });
});
