import { describe, expect, it } from "vitest";
import { clubDate, clubDateTime, createRunSchedule, nextTuesdayDate, updateRunTime } from "./schedule";

describe("club-local Tuesday scheduling", () => {
  it("does not cumulatively shrink published windows when time changes back and forth", () => {
    const config = { location: "Club", timeZone: "Europe/London", startTime: "19:00", demoConfiguration: false };
    const now = new Date("2026-08-01T12:00:00Z");
    const run = { id: "week", status: "published" as const, version: 1, ...createRunSchedule("2026-08-04", now, config) };
    Object.assign(run, updateRunTime(run, "20:00", config, now));
    Object.assign(run, updateRunTime(run, "19:00", config, now));
    expect(run.bookingClosesAt).toBe("2026-08-04T17:30:00.000Z");
    Object.assign(run, updateRunTime(run, "18:00", config, now));
    expect(run.bookingClosesAt).toBe("2026-08-04T16:30:00.000Z");
    Object.assign(run, updateRunTime(run, "20:00", config, now));
    expect(run.bookingClosesAt).toBe("2026-08-04T16:30:00.000Z");
    expect(() => updateRunTime({ ...run, status: "draft" }, "00:05", config, now)).toThrow("valid booking window");
  });
  it("uses London daylight saving, including both transition weeks", () => {
    expect(clubDateTime("2026-03-24", "18:30")).toBe("2026-03-24T18:30:00.000Z");
    expect(clubDateTime("2026-03-31", "18:30")).toBe("2026-03-31T17:30:00.000Z");
    expect(clubDateTime("2026-10-20", "17:30")).toBe("2026-10-20T16:30:00.000Z");
    expect(clubDateTime("2026-10-27", "17:30")).toBe("2026-10-27T17:30:00.000Z");
  });
  it("rolls over at the local cutoff, not at UTC midnight", () => {
    expect(nextTuesdayDate(new Date("2026-08-11T17:29:59Z"))).toBe("2026-08-11");
    expect(nextTuesdayDate(new Date("2026-08-11T17:30:00Z"))).toBe("2026-08-18");
    expect(clubDate(new Date("2026-08-10T23:30:00Z"))).toBe("2026-08-11");
  });
  it("opens creation immediately and rejects invalid/non-Tuesday dates", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    expect(createRunSchedule("2026-08-11", now)).toEqual({
      startsAt: "2026-08-11T18:00:00.000Z",
      bookingOpensAt: now.toISOString(),
      bookingClosesAt: "2026-08-11T17:30:00.000Z",
    });
    expect(() => createRunSchedule("2026-08-12", now)).toThrow("Tuesday");
    expect(() => createRunSchedule("2026-02-30", now)).toThrow("Invalid");
    expect(() => createRunSchedule("2026-08-11", new Date("2026-08-11T17:30:00Z"))).toThrow("future");
  });
});
