/**
 * _PlatformState!A1 is the ONLY writable domain source. One setValue commits
 * the entire candidate, audit and request receipts atomically. Readable sheets
 * are protected projections, repaired on every locked request after crashes.
 * Sheets cells have a 50,000-character limit: reject before 45,000 characters
 * (including history/receipts); nothing is silently pruned. This foundation is
 * for small pilots. Move to a transactional database before hitting this cap.
 *
 * Users: Email,Name,Role,User ID,Active,Version.
 * Groups: Group,Distance,Pace,Capacity,Group ID (exactly 13 master definitions).
 * Canonical groupDefinitions on _PlatformState is the authoritative template;
 * owner edits on protected Groups are STAGED, applied only by the backed-up
 * manual confirmClubConfiguration(). Reads/repairs discard unconfirmed edits.
 * createWeek copies definitions, never last week's demographics/capacity.
 * Weeks: Week ID,Date,Starts At,Booking Opens At,Booking Closes At,Status,
 *        Version,Cancellation Reason,Sheet.
 * Week_<runId> A:J: Booking ID,Week ID,Group ID,User ID,Name,Status,Source,
 *                  Booked At,Version,Email.
 * Week_<runId> L:U: Group ID,Group,Distance,Pace,Capacity,Leader ID,Sweeper ID,
 *                  Route,Route Needs Review,Version. Column K is always blank.
 * Attendance/Audit are protected projections; legacy Archives is preserved.
 * Manual worksheet edits never override the canonical committed state.
 */
const PLATFORM_CONFIG = {
  location: "DEMO — confirm the club meeting location",
  timeZone: "Europe/London",
  startTime: "18:30",
  demoConfiguration: true,
};
const PLATFORM_STATE_SHEET = "_PlatformState";
const PLATFORM_STATE_LIMIT = 45000;

function loadPlatformState_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(PLATFORM_STATE_SHEET);
  const raw = sheet && sheet.getRange(1, 1).getValue();
  if (!raw) return { schemaVersion: 0, snapshot: legacySnapshot_(), receipts: [] };
  let state;
  try { state = JSON.parse(raw); } catch (_) { fail_("STATE_CORRUPT", "The canonical state is invalid. Restore the administrator's backup."); }
  if (state.schemaVersion !== 1 || !state.snapshot || !Array.isArray(state.receipts)) fail_("STATE_CORRUPT", "Unsupported canonical state.");
  if (!state.groupDefinitions) state.groupDefinitions = defaultGroupDefinitions_();
  validateGroupDefinitions_(state.groupDefinitions);
  validatePlatform_(state.snapshot);
  return state;
}

function commitPlatformState_(state) {
  const json = JSON.stringify(state);
  if (json.length > PLATFORM_STATE_LIMIT) fail_("STORAGE_LIMIT", "The pilot workbook is at its safe storage limit. No changes were committed; migrate to a larger transactional store.");
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(PLATFORM_STATE_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(PLATFORM_STATE_SHEET);
    protectPlatformSheet_(sheet);
    sheet.hideSheet();
  }
  sheet.getRange(1, 1).setValue(json);
  SpreadsheetApp.flush();
}

/** Run manually as an editor, never through the HTTP dispatcher. */
function initializeClubPlatform() {
  return withLock_(() => {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (spreadsheet.getSheetByName(PLATFORM_STATE_SHEET) &&
        spreadsheet.getSheetByName(PLATFORM_STATE_SHEET).getRange(1, 1).getValue()) {
      repairProjections_(loadPlatformState_());
      return;
    }
    if (records_("Members").length || records_("Runs").length || records_("Bookings").length ||
        records_("Groups").length || records_("Users").length || records_("Weeks").length ||
        records_("Archives").length) {
      fail_("MIGRATION_REQUIRED", "Existing data detected. Use the backed-up legacy migration instead.");
    }
    const email = normalizeEmail_(Session.getEffectiveUser().getEmail());
    if (!email) fail_("FORBIDDEN", "Run initialization as an identified spreadsheet administrator.");
    const snapshot = emptySnapshot_();
    snapshot.members.push({ id: Utilities.getUuid(), email, name: "Club administrator", roles: ["admin", "runner"], active: true, version: 1 });
    commitPlatformState_({ schemaVersion: 1, snapshot, receipts: [], groupDefinitions: defaultGroupDefinitions_() });
    repairProjections_(loadPlatformState_());
  });
}

