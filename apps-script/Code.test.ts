import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { Booking } from "../src/lib/domain";
import type { PlatformSnapshot } from "../src/lib/platform-types";

const now = "2026-08-01T12:00:00.000Z";
class Clock extends Date {
  constructor(value?: string | number | Date) { super(value === undefined ? now : value); }
  static now() { return Date.parse(now); }
}
type Cell = string | number | boolean;
class Sheet {
  cells: Cell[][] = [];
  protected = false;
  hidden = false;
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
      if (this.name === "_PlatformState") this.owner.onCommit?.();
    };
    return {
      getValue: () => getValues()[0][0], getValues,
      setValue: (value: Cell) => setValues([[value]]), setValues,
    };
  }
  getDataRange() { return this.getRange(1, 1, Math.max(this.cells.length, 1), this.getLastColumn()); }
  getLastColumn() { return Math.max(1, ...this.cells.map((row) => row.length)); }
  getMaxRows() { return 1000; }
  getMaxColumns() { return 26; }
  insertRowsAfter() {}
  insertColumnsAfter() {}
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
  getSheetByName(name: string) { return this.sheets.get(name); }
  insertSheet(name: string) {
    if (this.sheets.has(name)) throw new Error("duplicate sheet");
    const sheet = new Sheet(name, this);
    this.sheets.set(name, sheet);
    return sheet;
  }
  getName() { return "Club"; }
  copy() { this.backups++; return { getId: () => "backup-" + this.backups }; }
}
function fixture(): PlatformSnapshot {
  return {
    demo: false,
    config: { location: "DEMO", timeZone: "Europe/London", startTime: "18:30", demoConfiguration: true },
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
  let flushFailure = false;
  let sequence = 0;
  const user = { getEmail: () => "admin@example.org" };
  const context = createContext({
    Date: Clock, Set, JSON, Math, Number, String, Object, Array, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) },
    LockService: { getScriptLock: () => ({
      tryLock: () => { if (locked) return false; locked = true; return true; },
      releaseLock: () => { locked = false; },
    }) },
    Session: { getEffectiveUser: () => user },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (body: string) => ({ body, setMimeType() { return this; } }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => workbook, ProtectionType: { SHEET: "sheet" },
      flush: () => { if (flushFailure) { flushFailure = false; throw new Error("lost response after write"); } },
    },
    Utilities: {
      getUuid: () => "uuid-" + (++sequence),
      formatDate: (date: Date, timeZone: string, pattern: string) => {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone, year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }).formatToParts(date);
        const get = (type: string) => parts.find((part) => part.type === type)!.value;
        const day = `${get("year")}-${get("month")}-${get("day")}`;
        return pattern === "yyyy-MM-dd" ? day : `${day}T${get("hour")}:${get("minute")}:${get("second")}`;
      },
    },
  });
  for (const file of ["Code.gs", "Storage.gs"]) {
    runInContext(readFileSync(new URL(file, import.meta.url), "utf8"), context, { filename: file });
  }
  if (snapshot) workbook.insertSheet("_PlatformState").getRange(1, 1).setValue(JSON.stringify({ schemaVersion: 1, snapshot, receipts: [] }));
  const post = (request: Record<string, unknown>): Reply => {
    context.input = { postData: { contents: JSON.stringify({ secret: "test-gateway", ...request }) } };
    return JSON.parse(runInContext("doPost(input).body", context));
  };
  const state = () => JSON.parse(String(workbook.getSheetByName("_PlatformState")!.getRange(1, 1).getValue())).snapshot as PlatformSnapshot;
  const mutate = (overrides: Record<string, unknown> = {}) => post({
    operation: "book", email: "one@example.org", requestId: requestId(1),
    runId: "run", groupId: "g1", runVersion: 1, groupVersion: 1, memberVersion: 1, ...overrides,
  });
  return {
    workbook, post, state, mutate, context,
    configureSecret: (value: string | null) => { secret = value; },
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
  it("commits despite projection failure and repairs A:J/L:U on the next snapshot", () => {
    const app = harness(fixture());
    app.workbook.rejectProjection = true;
    expect(app.mutate()).toMatchObject({ ok: true, data: { projectionPending: true } });
    expect(app.state().bookings).toHaveLength(1);
    app.workbook.rejectProjection = false;
    expect(app.post({ operation: "snapshot" }).ok).toBe(true);
    const sheet = app.workbook.getSheetByName("Week_run")!;
    expect(sheet.cells[0][0]).toBe("Booking ID");
    expect(sheet.cells[0][11]).toBe("Group ID");
    expect(sheet.cells[1][3]).toBe("one");
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
  it("creates exactly 13 Tuesday groups with DST-aware times and copies routes without assignments", () => {
    const initial = fixture();
    initial.groups[0].routeDescription = "Copied route";
    initial.groups[0].leaderId = "leader";
    initial.bookings.push({ ...booking("lead", "leader"), source: "assignment" });
    const app = harness(initial);
    expect(app.mutate({ operation: "createWeek", email: "admin@example.org", date: "2026-10-27", copyFromRunId: "run" }).ok).toBe(true);
    const state = app.state();
    const week = state.weeks.find((entry) => entry.id === "run-2026-10-27")!;
    expect(week.startsAt).toBe("2026-10-27T18:30:00.000Z");
    expect(week.bookingClosesAt).toBe("2026-10-27T17:30:00.000Z");
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
  it("rejects oversize commits without pruning history and escapes projected formulas", () => {
    const initial = fixture();
    initial.groups.forEach((entry) => entry.routeDescription = "x".repeat(3500));
    const app = harness(initial);
    expect(app.mutate()).toMatchObject({ ok: false, code: "STORAGE_LIMIT" });
    expect(app.state()).toEqual(initial);
    const safe = harness(fixture());
    expect(safe.mutate({ operation: "updateMember", email: "admin@example.org", memberId: "one", name: "=IMPORTXML(\"unsafe\")", roles: ["runner"], active: true }).ok).toBe(true);
    expect(safe.workbook.getSheetByName("Users")?.cells[2][1]).toBe("'=IMPORTXML(\"unsafe\")");
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
    expect(app.workbook.getSheetByName("Week_run")?.cells[1][0]).toBe("preserved");
  });
});
