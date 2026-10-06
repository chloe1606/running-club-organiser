import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ metadata: vi.fn(), values: vi.fn(), gateway: vi.fn() }));
vi.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: class {} },
    sheets: () => ({ spreadsheets: { get: mocks.metadata, values: { get: mocks.values } } }),
  },
}));
vi.mock("./gateway", () => ({ mutateSheet: mocks.gateway }));
import { readMembers } from "./sheets";

beforeEach(() => {
  vi.stubEnv("GOOGLE_SHEET_ID", "test-workbook");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "{}");
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("membership source cutover", () => {
  it("supports legacy read access before migration", async () => {
    mocks.metadata.mockResolvedValue({ data: { sheets: [{ properties: { title: "Members" } }] } });
    mocks.values.mockResolvedValue({ data: { values: [
      ["memberId", "email", "displayName", "roles", "active", "version"],
      ["old-id", "runner@example.com", "Runner", "runner", true, 1],
    ] } });
    expect((await readMembers())[0].memberId).toBe("old-id");
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it("uses the committed source after migration, not stale Users/Members", async () => {
    mocks.metadata.mockResolvedValue({ data: { sheets: [{ properties: { title: "_PlatformState" } }] } });
    mocks.gateway.mockResolvedValue({ members: [{
      id: "old-id", email: "runner@example.com", name: "Runner", roles: ["runner"], active: false, version: 2,
    }] });
    expect((await readMembers())[0].active).toBe("FALSE");
    expect(mocks.values).not.toHaveBeenCalled();
  });
  it("fails closed after a canonical read failure, never reverting to legacy roles", async () => {
    mocks.metadata.mockResolvedValue({ data: { sheets: [{ properties: { title: "_PlatformState" } }] } });
    mocks.gateway.mockRejectedValue(new Error("Service unavailable"));
    await expect(readMembers()).rejects.toThrow("unavailable");
    expect(mocks.values).not.toHaveBeenCalled();
  });
});