/**
 * Manual, non-destructive, repeat-safe migration: workbook copy is completed
 * BEFORE the canonical commit. Legacy rows/IDs/history remain, protected.
 * Overfull/invalid legacy data fails before committing; resolve in a backup
 * copy and review rather than dropping runners or inventing assignments.
 */
function migrateLegacyPlatform() {
  return withLock_(() => {
    const existing = loadPlatformState_();
    if (existing.schemaVersion === 1) { repairProjections_(existing); return; }
    const email = normalizeEmail_(Session.getEffectiveUser().getEmail());
    const admin = existing.snapshot.members.find((entry) => entry.email === email && entry.active && entry.roles.includes("admin"));
    if (!admin) fail_("FORBIDDEN", "Run migration as an active legacy administrator.");
    validatePlatform_(existing.snapshot);
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const backup = spreadsheet.copy(spreadsheet.getName() + " — pre-platform backup " + new Date().toISOString());
    if (!backup || !backup.getId()) fail_("BACKUP_FAILED", "A verified backup copy is required before migration.");
    const state = {
      schemaVersion: 1, snapshot: existing.snapshot, receipts: [], groupDefinitions: defaultGroupDefinitions_(),
      migration: { backupId: backup.getId(), at: new Date().toISOString(), actorId: admin.id },
    };
    ["Members", "Runs", "Groups", "Bookings", "Archives"].forEach((name) => {
      const sheet = spreadsheet.getSheetByName(name);
      if (sheet) protectPlatformSheet_(sheet);
    });
    commitPlatformState_(state);
    repairProjections_(state);
  });
}

/**
 * Owner-only setup, never dispatched via HTTP. Edit PLATFORM_CONFIG in this
 * script and the protected Groups master rows, then run this manually. Copy
 * existing state before importing. Week history/IDs are never rewritten.
 */
function confirmClubConfiguration() {
  return withLock_(() => {
    const state = loadPlatformState_();
    if (state.schemaVersion !== 1) fail_("MIGRATION_REQUIRED", "Initialize or migrate the workbook first.");
    const email = normalizeEmail_(Session.getEffectiveUser().getEmail());
    const admin = state.snapshot.members.find((entry) => entry.email === email && entry.active && entry.roles.includes("admin"));
    if (!admin) fail_("FORBIDDEN", "An active administrator must confirm club configuration.");
    const definitions = records_("Groups").map((entry) => ({
      id: String(entry["Group ID"] || ""), number: Number(entry.Group),
      name: "Group " + entry.Group, distanceLabel: String(entry.Distance || ""),
      paceLabel: String(entry.Pace || ""), capacity: Number(entry.Capacity),
    }));
    validateGroupDefinitions_(definitions);
    if (definitions.some((entry) => /\bDEMO\b/i.test(entry.distanceLabel + " " + entry.paceLabel)) ||
        !PLATFORM_CONFIG.location.trim() || /\bDEMO\b/i.test(PLATFORM_CONFIG.location) ||
        PLATFORM_CONFIG.timeZone !== "Europe/London" || PLATFORM_CONFIG.startTime !== "18:30") {
      fail_("UNCONFIRMED_CONFIGURATION", "Confirm the real meeting location, thirteen distance/pace definitions, Europe/London and 18:30 before applying configuration.");
    }
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const backup = spreadsheet.copy(spreadsheet.getName() + " — pre-configuration backup " + new Date().toISOString());
    if (!backup || !backup.getId()) fail_("BACKUP_FAILED", "A verified backup copy is required.");
    state.groupDefinitions = definitions;
    state.snapshot.config = Object.assign({}, PLATFORM_CONFIG, { demoConfiguration: false });
    state.configuration = { backupId: backup.getId(), at: new Date().toISOString(), actorId: admin.id };
    state.snapshot.audit.push({
      id: Utilities.getUuid(), runId: "", actorId: admin.id, action: "confirmClubConfiguration",
      at: new Date().toISOString(), requestId: Utilities.getUuid(),
    });
    commitPlatformState_(state);
    repairProjections_(state);
  });
}
function defaultGroupDefinitions_() {
  return Array.from({ length: 13 }, (_, index) => ({
    id: "definition-group-" + (index + 1), number: index + 1, name: "Group " + (index + 1),
    distanceLabel: "DEMO — distance to be confirmed", paceLabel: "DEMO — pace to be confirmed", capacity: 19,
  }));
}
function validateGroupDefinitions_(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== 13 ||
      new Set(definitions.map((entry) => entry.id)).size !== 13 ||
      new Set(definitions.map((entry) => entry.number)).size !== 13 ||
      definitions.some((entry) => !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) ||
        !Number.isInteger(entry.number) || entry.number < 1 || entry.number > 13 ||
        entry.capacity !== 19 || typeof entry.distanceLabel !== "string" || !entry.distanceLabel.trim() ||
        typeof entry.paceLabel !== "string" || !entry.paceLabel.trim())) {
    fail_("INVALID_GROUP_DEFINITIONS", "Supply exactly thirteen stable group IDs, numbered 1–13, with confirmed distance/pace labels and fixed capacity 19.");
  }
}

