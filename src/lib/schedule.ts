import type { Run } from "./domain";
import type { ClubConfig, PlatformSnapshot } from "./platform-types";

/** Replace these explicitly labelled demo settings with the club's agreed values. */
export const DEMO_CLUB_CONFIG: ClubConfig = {
  location: "DEMO — confirm the club meeting location",
  timeZone: "Europe/London",
  startTime: "19:00",
  demoConfiguration: true,
};

export const GROUP_COUNT = 13;
export const GROUP_CAPACITY = 19;
export const MAX_GROUP_COUNT = 20;
export const MAX_GROUP_CAPACITY = 20;
export const BOOKING_CUTOFF = "18:30";
export const DEMO_DISTANCE_LABEL = "DEMO — distance to be confirmed";

export function clubDate(now: Date = new Date(), timeZone = "Europe/London"): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Resolves a club-local wall time without depending on the server's time zone. */
export function clubDateTime(date: string, time: string, timeZone = "Europe/London"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Use YYYY-MM-DD and HH:mm.");
  }
  const target = new Date(`${date}T${time}:00Z`);
  if (!Number.isFinite(target.getTime()) || target.toISOString().slice(0, 10) !== date ||
      Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) {
    throw new Error("Invalid club date or time.");
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  let instant = target.getTime();
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = formatter.formatToParts(new Date(instant));
    const value = (type: string) => parts.find((part) => part.type === type)!.value;
    const wall = Date.parse(`${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}Z`);
    const correction = target.getTime() - wall;
    if (correction === 0) return new Date(instant).toISOString();
    instant += correction;
  }
  throw new Error("This club-local time does not exist.");
}

export function nextTuesdayDate(now: Date = new Date(), timeZone = "Europe/London"): string {
  const today = new Date(`${clubDate(now, timeZone)}T12:00:00Z`);
  const days = (2 - today.getUTCDay() + 7) % 7;
  today.setUTCDate(today.getUTCDate() + days);
  const date = today.toISOString().slice(0, 10);
  if (days === 0 && now >= new Date(clubDateTime(date, BOOKING_CUTOFF, timeZone))) {
    today.setUTCDate(today.getUTCDate() + 7);
  }
  return today.toISOString().slice(0, 10);
}

export function createRunSchedule(
  date: string, now: Date = new Date(), config: ClubConfig = DEMO_CLUB_CONFIG,
): Pick<Run, "startsAt" | "bookingOpensAt" | "bookingClosesAt"> {
  const startsAt = clubDateTime(date, config.startTime, config.timeZone);
  if (new Date(`${date}T12:00:00Z`).getUTCDay() !== 2) throw new Error("Club runs must be on Tuesday.");
  const bookingClosesAt = clubDateTime(date, BOOKING_CUTOFF, config.timeZone);
  if (new Date(bookingClosesAt) <= now || new Date(startsAt) <= new Date(bookingClosesAt)) {
    throw new Error("Choose a future Tuesday with a start after the booking cutoff.");
  }
  return { startsAt, bookingOpensAt: now.toISOString(), bookingClosesAt };
}

export function sundayPublicationAt(run: Run, config: ClubConfig): string {
  const date = new Date(`${clubDate(new Date(run.startsAt), config.timeZone)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 2);
  return clubDateTime(date.toISOString().slice(0, 10), config.weeklyPublishTime ?? "18:00", config.timeZone);
}

export function publicationBlockers(snapshot: PlatformSnapshot, run: Run, now: Date): string[] {
  const blockers = snapshot.groups.filter(group => group.runId === run.id && !group.cancelled)
    .filter(group => !snapshot.members.some(member => member.id === group.leaderId && member.active && member.roles.includes("leader")))
    .map(group => `Group ${group.number} needs an eligible leader`);
  if (snapshot.weeks.some(week => week.id !== run.id && week.status === "published" && Date.parse(week.startsAt) > now.getTime())) {
    blockers.push("Another future week is published");
  }
  if (Date.parse(run.bookingClosesAt) <= now.getTime()) blockers.push("Booking window has closed");
  return blockers;
}

export function updateRunTime(run: Run, startTime: string, config: ClubConfig, now: Date) {
  if (!["draft", "published"].includes(run.status) || Date.parse(run.startsAt) <= now.getTime()) throw new Error("Only future draft or published weeks can change time.");
  const date = clubDate(new Date(run.startsAt), config.timeZone);
  const startsAt = clubDateTime(date, startTime, config.timeZone);
  const lead = Date.parse(run.startsAt) - Date.parse(run.bookingClosesAt);
  const proposedClose = Date.parse(startsAt) - (run.status === "published" ? 30 * 60 * 1000 : lead);
  const close = run.status === "published" ? Math.min(Date.parse(run.bookingClosesAt), proposedClose) : proposedClose;
  if (!(lead > 0) || Date.parse(startsAt) <= now.getTime() || close <= Date.parse(run.bookingOpensAt) || close >= Date.parse(startsAt) ||
      clubDate(new Date(close), config.timeZone) !== date ||
      (Date.parse(run.bookingClosesAt) <= now.getTime() && close > now.getTime()) || (run.status === "draft" && close <= now.getTime())) {
    throw new Error("Choose a future start with a valid booking window; closed bookings cannot reopen.");
  }
  return { startsAt, bookingClosesAt: new Date(close).toISOString() };
}
