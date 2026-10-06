import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { Booking } from "../src/lib/domain";
import type { PlatformSnapshot } from "../src/lib/platform-types";

const now = "2026-08-01T12:00:00.000Z";
class Clock extends Date {
  constructor(value?: string | number | Date) { super(value === undefined ? now : value); }
  static now() { return Date.parse(now); }
}
type Cell = string | number | boolean | Date;
class Sheet {
  cells: Cell[][] = [];
  protected = false;
  hidden = false;
  maxRows = 1000;
  maxColumns = 26;
  constructor(public name: string, private owner: Workbook) {}
  getRange(row: number, column: number, height = 1, width = 1) {
    const getValues = () => Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => this.cells[row - 1 + y]?.[column - 1 + x] ?? ""));
    const setValues = (values: Cell[][]) => {
      if (this.name === "_PlatformState" && this.owner.rejectCommit) throw new Error("write unavailable");
      if (this.name !== "_PlatformState" && this.owner.rejectProjection) throw new Error("projection unavailable");
      values.forEach((cells, y) => cells.forEach((value, x) => {
        this.cells[row - 1 + y] ??= [];
        this.cells[row - 1 + y][column - 1 + x] = value;
      }));
      if (this.name === "_PlatformState" && row === 1 && column === 1) this.owner.canonicalWrites++;
      if (this.name === "_PlatformState") this.owner.onCommit?.();
    };
    return {
      getValue: () => getValues()[0][0], getValues,
      setValue: (value: Cell) => setValues([[value]]), setValues,
    };
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.cells.length, 1), this.getLastColumn()); }
  getLastColumn() { return Math.max(1, ...this.cells.map((row) => row.length)); }
  getLastRow() {
    return this.cells.reduce((last, cells, index) => cells.some((value) => value !== "") ? index + 1 : last, 1);
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }
  insertRowsAfter(_row: number, rows: number) { this.maxRows += rows; }
  insertColumnsAfter(_column: number, columns: number) { this.maxColumns += columns; }
  setFrozenRows() {}
  clearContents() {
    if (this.owner.rejectProjection) throw new Error("projection unavailable");
    this.cells = [];
  }
  hideSheet() { this.hidden = true; }
  setName(name: string) { this.owner.sheets.delete(this.name); this.name = name; this.owner.sheets.set(name, this); }
  getProtections() { return []; }
  protect() {
    this.protected = true;
    const protection = {
      setDescription: () => protection, setWarningOnly: () => protection,
      addEditor: () => protection, getEditors: () => [], removeEditors: () => protection,
      canDomainEdit: () => false, setDomainEdit: () => protection,
    };
    return protection;
  }
}
class Workbook {
  sheets = new Map<string, Sheet>();
  rejectProjection = false;
  rejectCommit = false;
  onCommit?: () => void;
  backups = 0;
  canonicalWrites = 0;
  getSheets() { return [...this.sheets.values()]; }
  getSheetByName(name: string) { return this.sheets.get(name); }
  insertSheet(name: string) {
    if (this.sheets.has(name)) throw new Error("duplicate sheet");
    const sheet = new Sheet(name, this);
    this.sheets.set(name, sheet);
    return sheet;
  }
  getName() { return "Club"; }
  getId() { return "club-workbook"; }
  copy() { this.backups++; return { getId: () => "backup-" + this.backups }; }
}
function fixture(): PlatformSnapshot {
  return {
    demo: false,
    config: { location: "DEMO", timeZone: "Europe/London", startTime: "19:00", demoConfiguration: true },
    weeks: [{ id: "run", startsAt: "2026-08-11T17:30:00Z", bookingOpensAt: "2026-08-01T00:00:00Z", bookingClosesAt: "2026-08-11T16:30:00Z", status: "published", version: 1 }],
    groups: Array.from({ length: 13 }, (_, index) => ({
      id: "g" + (index + 1), runId: "run", number: index + 1, paceLabel: "DEMO", capacity: index === 0 ? 1 : 19, version: 1,
    })),
    members: [
      { id: "admin", email: "admin@example.org", name: "Admin", roles: ["admin", "runner"], active: true, version: 1 },
      { id: "one", email: "one@example.org", name: "One", roles: ["runner"], active: true, version: 1 },
      { id: "two", email: "two@example.org", name: "Two", roles: ["runner"], active: true, version: 1 },
      { id: "leader", email: "leader@example.org", name: "Leader", roles: ["runner", "leader", "sweeper"], active: true, version: 1 },
      { id: "inactive", email: "inactive@example.org", name: "Inactive", roles: ["runner"], active: false, version: 1 },
    ],
    bookings: [], attendance: [], audit: [],
  };
}
function booking(id: string, memberId: string, groupId = "g1", status: Booking["status"] = "confirmed"): Booking {
  return { id, memberId, groupId, runId: "run", status, source: "member", bookedAt: now, version: 1 };
}
function requestId(number: number) { return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`; }
interface Reply { ok: boolean; code?: string; data?: Record<string, unknown> & PlatformSnapshot; }
function harness(snapshot?: PlatformSnapshot) {
  const workbook = new Workbook();
  let locked = false;
  let secret: string | null = "test-gateway";
  let spreadsheetId: string | null = "club-workbook";
  let flushFailure = false;
  let sequence = 0;
  const user = { getEmail: () => "admin@example.org" };
  const context = createContext({
    Date: Clock, Set, JSON, Math, Number, String, Object, Array, Error,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key: string) => key === "GATEWAY_SECRET" ? secret : key === "SPREADSHEET_ID" ? spreadsheetId : null,
    }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (locked) return false; locked = true; return true; },
      releaseLock: () => { locked = false; },
    }) },
    Session: { getEffectiveUser: () => user },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (body: string) => ({ body, setMimeType() { return this; } }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => null,
      openById: (id: string) => { if (id !== "club-workbook") throw new Error("Unexpected workbook"); return workbook; },
      ProtectionType: { SHEET: "sheet" },
      flush: () => { if (flushFailure) { flushFailure = false; throw new Error("lost response after write"); } },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm: string, value: string) =>
        [...createHash("sha256").update(value, "utf8").digest()].map((byte) => byte > 127 ? byte - 256 : byte),
      getUuid: () => requestId(++sequence),
      formatDate: (date: Date, timeZone: string, pattern: string) => {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }).formatToParts(date);
        const get = (type: string) => parts.find((part) => part.type === type)!.value;
        const day = `${get("year")}-${get("month")}-${get("day")}`;
        if (pattern === "yyyy-MM-dd") return day;
        if (pattern === "HH:mm") return `${get("hour")}:${get("minute")}`;
        return `${day}T${get("hour")}:${get("minute")}:${get("second")}`;
      },
    },
  });
  for (const file of ["Code.gs", "Storage.gs"]) {
    runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context, { filename: file });
  }
  if (snapshot) workbook.insertSheet("_PlatformState").getRange(1, 1).setValue(JSON.stringify({ schemaVersion: 1, snapshot, receipts: [] }));
  const post = (request: Record<string, unknown>): Reply => {
    context.input = { postData: { contents: JSON.stringify({ secret: "test-gateway", spreadsheetId: "club-workbook", ...request }) } };
    return JSON.parse(runInContext("doPost(input).body", context));
  };
  const canonical = () => {
    const sheet = workbook.getSheetByName("_PlatformState")!;
    const first = JSON.parse(String(sheet.getRange(1, 1).getValue()));
    return first.storageFormat === "chunked-v1"
      ? JSON.parse(sheet.getRange(2, 1, first.chunkCount, 1).getValues().map((row) => String(row[0]).slice(first.chunkPrefix?.length ?? 0)).join(""))
      : first;
  };
  const state = () => canonical().snapshot as PlatformSnapshot;
  const mutate = (overrides: Record<string, unknown> = {}) => post({
    operation: "book", email: "one@example.org", requestId: requestId(1),
    runId: "run", groupId: "g1", runVersion: 1, groupVersion: 1, memberVersion: 1, ...overrides,
  });
  return {
    workbook, post, state, canonical, mutate, context,
    configureSecret: (value: string | null) => { secret = value; },
    configureSpreadsheet: (value: string | null) => { spreadsheetId = value; },
    loseFlush: () => { flushFailure = true; },
    isLocked: () => locked,
  };
}

describe("Apps Script locked gateway", () => {
  it("fails closed without a configured shared secret and never accepts browser-only identities", () => {
    const app = harness(fixture());
    app.configureSecret(null);
    expect(app.post({ operation: "snapshot", secret: null })).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    app.configureSecret("test-gateway");
    expect(app.post({ operation: "snapshot", secret: "" })).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(app.mutate({ email: undefined, memberId: "one" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(app.mutate({ email: "inactive@example.org" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("derives the optional current member from an active email in full server snapshots", () => {
    const app = harness(fixture());
    expect(app.post({ operation: "snapshot", email: " ONE@example.org " }).data?.currentMemberId).toBe("one");
    expect(app.post({ operation: "snapshot", email: "inactive@example.org" }).data?.currentMemberId).toBeUndefined();
    expect(app.post({ operation: "snapshot" }).data?.members).toHaveLength(5);
  });
  it("rejects missing or mismatched trusted workbook bindings before any reads or mutations", () => {
    const app = harness(fixture());
    expect(app.post({ operation: "snapshot", spreadsheetId: undefined })).toMatchObject({ ok: false, code: "WORKBOOK_MISMATCH" });
    expect(app.mutate({ spreadsheetId: "different-workbook" })).toMatchObject({ ok: false, code: "WORKBOOK_MISMATCH" });
    expect(app.state().bookings).toHaveLength(0);
    expect(app.state().audit).toHaveLength(0);
    expect(app.mutate()).toMatchObject({ ok: true });
    expect(app.mutate({ spreadsheetId: "different-workbook" })).toMatchObject({ ok: false, code: "WORKBOOK_MISMATCH" });
    expect(app.state().bookings).toHaveLength(1);
  });
  it("opens the configured workbook without active Web App spreadsheet context and fails closed when unconfigured", () => {
    const app = harness(fixture());
    expect(app.mutate()).toMatchObject({ ok: true });
    app.configureSpreadsheet(null);
    expect(app.post({ operation: "snapshot" })).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(app.mutate({ requestId: requestId(2) })).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(app.state().bookings).toHaveLength(1);
  });
  it("requires a UUID request ID", () => {
    const app = harness(fixture());
    expect(app.mutate({ requestId: "request-not-a-uuid" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(app.state().bookings).toHaveLength(0);
  });
  it("serializes two contenders for the last place, including refreshed retries", () => {
    const app = harness(fixture());
    let contender: Reply | undefined;
    app.workbook.onCommit = () => {
      app.workbook.onCommit = undefined;
      contender = app.mutate({ requestId: requestId(2), email: "two@example.org" });
    };
    expect(app.mutate()).toMatchObject({ ok: true, data: { status: "confirmed" } });
    expect(contender).toMatchObject({ ok: false, code: "LOCK_TIMEOUT" });
    expect(app.mutate({ requestId: requestId(2), email: "two@example.org" })).toMatchObject({ ok: false, code: "STALE_VERSION" });
    expect(app.mutate({ requestId: requestId(2), email: "two@example.org", runVersion: 2, groupVersion: 2 })).toMatchObject({ ok: true, data: { status: "waitlisted" } });
    expect(app.state().bookings.filter((entry) => entry.status === "confirmed")).toHaveLength(1);
    expect(app.isLocked()).toBe(false);
  });
  it("replays successful request IDs before checking stale versions but rejects conflicting reuse", () => {
    const app = harness(fixture());
    expect(app.mutate().ok).toBe(true);
    expect(app.mutate().ok).toBe(true);
    expect(app.state().bookings).toHaveLength(1);
    expect(app.state().audit).toHaveLength(1);
    expect(app.mutate({ groupId: "g2" })).toMatchObject({ ok: false, code: "REQUEST_ID_REUSED" });
    expect(app.mutate({ email: "two@example.org" })).toMatchObject({ ok: false, code: "REQUEST_ID_REUSED" });
  });
  it("preserves the entire original state on validation rejection or commit failure", () => {
    const initial = fixture();
    initial.bookings.push(booking("existing", "one"));
    const app = harness(initial);
    expect(app.mutate()).toMatchObject({ ok: false, code: "DUPLICATE_BOOKING" });
    expect(app.state()).toEqual(initial);
    expect(app.mutate({ operation: "switchGroup", groupId: "missing" }).ok).toBe(false);
    expect(app.state()).toEqual(initial);
    app.workbook.rejectCommit = true;
    expect(app.mutate({ operation: "switchGroup", groupId: "g2" }).ok).toBe(false);
    expect(app.state()).toEqual(initial);
  });
  it("commits despite projection failure and repairs readable A:J/L:Z tables on the next snapshot", () => {
    const app = harness(fixture());
    app.workbook.rejectProjection = true;
    expect(app.mutate()).toMatchObject({ ok: true, data: { projectionPending: true } });
    expect(app.state().bookings).toHaveLength(1);
    app.workbook.rejectProjection = false;
    expect(app.post({ operation: "snapshot" }).ok).toBe(true);
    const sheet = app.workbook.getSheetByName("Week_run")!;
    expect(sheet.cells[0].slice(0, 4)).toEqual(["Group", "Runner", "Status", "Booking Time"]);
    expect(sheet.cells[0].slice(11, 15)).toEqual(["Group", "Leader", "Sweeper", "Route Description"]);
    expect(sheet.cells[1][7]).toBe("one");
    expect(sheet.cells[1][1]).toBe("One");
    expect(sheet.cells.flat()).not.toContain("one@example.org");
    expect(sheet.cells[0][10]).toBeUndefined();
    expect(sheet.protected).toBe(true);
    expect(app.workbook.getSheetByName("Users")?.cells[0]).toEqual(["Email", "Name", "Role", "User ID", "Active", "Version"]);
  });
  it("recovers an ambiguous post-commit failure without duplicate side effects", () => {
    const app = harness(fixture());
    app.workbook.onCommit = () => app.loseFlush();
    expect(app.mutate()).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
    expect(app.state().bookings).toHaveLength(1);
    app.workbook.onCommit = undefined;
    expect(app.mutate()).toMatchObject({ ok: true, data: { status: "confirmed" } });
    expect(app.state().bookings).toHaveLength(1);
    expect(app.state().audit).toHaveLength(1);
  });
  it("switches into a full destination atomically and promotes the original FIFO queue by ID", () => {
    const initial = fixture();
    initial.groups[1].capacity = 1;
    initial.bookings.push(booking("existing", "one"), booking("destination", "admin", "g2"),
      booking("z", "two", "g1", "waitlisted"), booking("a", "leader", "g1", "waitlisted"));
    const app = harness(initial);
    expect(app.mutate({ operation: "switchGroup", groupId: "g2" })).toMatchObject({ ok: true, data: { status: "waitlisted" } });
    const bookings = app.state().bookings;
    expect(bookings.find((entry) => entry.id === "existing")?.status).toBe("cancelled");
    expect(bookings.find((entry) => entry.id === "a")?.status).toBe("confirmed");
    expect(bookings.find((entry) => entry.id === "z")?.status).toBe("waitlisted");
    expect(bookings.filter((entry) => entry.memberId === "one" && entry.status !== "cancelled")).toHaveLength(1);
  });
  it("leave promotes eligible runners and checks ownership/window", () => {
    const initial = fixture();
    initial.bookings.push(booking("existing", "one"), booking("queued", "two", "g1", "waitlisted"));
    const app = harness(initial);
    expect(app.mutate({ operation: "leave", groupId: "g2" })).toMatchObject({ ok: false, code: "WRONG_GROUP" });
    expect(app.mutate({ operation: "leave", groupId: undefined, groupVersion: undefined }).ok).toBe(true);
    expect(app.state().bookings.find((entry) => entry.id === "queued")?.status).toBe("confirmed");
    const closed = fixture();
    closed.weeks[0].bookingClosesAt = now;
    expect(harness(closed).mutate()).toMatchObject({ ok: false, code: "BOOKING_CLOSED" });
  });
  it("does not let legacy assignment bookings silently leave or switch groups", () => {
    const initial = fixture();
    initial.bookings.push({ ...booking("legacy-assignment", "one"), source: "assignment" });
    const app = harness(initial);
    expect(app.mutate({ operation: "leave", groupId: undefined, groupVersion: undefined })).toMatchObject({ ok: false, code: "ASSIGNMENT_EXISTS" });
    expect(app.mutate({ operation: "switchGroup", groupId: "g2" })).toMatchObject({ ok: false, code: "ASSIGNMENT_EXISTS" });
    expect(app.state()).toEqual(initial);
  });
  it("counts leader/sweeper occupants once, blocks assignment overflow and duplicate groups", () => {
    const initial = fixture();
    const app = harness(initial);
    expect(app.mutate({ operation: "assignLeader", email: "admin@example.org", memberId: "leader" }).ok).toBe(true);
    expect(app.mutate({ operation: "assignSweeper", email: "leader@example.org", requestId: requestId(2), memberId: "leader", runVersion: 2, groupVersion: 2 }).ok).toBe(true);
    expect(app.state().bookings).toHaveLength(1);
    expect(app.mutate({ requestId: requestId(3), runVersion: 3, groupVersion: 3 })).toMatchObject({ ok: true, data: { status: "waitlisted" } });
    expect(app.mutate({ operation: "assignLeader", email: "admin@example.org", memberId: "leader", requestId: requestId(4), groupId: "g2", runVersion: 4 })).toMatchObject({ ok: false, code: "DUPLICATE_BOOKING" });
    const full = fixture();
    full.bookings.push(booking("existing", "one"));
    expect(harness(full).mutate({ operation: "assignLeader", email: "admin@example.org", memberId: "leader" })).toMatchObject({ ok: false, code: "GROUP_FULL" });
  });
  it("rejects role escalation, wrong-group leader changes and ineligible assignments", () => {
    const initial = fixture();
    initial.groups[0].leaderId = "leader";
    initial.bookings.push({ ...booking("lead", "leader"), source: "assignment" });
    const app = harness(initial);
    expect(app.mutate({ operation: "publishRun" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(app.mutate({ operation: "updateMember", memberId: "one", name: "One", roles: ["admin"], active: true })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(app.mutate({ operation: "updateRoute", email: "leader@example.org", groupId: "g2", routeDescription: "route" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(app.mutate({ operation: "updateRoute", email: "leader@example.org", routeDescription: "route" }).ok).toBe(true);
    expect(app.mutate({ operation: "assignLeader", email: "admin@example.org", memberId: "one", runVersion: 2, groupVersion: 2, requestId: requestId(2) })).toMatchObject({ ok: false, code: "INVALID_ASSIGNMENT" });
  });
  it("protects the last admin and cancels a deactivated runner's future bookings", () => {
    const initial = fixture();
    initial.bookings.push(booking("existing", "one"), booking("queued", "two", "g1", "waitlisted"));
    const app = harness(initial);
    expect(app.mutate({ operation: "updateMember", email: "admin@example.org", memberId: "admin", name: "Admin", roles: ["runner"], active: true })).toMatchObject({ ok: false, code: "LAST_ADMIN" });
    expect(app.mutate({ operation: "updateMember", email: "admin@example.org", memberId: "one", name: "One", roles: ["runner"], active: false }).ok).toBe(true);
    expect(app.state().bookings.find((entry) => entry.id === "queued")?.status).toBe("confirmed");
    expect(app.mutate({ operation: "leave", runVersion: 2, groupVersion: 2, requestId: requestId(2) })).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
  it("rejects concurrent member updates unless the target member version is current", () => {
    const app = harness(fixture());
    const update = { operation: "updateMember", email: "admin@example.org", memberId: "one", name: "New name", roles: ["runner"], active: true };
    expect(app.mutate({ ...update, memberVersion: undefined })).toMatchObject({ ok: false, code: "STALE_VERSION" });
    expect(app.mutate(update)).toMatchObject({ ok: true, data: { version: 2 } });
    const committed = app.state();
    expect(app.mutate({ ...update, name: "Concurrent name", requestId: requestId(2) })).toMatchObject({ ok: false, code: "STALE_VERSION" });
    expect(app.state()).toEqual(committed);
    expect(app.mutate({ ...update, name: "Concurrent name", memberVersion: 2, requestId: requestId(2) })).toMatchObject({ ok: true, data: { version: 3 } });
  });
  it("never promotes after the cutoff when membership or assignment changes free a seat", () => {
    const initial = fixture();
    initial.weeks[0].bookingClosesAt = now;
    initial.bookings.push(booking("existing", "one"), booking("queued", "two", "g1", "waitlisted"));
    const app = harness(initial);
    expect(app.mutate({ operation: "updateMember", email: "admin@example.org", memberId: "one", name: "One", roles: ["runner"], active: false }).ok).toBe(true);
    expect(app.state().bookings.find((entry) => entry.id === "queued")?.status).toBe("waitlisted");
    const assigned = fixture();
    assigned.weeks[0].bookingClosesAt = now;
    assigned.groups[0].capacity = 2;
    assigned.groups[0].leaderId = "leader";
    assigned.groups[0].sweeperId = "admin";
    assigned.members[0].roles.push("sweeper");
    assigned.bookings.push({ ...booking("lead", "leader"), source: "assignment" },
      { ...booking("sweep", "admin"), source: "assignment" }, booking("queued", "one", "g1", "waitlisted"));
    const afterCutoff = harness(assigned);
    expect(afterCutoff.mutate({ operation: "assignSweeper", email: "admin@example.org", memberId: undefined }).ok).toBe(true);
    expect(afterCutoff.state().bookings.find((entry) => entry.id === "queued")?.status).toBe("waitlisted");
  });
  it("records durable queue joins, promotions and withdrawals with peak queue sizes", () => {
    const app = harness(fixture());
    expect(app.mutate().ok).toBe(true);
    expect(app.mutate({ email: "two@example.org", requestId: requestId(2), runVersion: 2, groupVersion: 2 }).ok).toBe(true);
    expect(app.mutate({ email: "leader@example.org", requestId: requestId(3), runVersion: 3, groupVersion: 3 }).ok).toBe(true);
    expect(app.mutate({ operation: "leave", requestId: requestId(4), runVersion: 4, groupVersion: 4 }).ok).toBe(true);
    const transitions = app.state().audit.filter((entry) => ["waitlistJoined", "promoted", "withdrawn"].includes(entry.action));
    expect(transitions.map((entry) => ({ action: entry.action, queueSize: entry.queueSize }))).toEqual([
      { action: "waitlistJoined", queueSize: 1 }, { action: "waitlistJoined", queueSize: 2 },
      { action: "withdrawn", queueSize: 2 }, { action: "promoted", queueSize: 1 },
    ]);
    expect(transitions.every((entry) => entry.at === now && entry.runId === "run" && entry.groupId === "g1")).toBe(true);
    const beforeReplay = app.state().audit.length;
    expect(app.mutate({ operation: "leave", requestId: requestId(4), runVersion: 4, groupVersion: 4 }).ok).toBe(true);
    expect(app.state().audit).toHaveLength(beforeReplay);
  });
  it("creates exactly 13 Tuesday groups with DST-aware times and copies routes without assignments", () => {
    const initial = fixture();
    initial.groups[0].routeDescription = "Copied route";
    initial.groups[0].leaderId = "leader";
    initial.bookings.push({ ...booking("lead", "leader"), source: "assignment" });
    const app = harness(initial);
    expect(app.mutate({ operation: "createWeek", email: "admin@example.org", date: "2026-10-27", copyFromRunId: "run" }).ok).toBe(true);
    const state = app.state();
    const week = state.weeks.find((entry) => entry.id === "run-2026-10-27")!;
    expect(week.startsAt).toBe("2026-10-27T19:00:00.000Z");
    expect(week.bookingClosesAt).toBe("2026-10-27T18:30:00.000Z");
    const groups = state.groups.filter((entry) => entry.runId === week.id);
    expect(groups).toHaveLength(13);
    expect(groups[0]).toMatchObject({ routeDescription: "Copied route", routeNeedsReview: true });
    expect(groups.every((entry) => !entry.leaderId && !entry.sweeperId)).toBe(true);
    expect(state.bookings).toHaveLength(1);
    expect(app.mutate({ operation: "createWeek", email: "admin@example.org", date: "2026-10-28", requestId: requestId(2) })).toMatchObject({ ok: false, code: "INVALID_DATE" });
  });
  it("enforces one future published week and cancellation cleanup", () => {
    const initial = fixture();
    initial.weeks.push({ ...initial.weeks[0], id: "next", status: "draft" });
    initial.groups.push(...initial.groups.map((entry) => ({ ...entry, id: "next-" + entry.id, runId: "next" })));
    initial.bookings.push(booking("existing", "one"));
    const app = harness(initial);
    expect(app.mutate({ operation: "publishRun", email: "admin@example.org", runId: "next" })).toMatchObject({ ok: false, code: "PUBLISHED_RUN_EXISTS" });
    expect(app.mutate({ operation: "cancelRun", email: "admin@example.org", cancellationReason: "" })).toMatchObject({ ok: false, code: "INVALID_CANCELLATION" });
    expect(app.mutate({ operation: "cancelRun", email: "admin@example.org", cancellationReason: "Weather" }).ok).toBe(true);
    expect(app.state().bookings[0].status).toBe("cancelled");
    expect(app.mutate({ operation: "publishRun", email: "admin@example.org", runId: "next", requestId: requestId(2) }).ok).toBe(true);
  });
  it("preserves cancellation leadership history while closing every active booking", () => {
    const initial = fixture();
    initial.groups[0].capacity = 2;
    initial.groups[0].leaderId = "leader";
    initial.groups[0].sweeperId = "leader";
    initial.bookings.push(booking("runner", "one"), { ...booking("assignment", "leader"), source: "assignment" });
    const app = harness(initial);
    expect(app.mutate({ operation: "cancelRun", email: "admin@example.org", cancellationReason: "Weather" }).ok).toBe(true);
    expect(app.state().groups[0]).toMatchObject({ leaderId: "leader", sweeperId: "leader", version: 2 });
    expect(app.state().bookings.every((entry) => entry.status === "cancelled")).toBe(true);
    const details = app.workbook.getSheetByName("Week_run")!.cells[1];
    expect(details.slice(11, 15)).toEqual(["Group 1", "Leader", "Leader", ""]);
    expect(details.slice(24, 26)).toEqual([0, 0]);
    expect(app.mutate({
      operation: "updateMember", email: "admin@example.org", memberId: "leader", name: "Former leader",
      roles: ["runner"], active: false, requestId: requestId(2),
    }).ok).toBe(true);
    expect(app.state().groups[0]).toMatchObject({ leaderId: "leader", sweeperId: "leader" });
  });
  it("restricts attendance to assigned leader and confirmed occupants after the start", () => {
    const initial = fixture();
    initial.weeks[0].startsAt = "2026-08-01T11:30:00Z";
    initial.groups[0].leaderId = "leader";
    initial.bookings.push(booking("existing", "one"), { ...booking("lead", "leader"), groupId: "g1", source: "assignment" });
    initial.groups[0].capacity = 19;
    const app = harness(initial);
    expect(app.mutate({ operation: "recordAttendance", memberId: "one", outcome: "present" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(app.mutate({ operation: "recordAttendance", email: "leader@example.org", memberId: "two", outcome: "present" })).toMatchObject({ ok: false, code: "NOT_CONFIRMED" });
    expect(app.mutate({ operation: "recordAttendance", email: "leader@example.org", memberId: "one", outcome: "present" }).ok).toBe(true);
    expect(app.state().attendance[0]).toMatchObject({ memberId: "one", outcome: "present", recordedAt: now });
    expect(app.mutate({ operation: "recordAttendance", email: "leader@example.org", memberId: "one", outcome: "absent", requestId: requestId(2), runVersion: 2, groupVersion: 2 }).ok).toBe(true);
    expect(app.state().attendance).toHaveLength(1);
  });
  it("protects archive with admin and version checks and retains history", () => {
    const initial = fixture();
    initial.weeks[0].startsAt = "2026-07-28T17:30:00Z";
    initial.bookings.push(booking("existing", "one"));
    const app = harness(initial);
    expect(app.mutate({ operation: "archiveRun" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(app.mutate({ operation: "archiveRun", email: "admin@example.org", runVersion: undefined })).toMatchObject({ ok: false, code: "STALE_VERSION" });
    expect(app.mutate({ operation: "archiveRun", email: "admin@example.org" }).ok).toBe(true);
    expect(app.state().weeks[0].status).toBe("archived");
    expect(app.state().bookings[0].id).toBe("existing");
    expect(app.mutate({ operation: "updateRoute", email: "admin@example.org", runVersion: 2, routeDescription: "edit", requestId: requestId(2) })).toMatchObject({ ok: false, code: "RUN_CLOSED" });
  });
  it("retains cancellation status rather than archiving cancelled weeks into completed analytics", () => {
    const initial = fixture();
    initial.weeks[0].startsAt = "2026-07-28T17:30:00Z";
    initial.weeks[0].status = "cancelled";
    initial.weeks[0].cancellationReason = "Weather";
    const app = harness(initial);
    expect(app.mutate({ operation: "archiveRun", email: "admin@example.org" })).toMatchObject({ ok: false, code: "RUN_CLOSED" });
    expect(app.state().weeks[0]).toMatchObject({ status: "cancelled", cancellationReason: "Weather" });
  });
  it("stores large snapshots in atomic chunks without pruning history and escapes projected formulas", () => {
    const initial = fixture();
    initial.groups.forEach((entry) => entry.routeDescription = "x".repeat(3500));
    const app = harness(initial);
    app.workbook.canonicalWrites = 0;
    expect(app.mutate()).toMatchObject({ ok: true });
    expect(app.workbook.canonicalWrites).toBe(1);
    expect(app.state().groups).toEqual(initial.groups.map((entry, index) => ({ ...entry, version: index === 0 ? 2 : 1 })));
    const manifest = JSON.parse(String(app.workbook.getSheetByName("_PlatformState")!.cells[0][0]));
    expect(manifest).toMatchObject({ schemaVersion: 1, storageFormat: "chunked-v1", chunkPrefix: "data:" });
    expect(manifest.chunkCount).toBeGreaterThan(1);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    const safe = harness(fixture());
    expect(safe.mutate({ operation: "updateMember", email: "admin@example.org", memberId: "one", name: "=IMPORTXML(\"unsafe\")", roles: ["runner"], active: true }).ok).toBe(true);
    expect(safe.workbook.getSheetByName("Users")?.cells[2][1]).toBe("'=IMPORTXML(\"unsafe\")");
  });
  it("supports a full 247-runner week plus twelve full archive weeks", () => {
    const initial = fixture();
    initial.groups.forEach((group) => group.capacity = 19);
    for (let index = 0; index < 247; index++) {
      const memberId = "runner-" + index;
      initial.members.push({ id: memberId, email: `runner${index}@example.org`, name: `Runner ${index}`, roles: ["runner"], active: true, version: 1 });
      initial.bookings.push(booking("full-" + index, memberId, "g" + (Math.floor(index / 19) + 1)));
    }
    const currentBookings = [...initial.bookings];
    const currentGroups = [...initial.groups];
    for (let week = 1; week <= 12; week++) {
      const runId = "history-" + week;
      initial.weeks.push({
        id: runId, startsAt: "2026-06-02T17:30:00Z", bookingOpensAt: "2026-05-25T00:00:00Z",
        bookingClosesAt: "2026-06-02T16:30:00Z", status: "archived", version: 2,
      });
      initial.groups.push(...currentGroups.map((group) => ({ ...group, id: runId + "-" + group.id, runId })));
      initial.bookings.push(...currentBookings.map((entry) => ({ ...entry, id: runId + "-" + entry.id, runId, groupId: runId + "-" + entry.groupId, bookedAt: "2026-05-25T00:00:00Z" })));
    }
    const app = harness(initial);
    app.workbook.canonicalWrites = 0;
    expect(app.mutate({ operation: "leave", email: "runner0@example.org" }).ok).toBe(true);
    expect(app.workbook.canonicalWrites).toBe(1);
    const manifest = JSON.parse(String(app.workbook.getSheetByName("_PlatformState")!.cells[0][0]));
    expect(manifest.length).toBeGreaterThan(600_000);
    expect(manifest.chunkCount).toBeGreaterThan(15);
    expect(app.post({ operation: "snapshot" }).data?.bookings).toHaveLength(247 * 13);
    expect(app.state().bookings.filter((entry) => entry.status === "confirmed")).toHaveLength(247 * 13 - 1);
  });
  it("fails closed on altered canonical chunks, even when their length is unchanged", () => {
    const app = harness(fixture());
    expect(app.mutate().ok).toBe(true);
    const sheet = app.workbook.getSheetByName("_PlatformState")!;
    sheet.cells[1][0] = String(sheet.cells[1][0]).replace('"One"', '"Eve"');
    expect(app.post({ operation: "snapshot" })).toMatchObject({ ok: false, code: "STATE_CORRUPT" });
    expect(app.mutate({ requestId: requestId(2) })).toMatchObject({ ok: false, code: "STATE_CORRUPT" });
  });
  it("does not fall back to legacy membership when a committed canonical manifest is lost", () => {
    const app = harness(fixture());
    expect(app.mutate().ok).toBe(true);
    app.workbook.getSheetByName("_PlatformState")!.cells[0][0] = "";
    expect(app.post({ operation: "snapshot" })).toMatchObject({ ok: false, code: "STATE_CORRUPT" });
  });
  it("keeps Unicode surrogate pairs together and clears trailing chunks when state shrinks", () => {
    const initial = fixture();
    initial.groups.forEach((group) => group.routeDescription = "🏃".repeat(3500));
    const app = harness(initial);
    expect(app.mutate().ok).toBe(true);
    const sheet = app.workbook.getSheetByName("_PlatformState")!;
    const previousRows = sheet.getLastRow();
    app.context.chunkInput = "x".repeat(39994) + "🏃y";
    const chunks = runInContext("chunkPlatformJson_(chunkInput)", app.context) as string[];
    expect(chunks).toEqual(["x".repeat(39994), "🏃y"]);
    runInContext('const shrinking = loadPlatformState_(); shrinking.snapshot.groups.forEach((group) => group.routeDescription = ""); commitPlatformState_(shrinking)', app.context);
    const manifest = JSON.parse(String(sheet.cells[0][0]));
    expect(manifest.chunkCount + 1).toBeLessThan(previousRows);
    expect(sheet.cells.slice(manifest.chunkCount + 1, previousRows).every((row) => row[0] === "")).toBe(true);
    expect(app.post({ operation: "snapshot" }).ok).toBe(true);
  });
  it("stores every chunk as inert prefixed text, even if a boundary begins with a formula", () => {
    const app = harness(fixture());
    runInContext(`const formulaCandidate = loadPlatformState_();
      formulaCandidate.snapshot.groups[0].routeDescription = "FORMULA_BOUNDARY";
      const position = JSON.stringify(formulaCandidate).indexOf("FORMULA_BOUNDARY");
      formulaCandidate.snapshot.groups[0].routeDescription =
        "x".repeat(39995 - (position % 39995)) + '=IMPORTXML("untrusted")';
      commitPlatformState_(formulaCandidate);`, app.context);
    const sheet = app.workbook.getSheetByName("_PlatformState")!;
    const manifest = JSON.parse(String(sheet.cells[0][0]));
    expect(sheet.getRange(2, 1, manifest.chunkCount, 1).getValues().every((row) => String(row[0]).startsWith("data:") && String(row[0]).length <= 40000)).toBe(true);
    expect(sheet.getRange(2, 1, manifest.chunkCount, 1).getValues().some((row) => String(row[0]).startsWith("data:="))).toBe(true);
    expect(app.post({ operation: "snapshot" }).ok).toBe(true);
  });
  it.each(["=", "+", "-", "@"])("escapes %s-prefixed names and routes in projections without changing canonical text", (prefix) => {
    const app = harness(fixture());
    const name = prefix + 'IMPORTDATA("https://example.invalid")';
    const route = prefix + 'IMAGE("https://example.invalid")';
    expect(app.mutate({
      operation: "updateMember", email: "admin@example.org", memberId: "one",
      name, roles: ["runner"], active: true,
    }).ok).toBe(true);
    expect(app.mutate({
      operation: "updateRoute", email: "admin@example.org", requestId: requestId(2),
      routeDescription: route,
    }).ok).toBe(true);
    expect(app.mutate({ requestId: requestId(3), runVersion: 2, groupVersion: 2 }).ok).toBe(true);
    expect(app.state().members.find((member) => member.id === "one")?.name).toBe(name);
    expect(app.state().groups[0].routeDescription).toBe(route);
    expect(app.workbook.getSheetByName("Users")!.cells.find((row) => row[3] === "one")?.[1]).toBe("'" + name);
    const week = app.workbook.getSheetByName("Week_run")!;
    expect(week.cells[1][1]).toBe("'" + name);
    expect(week.cells[1][14]).toBe("'" + route);
  });
  it("routes auth only under the shared lock and fails closed if auth is unavailable", () => {
    const app = harness(fixture());
    expect(app.post({ operation: "authGetUser" })).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    app.context.authDispatch_ = () => ({ body: JSON.stringify({ ok: app.isLocked(), data: { auth: true } }) });
    expect(app.post({ operation: "authGetUser" })).toMatchObject({ ok: true, data: { auth: true } });
    expect(app.isLocked()).toBe(false);
  });
});

describe("Apps Script manual migration", () => {
  function prepareConfiguration(app: ReturnType<typeof harness>, count = 13, capacity = 19) {
    app.post({ operation: "snapshot" });
    const definitions = app.workbook.getSheetByName("GroupDefinitions")!;
    definitions.cells.slice(1).forEach((row, index) => {
      row[1] = `${index + 1} km`;
      row[2] = `${index + 4}:00 min/km`;
      row[3] = capacity;
    });
    for (let number = definitions.cells.length; number <= count; number++) {
      definitions.cells.push([number, `${number} km`, `${number + 3}:00 min/km`, capacity, `definition-group-${number}`]);
    }
    app.workbook.getSheetByName("ClubConfiguration")!.cells = [
      ["Setting", "Value"], ["Location", "Confirmed club meeting point"], ["Time Zone", "America/New_York"],
      ["Start Time", new Date(Date.UTC(1899, 11, 30, 19, 30))], ["Demo Configuration", false],
    ];
  }
  function legacy() {
    const app = harness();
    const initial = fixture();
    app.workbook.insertSheet("Members").cells = [
      ["memberId", "email", "displayName", "roles", "active", "version"],
      ...initial.members.map((entry) => [entry.id, entry.email, entry.name, entry.roles.join(","), String(entry.active).toUpperCase(), entry.version]),
    ];
    app.workbook.insertSheet("Runs").cells = [
      ["runId", "startsAt", "bookingOpensAt", "bookingClosesAt", "status", "version"],
      ...initial.weeks.map((entry) => [entry.id, entry.startsAt, entry.bookingOpensAt, entry.bookingClosesAt, entry.status, entry.version]),
    ];
    app.workbook.insertSheet("Groups").cells = [
      ["groupId", "runId", "groupNumber", "paceLabel", "capacity", "version"],
      ...initial.groups.map((entry) => [entry.id, entry.runId, entry.number, entry.paceLabel, entry.capacity, entry.version]),
    ];
    app.workbook.insertSheet("Bookings").cells = [
      ["bookingId", "runId", "groupId", "memberId", "status", "bookingSource", "bookedAt", "version"],
      ["preserved", "run", "g1", "one", "confirmed", "member", now, 1],
    ];
    app.workbook.insertSheet("Archives").cells = [["archiveKey", "runId", "groupId", "confirmedCount"], ["run:old", "old", "oldgroup", 12]];
    return app;
  }
  it("reads legacy IDs, forbids competing writes and migrates once after a backup", () => {
    const app = legacy();
    expect(app.post({ operation: "snapshot" }).data?.bookings[0].id).toBe("preserved");
    expect(app.mutate()).toMatchObject({ ok: false, code: "MIGRATION_REQUIRED" });
    const archives = structuredClone(app.workbook.getSheetByName("Archives")!.cells);
    runInContext("migrateLegacyPlatform()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.state().bookings[0].id).toBe("preserved");
    expect(app.workbook.getSheetByName("Archives")!.cells).toEqual(archives);
    expect(app.workbook.getSheetByName("Legacy_Groups")?.cells[0][0]).toBe("groupId");
    expect(app.workbook.getSheetByName("Groups")?.cells[0].slice(0, 4)).toEqual(["Group", "Distance", "Pace", "Capacity"]);
    expect(app.workbook.getSheetByName("Members")?.protected).toBe(true);
    runInContext("migrateLegacyPlatform()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.state().bookings).toHaveLength(1);
  });
  it("can recover an interrupted migration projection without taking a second backup", () => {
    const app = legacy();
    app.workbook.rejectProjection = true;
    runInContext("migrateLegacyPlatform()", app.context);
    expect(app.state().bookings[0].id).toBe("preserved");
    app.workbook.rejectProjection = false;
    runInContext("migrateLegacyPlatform()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.workbook.getSheetByName("Week_run")?.cells[1][4]).toBe("preserved");
  });
  it("confirms backed-up master definitions and applies them to new weeks instead of copied demographics", () => {
    const initial = fixture();
    initial.groups[0].routeDescription = "Last week's route";
    const app = harness(initial);
    app.post({ operation: "snapshot" });
    runInContext('PLATFORM_CONFIG.location = "Club meeting point"; PLATFORM_CONFIG.timeZone = "America/New_York"; PLATFORM_CONFIG.startTime = "19:30"; PLATFORM_CONFIG.demoConfiguration = false', app.context);
    const master = app.workbook.getSheetByName("Groups")!;
    master.cells.slice(1).forEach((row, index) => {
      row[1] = `${index + 1} km`;
      row[2] = `${index + 4}:00 min/km`;
    });
    app.post({ operation: "snapshot" });
    expect(master.cells[1][1]).toBe("1 km");
    runInContext("confirmClubConfiguration()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.state().config).toMatchObject({ timeZone: "America/New_York", startTime: "19:30", demoConfiguration: false });
    expect(app.mutate({ operation: "createWeek", email: "admin@example.org", date: "2026-08-18", copyFromRunId: "run" }).ok).toBe(true);
    const group = app.state().groups.find((entry) => entry.runId === "run-2026-08-18" && entry.number === 1)!;
    expect(group).toMatchObject({
      id: "run-2026-08-18-definition-group-1", distanceLabel: "1 km", paceLabel: "4:00 min/km",
      capacity: 19, routeDescription: "Last week's route", routeNeedsReview: true,
    });
    expect(master.cells).toHaveLength(14);
    expect(master.cells[0]).toEqual(["Group", "Distance", "Pace", "Capacity", "Group ID"]);
  });
  it("accepts 20 groups at capacity 20 and rejects capacity above 20", () => {
    const initial = fixture();
    initial.groups[1].id = "run-definition-group-2";
    initial.groups[1].routeDescription = "Route for decimal group";
    const app = harness(initial);
    app.post({ operation: "snapshot" });
    runInContext('PLATFORM_CONFIG.location = "Club meeting point"; PLATFORM_CONFIG.demoConfiguration = false', app.context);
    const definitions = app.workbook.getSheetByName("Groups")!;
    definitions.cells.slice(1).forEach((row, index) => {
      row[1] = `${index + 1} km`;
      row[2] = `${index + 4}:00 min/km`;
      row[3] = 20;
    });
    for (let number = definitions.cells.length; number <= 20; number++) {
      definitions.cells.push([number, `${number} km`, `${number + 3}:00 min/km`, 20, `definition-group-${number}`]);
    }
    definitions.cells[1][3] = 21;
    expect(() => runInContext("confirmClubConfiguration()", app.context)).toThrow("capacity 1–20");
    expect(app.workbook.backups).toBe(0);
    definitions.cells[1][3] = 20;
    definitions.cells.push([21, "21 km", "24:00 min/km", 20, "definition-group-21"]);
    expect(() => runInContext("confirmClubConfiguration()", app.context)).toThrow("1–20 groups with unique positive numbers");
    expect(app.workbook.backups).toBe(0);
    definitions.cells.pop();
    definitions.cells[2][0] = 1.5;
    runInContext("confirmClubConfiguration()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.canonical().groupDefinitions).toHaveLength(20);
    expect(app.canonical().groupDefinitions[1]).toMatchObject({ number: 1.5, capacity: 20 });
    expect(app.canonical().groupDefinitions[19]).toMatchObject({ number: 20, capacity: 20 });
    expect(app.mutate({ operation: "createWeek", email: "admin@example.org", date: "2026-08-18", copyFromRunId: "run" }).ok).toBe(true);
    expect(app.state().groups.filter((group) => group.runId === "run-2026-08-18")).toHaveLength(20);
    expect(app.state().groups.find((group) => group.runId === "run-2026-08-18" && group.id.endsWith("definition-group-2"))).toMatchObject({
      number: 1.5, routeDescription: "Route for decimal group", routeNeedsReview: true,
    });
    expect(app.state().groups.filter((group) => group.runId === "run-2026-08-18").every((group) => group.capacity === 20)).toBe(true);
  });
  it("preserves twenty-person historical capacities while keeping the default template at nineteen", () => {
    const app = legacy();
    app.workbook.getSheetByName("Runs")!.cells[1][1] = "2026-07-28T17:30:00Z";
    app.workbook.getSheetByName("Runs")!.cells[1][4] = "archived";
    app.workbook.getSheetByName("Groups")!.cells.slice(1).forEach((row) => row[4] = 20);
    runInContext("migrateLegacyPlatform()", app.context);
    expect(app.state().groups.every((group) => group.capacity === 20)).toBe(true);
    expect(app.state().bookings[0].id).toBe("preserved");
    expect(app.canonical().groupDefinitions.every((group: { capacity: number }) => group.capacity === 19)).toBe(true);
  });
  it("seeds a new live club roster and confirmed definitions after initialization", () => {
    const app = harness();
    runInContext("initializeClubPlatform()", app.context);
    prepareConfiguration(app);
    const users = app.workbook.getSheetByName("UserSetup")!;
    users.cells.push(["runner@example.org", "Trusted club runner", "runner", "", true, 1]);
    runInContext("configureClubPlatform()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.state().members).toHaveLength(2);
    const trustedId = app.state().members.find((member) => member.email === "runner@example.org")!.id;
    expect(trustedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(app.state().config).toMatchObject({ location: "Confirmed club meeting point", timeZone: "America/New_York", startTime: "19:30", demoConfiguration: false });
    expect(app.canonical().groupDefinitions[0]).toMatchObject({ distanceLabel: "1 km", paceLabel: "4:00 min/km", capacity: 19 });
    expect(app.post({ operation: "snapshot", email: "runner@example.org" }).data?.currentMemberId).toBe(trustedId);
    expect(app.mutate({ operation: "createWeek", email: "admin@example.org", date: "2026-08-11" }).ok).toBe(true);
    expect(app.mutate({ operation: "publishRun", email: "admin@example.org", requestId: requestId(2), runId: "run-2026-08-11" }).ok).toBe(true);
    expect(app.mutate({
      operation: "book", email: "runner@example.org", requestId: requestId(3), runId: "run-2026-08-11",
      groupId: "run-2026-08-11-definition-group-1", runVersion: 2, groupVersion: 1,
    })).toMatchObject({ ok: true, data: { status: "confirmed" } });
    expect(app.state().groups.every((group) => group.capacity === 19)).toBe(true);
  });
  it("does not permit setup import to drop or reassign existing user identities", () => {
    const initial = fixture();
    initial.bookings.push(booking("preserved", "one"));
    const app = harness(initial);
    prepareConfiguration(app);
    const users = app.workbook.getSheetByName("UserSetup")!;
    const one = users.cells.find((row) => row[3] === "one")!;
    users.cells = users.cells.filter((row) => row !== one);
    expect(() => runInContext("configureClubPlatform()", app.context)).toThrow("cannot be dropped");
    expect(app.workbook.backups).toBe(0);
    expect(app.state()).toEqual(initial);
    users.cells.push([...one]);
    users.cells[users.cells.length - 1][0] = "different@example.org";
    expect(() => runInContext("configureClubPlatform()", app.context)).toThrow("cannot be reassigned");
    expect(app.state()).toEqual(initial);
  });
  it("uses version checks and normal cancellation/promotion rules for manually imported member updates", () => {
    const initial = fixture();
    initial.bookings.push(booking("preserved", "one"), booking("queued", "two", "g1", "waitlisted"));
    const app = harness(initial);
    prepareConfiguration(app);
    const row = app.workbook.getSheetByName("UserSetup")!.cells.find((entry) => entry[3] === "one")!;
    row[4] = false;
    row[5] = 0;
    expect(() => runInContext("configureClubPlatform()", app.context)).toThrow("versions");
    expect(app.state()).toEqual(initial);
    row[5] = 2;
    expect(() => runInContext("configureClubPlatform()", app.context)).toThrow("changed");
    expect(app.state()).toEqual(initial);
    row[5] = 1;
    runInContext("configureClubPlatform()", app.context);
    expect(app.workbook.backups).toBe(1);
    expect(app.state().members.find((member) => member.id === "one")).toMatchObject({ active: false, version: 2 });
    expect(app.state().bookings.find((entry) => entry.id === "preserved")?.status).toBe("cancelled");
    expect(app.state().bookings.find((entry) => entry.id === "queued")?.status).toBe("confirmed");
    expect(app.state().audit.some((entry) => entry.action === "configureClubPlatform")).toBe(true);
  });
  it("never treats edits to Users projections as trusted roster setup", () => {
    const initial = fixture();
    const app = harness(initial);
    prepareConfiguration(app);
    const projection = app.workbook.getSheetByName("Users")!.cells.find((row) => row[3] === "one")!;
    projection[0] = "attacker@example.org";
    projection[1] = "Untrusted projection";
    projection[3] = "changed-id";
    runInContext("configureClubPlatform()", app.context);
    expect(app.state().members).toEqual(initial.members);
    expect(app.post({ operation: "snapshot", email: "one@example.org" }).data?.currentMemberId).toBe("one");
    expect(app.post({ operation: "snapshot", email: "attacker@example.org" }).data?.currentMemberId).toBeUndefined();
    expect(app.mutate({
      operation: "updateMember", email: "admin@example.org", memberId: requestId(99),
      name: "Not a trusted import", roles: ["runner"], active: true,
    })).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(app.state().members).toHaveLength(initial.members.length);
  });
});