function emptySnapshot_() {
  return { weeks: [], groups: [], bookings: [], members: [], attendance: [], audit: [], config: Object.assign({}, PLATFORM_CONFIG), demo: false };
}
function legacySnapshot_() {
  const snapshot = emptySnapshot_();
  snapshot.members = records_("Members").map((entry) => ({
    id: String(entry.memberId), email: normalizeEmail_(entry.email), name: String(entry.displayName || entry.name || ""),
    roles: String(entry.roles || "").split(",").map((role) => role.trim()).filter(Boolean),
    active: String(entry.active).toUpperCase() === "TRUE", version: Number(entry.version || 1),
  }));
  snapshot.weeks = records_("Runs").map((entry) => ({
    id: String(entry.runId), startsAt: isoValue_(entry.startsAt), bookingOpensAt: isoValue_(entry.bookingOpensAt),
    bookingClosesAt: isoValue_(entry.bookingClosesAt), status: String(entry.status), version: Number(entry.version || 1),
    ...(entry.cancellationReason ? { cancellationReason: String(entry.cancellationReason) } : {}),
  }));
  const legacyGroups = records_("Legacy_Groups").length ? records_("Legacy_Groups") : records_("Groups");
  snapshot.groups = legacyGroups.map((entry) => ({
    id: String(entry.groupId), runId: String(entry.runId), number: Number(entry.groupNumber),
    paceLabel: String(entry.paceLabel || "DEMO — pace to be confirmed"),
    distanceLabel: String(entry.distanceLabel || "DEMO — distance to be confirmed"),
    name: String(entry.name || "Group " + entry.groupNumber),
    capacity: Math.min(19, Number(entry.capacity)), version: Number(entry.version || 1),
    ...(entry.leaderId ? { leaderId: String(entry.leaderId) } : {}),
    ...(entry.sweeperId ? { sweeperId: String(entry.sweeperId) } : {}),
    routeDescription: String(entry.routeDescription || ""), routeNeedsReview: !!entry.routeDescription,
  }));
  snapshot.bookings = records_("Bookings").map((entry) => ({
    id: String(entry.bookingId), runId: String(entry.runId), groupId: String(entry.groupId), memberId: String(entry.memberId),
    status: String(entry.status), source: entry.bookingSource === "assignment" ? "assignment" : "member",
    bookedAt: isoValue_(entry.bookedAt), version: Number(entry.version || 1),
  }));
  snapshot.attendance = records_("Attendance").map((entry) => ({
    id: String(entry.id || entry["Attendance ID"]), runId: String(entry.runId || entry["Week ID"]),
    groupId: String(entry.groupId || entry["Group ID"]), memberId: String(entry.memberId || entry["User ID"]),
    outcome: String(entry.outcome || entry.Outcome), recordedAt: isoValue_(entry.recordedAt || entry["Recorded At"]),
  }));
  return snapshot;
}
function isoValue_(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail_("INVALID_LEGACY_DATA", "A legacy timestamp is invalid.");
  return date.toISOString();
}

