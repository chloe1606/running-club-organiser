import { describe, expect, it } from "vitest";
import { parseCanonicalMembers, parseMembers } from "./sheets";

const headers = ["memberId", "email", "displayName", "roles", "active", "version"];
describe("membership validation", () => {
  it("reads legacy stable identities and overlapping roles", () => {
    expect(parseMembers(headers, [["old-id", "Runner@Example.com", "Example Runner", "runner,leader", true, 1]])[0])
      .toMatchObject({ memberId: "old-id", email: "runner@example.com", roles: "runner,leader", active: "TRUE" });
  });
  it("reads human-readable Users with the same identity", () => {
    expect(parseMembers(["User ID", "Email", "Name", "Role", "Active", "Version"],
      [["old-id", "runner@example.com", "Example Runner", "runner", false, 2]])[0])
      .toMatchObject({ memberId: "old-id", active: "FALSE" });
  });
  it("maps canonical member identities without reading stale legacy projections", () => {
    expect(parseCanonicalMembers({ members: [{
      id: "old-id", email: "Runner@Example.com", name: "Runner",
      roles: ["runner", "leader"], active: false, version: 3,
    }] })[0]).toMatchObject({ memberId: "old-id", active: "FALSE", roles: "runner,leader" });
    expect(() => parseCanonicalMembers({ members: [{
      id: "old-id", email: "runner@example.com", name: "Runner", roles: ["owner"], active: true, version: 1,
    }] })).toThrow();
  });
  it("rejects ambiguous identities, unknown roles and malformed headers", () => {
    const row = ["old-id", "runner@example.com", "Example Runner", "runner", "TRUE", 1];
    expect(() => parseMembers(headers, [row, ["other-id", "RUNNER@example.com", "Other", "runner", "TRUE", 1]])).toThrow("unique");
    expect(() => parseMembers(headers, [[...row.slice(0, 3), "owner", ...row.slice(4)]])).toThrow("invalid role");
    expect(() => parseMembers(["email"], [])).toThrow("headers");
  });
});