function validatePlatform_(snapshot) {
  const unique = (entries, label) => {
    const ids = new Set();
    entries.forEach((entry) => {
      if (!entry.id || ids.has(entry.id)) fail_("INVALID_DATA", "Missing or duplicate " + label + " ID.");
      ids.add(entry.id);
    });
    return ids;
  };
  const members = unique(snapshot.members, "member");
  const weeks = unique(snapshot.weeks, "week");
  const groups = unique(snapshot.groups, "group");
  unique(snapshot.bookings, "booking");
  unique(snapshot.attendance, "attendance");
  unique(snapshot.audit, "audit");
  const emails = new Set();
  snapshot.members.forEach((entry) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email) || entry.email !== normalizeEmail_(entry.email) ||
        emails.has(entry.email) || typeof entry.name !== "string" || !entry.name.trim() ||
        !Array.isArray(entry.roles) || !entry.roles.length ||
        entry.roles.some((role) => !["runner", "leader", "sweeper", "admin"].includes(role)) || typeof entry.active !== "boolean" ||
        !Number.isInteger(entry.version) || entry.version < 1) fail_("INVALID_DATA", "Invalid or duplicate member details.");
    emails.add(entry.email);
  });
  snapshot.weeks.forEach((week) => {
    if (!["draft", "published", "cancelled", "archived"].includes(week.status) ||
        ![week.startsAt, week.bookingOpensAt, week.bookingClosesAt].every((value) => Number.isFinite(new Date(value).getTime())) ||
        !Number.isInteger(week.version) || week.version < 1) fail_("INVALID_DATA", "Invalid week details.");
    const weekGroups = snapshot.groups.filter((group) => group.runId === week.id);
    if (!["archived", "cancelled"].includes(week.status) &&
        (weekGroups.length !== 13 || new Set(weekGroups.map((group) => group.number)).size !== 13 ||
         weekGroups.some((group) => !Number.isInteger(group.number) || group.number < 1 || group.number > 13))) fail_("INVALID_GROUPS", "Every live week must have exactly thirteen numbered groups.");
  });
  if (snapshot.weeks.filter((week) => week.status === "published" && new Date(week.startsAt) > new Date()).length > 1) {
    fail_("PUBLISHED_RUN_EXISTS", "Only one future run can be published.");
  }
  const assignments = new Set();
  snapshot.groups.forEach((group) => {
    if (!weeks.has(group.runId) || !Number.isInteger(group.capacity) || group.capacity < 1 || group.capacity > 19 ||
        !Number.isInteger(group.number) || group.number < 1 || group.number > 13 ||
        typeof group.paceLabel !== "string" || !group.paceLabel.trim() ||
        !Number.isInteger(group.version) || group.version < 1) fail_("INVALID_GROUPS", "Invalid group capacity or version.");
    const week = snapshot.weeks.find((entry) => entry.id === group.runId);
    const live = !["archived", "cancelled"].includes(week.status);
    if (live && occupantCount_(snapshot, group) > group.capacity) fail_("GROUP_FULL", "Existing occupants exceed the nineteen-person maximum; reconcile legacy data before migration.");
    ["leader", "sweeper"].forEach((role) => {
      const id = group[role + "Id"];
      if (!id) return;
      const member = snapshot.members.find((entry) => entry.id === id);
      if (!member || (live && new Date(week.startsAt) > new Date() && (!member.active || !member.roles.includes(role)))) fail_("INVALID_ASSIGNMENT", "An assignment is not eligible.");
      const key = group.runId + ":" + id;
      if (assignments.has(key) && group.leaderId !== group.sweeperId) fail_("INVALID_ASSIGNMENT", "A member is assigned to more than one group.");
      if (snapshot.groups.some((entry) => entry.runId === group.runId && entry.id !== group.id && [entry.leaderId, entry.sweeperId].includes(id))) fail_("INVALID_ASSIGNMENT", "A member is assigned to more than one group.");
      assignments.add(key);
    });
  });
  const active = new Set();
  snapshot.bookings.forEach((booking) => {
    const group = snapshot.groups.find((entry) => entry.id === booking.groupId);
    if (!groups.has(booking.groupId) || !members.has(booking.memberId) || !weeks.has(booking.runId) || group.runId !== booking.runId ||
        !["confirmed", "waitlisted", "cancelled"].includes(booking.status) || !["member", "assignment"].includes(booking.source) ||
        !Number.isInteger(booking.version) || booking.version < 1 || !Number.isFinite(new Date(booking.bookedAt).getTime())) fail_("INVALID_DATA", "Invalid booking details.");
    if (booking.status !== "cancelled") {
      const key = booking.runId + ":" + booking.memberId;
      if (active.has(key)) fail_("DUPLICATE_BOOKING", "A member has multiple active bookings in a week.");
      active.add(key);
      if (snapshot.groups.some((entry) => entry.runId === booking.runId && entry.id !== booking.groupId && [entry.leaderId, entry.sweeperId].includes(booking.memberId))) fail_("DUPLICATE_BOOKING", "An assignment conflicts with a booking.");
    }
  });
  snapshot.attendance.forEach((entry) => {
    const group = snapshot.groups.find((candidate) => candidate.id === entry.groupId);
    if (!group || group.runId !== entry.runId || !members.has(entry.memberId) ||
        !["present", "absent"].includes(entry.outcome) || !Number.isFinite(new Date(entry.recordedAt).getTime())) fail_("INVALID_DATA", "Invalid attendance details.");
  });
}

function repairProjections_(state) {
  try {
    projectPlatform_(state);
    return true;
  } catch (_) {
    // Canonical state is already committed. Never report a failed mutation or
    // roll it back because a disposable projection could not be regenerated.
    return false;
  }
}
function projectPlatform_(state) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const snapshot = state.snapshot;
  const legacyGroups = spreadsheet.getSheetByName("Groups");
  if (legacyGroups && legacyGroups.getRange(1, 1, 1, legacyGroups.getLastColumn()).getValues()[0].includes("groupId")) {
    if (spreadsheet.getSheetByName("Legacy_Groups")) fail_("MIGRATION_CONFLICT", "Two legacy Groups sheets need administrator review.");
    legacyGroups.setName("Legacy_Groups");
  }
  ["Members", "Runs", "Bookings", "Archives", "Legacy_Groups"].forEach((name) => {
    const sheet = spreadsheet.getSheetByName(name);
    if (sheet) protectPlatformSheet_(sheet);
  });
  writeProjection_("Users", ["Email", "Name", "Role", "User ID", "Active", "Version"],
    snapshot.members.map((entry) => [entry.email, entry.name, entry.roles.join(","), entry.id, entry.active, entry.version]));
  writeProjection_("Weeks", ["Week ID", "Date", "Starts At", "Booking Opens At", "Booking Closes At", "Status", "Version", "Cancellation Reason", "Sheet"],
    snapshot.weeks.map((entry) => [entry.id, clubLocalDate_(new Date(entry.startsAt), snapshot.config.timeZone), entry.startsAt, entry.bookingOpensAt, entry.bookingClosesAt, entry.status, entry.version, entry.cancellationReason || "", weeklySheetName_(entry.id)]));
  writeProjection_("Groups", ["Group", "Distance", "Pace", "Capacity", "Group ID"],
    state.groupDefinitions.map((entry) => [entry.number, entry.distanceLabel, entry.paceLabel, 19, entry.id]));
  snapshot.weeks.forEach((week) => {
    const bookings = snapshot.bookings.filter((entry) => entry.runId === week.id).map((entry) => {
      const member = snapshot.members.find((candidate) => candidate.id === entry.memberId);
      return [entry.id, entry.runId, entry.groupId, entry.memberId, member ? member.name : "", entry.status, entry.source, entry.bookedAt, entry.version, member ? member.email : ""];
    });
    const groups = snapshot.groups.filter((entry) => entry.runId === week.id).sort((a, b) => a.number - b.number)
      .map((entry) => [entry.id, entry.number, entry.distanceLabel || "", entry.paceLabel, entry.capacity, entry.leaderId || "", entry.sweeperId || "", entry.routeDescription || "", !!entry.routeNeedsReview, entry.version]);
    const sheet = writeProjection_(weeklySheetName_(week.id),
      ["Booking ID", "Week ID", "Group ID", "User ID", "Name", "Status", "Source", "Booked At", "Version", "Email"], bookings);
    setProjectionValues_(sheet, 1, 12, [["Group ID", "Group", "Distance", "Pace", "Capacity", "Leader ID", "Sweeper ID", "Route", "Route Needs Review", "Version"]].concat(groups));
  });
  writeProjection_("Attendance", ["Attendance ID", "Week ID", "Group ID", "User ID", "Outcome", "Recorded At"],
    snapshot.attendance.map((entry) => [entry.id, entry.runId, entry.groupId, entry.memberId, entry.outcome, entry.recordedAt]));
  writeProjection_("Audit", ["Audit ID", "Week ID", "Group ID", "User ID", "Actor ID", "Action", "At", "Request ID", "Queue Size"],
    snapshot.audit.map((entry) => [entry.id, entry.runId, entry.groupId || "", entry.memberId || "", entry.actorId, entry.action, entry.at, entry.requestId, entry.queueSize === undefined ? "" : entry.queueSize]));
  SpreadsheetApp.flush();
}
function writeProjection_(name, headers, rows) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  protectPlatformSheet_(sheet);
  sheet.clearContents();
  setProjectionValues_(sheet, 1, 1, [headers].concat(rows));
  sheet.setFrozenRows(1);
  return sheet;
}
function setProjectionValues_(sheet, row, column, values) {
  const width = values[0].length;
  if (sheet.getMaxRows() < row + values.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), row + values.length - 1 - sheet.getMaxRows());
  if (sheet.getMaxColumns() < column + width - 1) sheet.insertColumnsAfter(sheet.getMaxColumns(), column + width - 1 - sheet.getMaxColumns());
  // User-controlled strings must remain text, never executable sheet formulas.
  const safe = values.map((cells) => cells.map((value) => typeof value === "string" && /^[=+\-@]/.test(value) ? "'" + value : value));
  sheet.getRange(row, column, values.length, width).setValues(safe);
}
function protectPlatformSheet_(sheet) {
  let protection = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).find((entry) => entry.getDescription() === "Platform managed — edit through the application");
  if (!protection) protection = sheet.protect().setDescription("Platform managed — edit through the application");
  protection.setWarningOnly(false);
  const owner = Session.getEffectiveUser();
  protection.addEditor(owner);
  const ownerEmail = normalizeEmail_(owner.getEmail());
  const editors = protection.getEditors().filter((editor) => normalizeEmail_(editor.getEmail()) !== ownerEmail);
  if (editors.length) protection.removeEditors(editors);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}
function weeklySheetName_(runId) {
  return "Week_" + String(runId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
function records_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift() || [];
  return values.map((row, index) => ({ row, index })).filter((entry) => entry.row.some((value) => value !== ""))
    .map((entry) => {
      const record = { _sheet: sheet, _row: entry.index + 2 };
      headers.forEach((header, column) => record[header] = entry.row[column]);
      return record;
    });
}
function findOne_(sheetName, field, value) {
  return records_(sheetName).find((record) => String(record[field]) === String(value));
}
function clubLocalDate_(date, timeZone) { return Utilities.formatDate(date, timeZone, "yyyy-MM-dd"); }
function clubInstant_(date, time, timeZone) {
  const target = Date.parse(date + "T" + time + ":00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !Number.isFinite(target) ||
      new Date(target).toISOString().slice(0, 10) !== date || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) fail_("INVALID_DATE", "Supply a real YYYY-MM-DD date and HH:mm time.");
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wall = Date.parse(Utilities.formatDate(new Date(instant), timeZone, "yyyy-MM-dd'T'HH:mm:ss") + "Z");
    const correction = target - wall;
    if (!correction) return new Date(instant).toISOString();
    instant += correction;
  }
  fail_("INVALID_DATE", "This club-local time does not exist.");
}
function platformSchedule_(date, config, now) {
  const startsAt = clubInstant_(date, config.startTime, config.timeZone);
  const bookingClosesAt = clubInstant_(date, "17:30", config.timeZone);
  if (new Date(date + "T12:00:00Z").getUTCDay() !== 2 || new Date(bookingClosesAt) <= now || new Date(startsAt) <= new Date(bookingClosesAt)) fail_("INVALID_DATE", "Choose a future Tuesday with a start after the 17:30 club-local cutoff.");
  return { startsAt, bookingOpensAt: now.toISOString(), bookingClosesAt };
}
