/**
 * _PlatformState!A:A is the ONLY writable domain source. A1 is the JSON manifest
 * {schemaVersion:1,storageFormat:"chunked-v1",revision,chunkCount,length,sha256,
 *  chunkPrefix:"data:"}.
 * A2 onward contains <=40,000-character cells prefixed "data:" so a chunk can
 * never execute a formula. Strip the five-character prefix; JSON text chunks
 * never split a Unicode surrogate pair. Validate UTF-16 length and SHA-256 of the reassembled UTF-8
 * text before parsing {schemaVersion,revision,snapshot,groupDefinitions,receipts}.
 * ONE range.setValues writes manifest, chunks and blank padding clearing older
 * trailing chunks together. B1 is a disposable projection recovery checkpoint.
 * Readable sheets
 * are protected projections, repaired on every locked request after crashes.
 * No per-snapshot 50K cap and nothing is pruned. Only the workbook's 10-million
 * cell grid ceiling is checked before expanding the canonical range. Large
 * clubs must still consider Apps Script execution/memory quotas and projection
 * costs; move to a transactional database before those become operational limits.
 *
 * Users: Email,Name,Role,User ID,Active,Version.
 * Groups: Group,Distance,Pace,Capacity,Group ID (1–20 master definitions).
 * Owner setup staging projections: UserSetup has the same six Users headers;
 * GroupDefinitions has the same five Groups headers;
 * ClubConfiguration: Setting,Value (Location,Time Zone,Start Time,Demo Configuration).
 * configureClubPlatform() explicitly imports UserSetup/GroupDefinitions/config only
 * under lock after validation and backup. Existing IDs/history cannot be dropped.
 * Canonical groupDefinitions on _PlatformState is the authoritative template;
 * owner edits on protected Groups are STAGED, applied only by the backed-up
 * manual confirmClubConfiguration(). Stage during a quiet maintenance window:
 * the next mutation/recovery may regenerate and discard unconfirmed edits.
 * createWeek copies definitions, never last week's demographics/capacity.
 * Weeks: Week ID,Date,Starts At,Booking Opens At,Booking Closes At,Status,
 *        Version,Cancellation Reason,Sheet.
 * Week_<runId> A:J: Group,Runner,Status,Booking Time,Booking ID,Week ID,
 *                  Group ID,User ID,Source,Version.
 * Week_<runId> L:Z: Group,Leader,Sweeper,Route Description,Distance,Pace,Capacity,
 *                  Group ID,Week ID,Leader ID,Sweeper ID,Route Needs Review,
 *                  Version,Confirmed,Waitlisted. Column K is always blank.
 * Names lead the readable tables; stable IDs/version metadata support them.
 * Attendance/Audit are protected projections; legacy Archives is preserved.
 * Manual worksheet edits never override the canonical committed state.
 */
const PLATFORM_CONFIG = {
  location: "Willett Recreation Ground", // or "Norman Park (Track Side)"
  timeZone: "Europe/London",
  startTime: "19:00",
  demoConfiguration: false,
};
const PLATFORM_BOOKING_CUTOFF = "18:30";
const DEFAULT_CLUB_LOCATIONS = [
  "Willett Recreation Ground",
  "Norman Park (Track Side)",
];
const DEFAULT_CLUB_LOCATION_MAPS = {
  "Willett Recreation Ground": "https://www.google.com/maps/place/Willett+Recreation+Ground/@51.3928404,0.0731925,581m/data=!3m2!1e3!4b1!4m6!3m5!1s0x47d8ab9c1fc4d937:0x36b9ea1a882bd93c!8m2!3d51.3928405!4d0.0780634!16s%2Fg%2F1jkvjm9kp?entry=ttu&g_ep=EgoyMDI2MDkzMC4wIKXMDSoASAFQAw%3D%3D",
  "Norman Park (Track Side)": "https://www.google.com/maps/place/Norman+Park+(Hayes)+Recycling+Site/@51.3875908,0.0159645,581m/data=!3m1!1e3!4m9!1m2!2m1!1snorman+park!3m5!1s0x47d8aa8a1fd2fbf5:0x8b2404213a74d0a9!8m2!3d51.3875917!4d0.0207297!16s%2Fg%2F1jkvlxf_p?entry=ttu&g_ep=EgoyMDI2MDkzMC4wIKXMDSoASAFQAw%3D%3D",
};
const PLATFORM_STATE_SHEET = "_PlatformState";
const PLATFORM_CHUNK_SIZE = 39995;
const PLATFORM_CHUNK_PREFIX = "data:";
const PLATFORM_GRID_LIMIT = 10000000;

function loadPlatformState_() {
  const spreadsheet = platformSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(PLATFORM_STATE_SHEET);
  const raw = sheet && sheet.getRange(1, 1).getValue();
  if (!raw) {
    if (sheet && (sheet.getLastRow() > 1 || sheet.getRange(1, 2).getValue() !== "")) {
      fail_("STATE_CORRUPT", "The canonical manifest is missing. Restore the administrator's backup.");
    }
    return { schemaVersion: 0, snapshot: legacySnapshot_(), receipts: [] };
  }
  let state;
  try { state = JSON.parse(raw); } catch (_) { fail_("STATE_CORRUPT", "The canonical state is invalid. Restore the administrator's backup."); }
  if (state.storageFormat === "chunked-v1") {
    const manifest = state;
    if (!Number.isInteger(manifest.chunkCount) || manifest.chunkCount < 1 ||
        manifest.chunkCount + 1 > sheet.getMaxRows() || !Number.isInteger(manifest.length) || manifest.length < 1 ||
        typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) fail_("STATE_CORRUPT", "Invalid canonical manifest.");
    const prefix = manifest.chunkPrefix === undefined ? "" : manifest.chunkPrefix;
    if (prefix !== "" && prefix !== PLATFORM_CHUNK_PREFIX) fail_("STATE_CORRUPT", "Unsupported canonical chunk prefix.");
    const chunks = sheet.getRange(2, 1, manifest.chunkCount, 1).getValues().map((row) => row[0]);
    if (chunks.some((chunk) => typeof chunk !== "string" || chunk.length <= prefix.length ||
        chunk.length > 40000 || !chunk.startsWith(prefix))) fail_("STATE_CORRUPT", "Invalid canonical chunks.");
    const json = chunks.map((chunk) => chunk.slice(prefix.length)).join("");
    if (json.length !== manifest.length || platformDigest_(json) !== manifest.sha256) fail_("STATE_CORRUPT", "Canonical integrity check failed. Restore the administrator's backup.");
    try { state = JSON.parse(json); } catch (_) { fail_("STATE_CORRUPT", "Invalid canonical JSON."); }
    if (state.revision !== manifest.revision || manifest.schemaVersion !== 1) fail_("STATE_CORRUPT", "Canonical revision mismatch.");
  } else if (state.storageFormat) fail_("STATE_CORRUPT", "Unsupported canonical storage format.");
  if (state.schemaVersion !== 1 || !state.snapshot || !Array.isArray(state.receipts)) fail_("STATE_CORRUPT", "Unsupported canonical state.");
  if (state.revision === undefined) state.revision = 0;
  if (!Number.isInteger(state.revision) || state.revision < 0) fail_("STATE_CORRUPT", "Invalid canonical revision.");
  if (!state.groupDefinitions) state.groupDefinitions = defaultGroupDefinitions_();
  const hasSavedLocations = Array.isArray(state.snapshot.config.locations) && state.snapshot.config.locations.length > 0;
  const savedLocations = hasSavedLocations
    ? state.snapshot.config.locations
    : DEFAULT_CLUB_LOCATIONS.slice();
  state.snapshot.config.locations = clubLocationOptions_(Object.assign({}, state.snapshot.config, { locations: savedLocations }));
  if (String(state.snapshot.config.location || "").trim().toLowerCase() === "willett rec") {
    state.snapshot.config.location = "Willett Recreation Ground";
  }
  state.snapshot.config.locationMaps = hasSavedLocations
    ? (state.snapshot.config.locationMaps || {})
    : Object.assign({}, DEFAULT_CLUB_LOCATION_MAPS, state.snapshot.config.locationMaps || {});
  Object.keys(state.snapshot.config.locationMaps).forEach((venue) => {
    if (!state.snapshot.config.locations.includes(venue)) delete state.snapshot.config.locationMaps[venue];
  });
  validateGroupDefinitions_(state.groupDefinitions);
  validatePlatform_(state.snapshot);
  return state;
}

function commitPlatformState_(state) {
  state.revision = (state.revision || 0) + 1;
  const json = JSON.stringify(state);
  const chunks = chunkPlatformJson_(json);
  const manifest = JSON.stringify({
    schemaVersion: 1, storageFormat: "chunked-v1", revision: state.revision,
    chunkCount: chunks.length, length: json.length, sha256: platformDigest_(json), chunkPrefix: PLATFORM_CHUNK_PREFIX,
  });
  const spreadsheet = platformSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(PLATFORM_STATE_SHEET);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(PLATFORM_STATE_SHEET);
    protectPlatformSheet_(sheet);
    sheet.hideSheet();
  }
  const rows = Math.max(chunks.length + 1, sheet.getLastRow());
  if (rows > sheet.getMaxRows()) {
    const additionalRows = rows - sheet.getMaxRows();
    const cells = spreadsheet.getSheets().reduce((sum, entry) => sum + entry.getMaxRows() * entry.getMaxColumns(), 0);
    if (cells + additionalRows * sheet.getMaxColumns() > PLATFORM_GRID_LIMIT) fail_("STORAGE_LIMIT", "The workbook is at Google Sheets' ten-million-cell grid limit. No domain changes were committed.");
    sheet.insertRowsAfter(sheet.getMaxRows(), additionalRows);
  }
  const values = [[manifest]].concat(chunks.map((chunk) => [PLATFORM_CHUNK_PREFIX + chunk]));
  while (values.length < rows) values.push([""]);
  sheet.getRange(1, 1, rows, 1).setValues(values);
  SpreadsheetApp.flush();
}
function chunkPlatformJson_(json) {
  const chunks = [];
  for (let offset = 0; offset < json.length;) {
    let end = Math.min(offset + PLATFORM_CHUNK_SIZE, json.length);
    const code = json.charCodeAt(end - 1);
    if (end < json.length && code >= 0xD800 && code <= 0xDBFF) end--;
    chunks.push(json.slice(offset, end));
    offset = end;
  }
  return chunks;
}
function platformDigest_(json) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, json, Utilities.Charset.UTF_8)
    .map((byte) => ((byte + 256) % 256).toString(16).padStart(2, "0")).join("");
}

/** Run manually as an editor, never through the HTTP dispatcher. */
function initializeClubPlatform() {
  return withLock_(() => {
    const spreadsheet = platformSpreadsheet_();
    if (spreadsheet.getSheetByName(PLATFORM_STATE_SHEET) &&
        spreadsheet.getSheetByName(PLATFORM_STATE_SHEET).getRange(1, 1).getValue()) {
      repairProjections_(loadPlatformState_());
      return;
    }
    if (records_("Members").length || records_("Runs").length || records_("Bookings").length ||
        records_("Groups").length || records_("Users").length || records_("Weeks").length ||
        records_("Archives").length || records_("UserSetup").length ||
        records_("GroupDefinitions").length || records_("ClubConfiguration").length) {
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
    const spreadsheet = platformSpreadsheet_();
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
    if (state.groupDefinitions.some((previous) => !definitions.some((entry) => previous.id === entry.id))) {
      fail_("INVALID_GROUP_DEFINITIONS", "Keep each master group's stable ID unchanged.");
    }
    validateConfirmedClubConfiguration_(PLATFORM_CONFIG, definitions);
    const spreadsheet = platformSpreadsheet_();
    const backup = spreadsheet.copy(spreadsheet.getName() + " — pre-configuration backup " + new Date().toISOString());
    if (!backup || !backup.getId()) fail_("BACKUP_FAILED", "A verified backup copy is required.");
    state.groupDefinitions = definitions;
    state.snapshot.config = Object.assign({}, PLATFORM_CONFIG, { demoConfiguration: false });
    state.snapshot.config.locations = clubLocationOptions_(state.snapshot.config);
    state.configuration = { backupId: backup.getId(), at: new Date().toISOString(), actorId: admin.id };
    state.snapshot.audit.push({
      id: Utilities.getUuid(), runId: "", actorId: admin.id, action: "confirmClubConfiguration",
      at: new Date().toISOString(), requestId: Utilities.getUuid(),
    });
    commitPlatformState_(state);
    repairProjections_(state);
  });
}

/**
     * Trusted, manual initial seed/import. Run initializeClubPlatform() first, then
     * stage a complete UserSetup roster, 13 GroupDefinitions and ClubConfiguration in
     * a quiet maintenance window. Keep existing IDs/versions. HTTP requests never
     * import these tables. All changes commit together after a verified backup.
     */
function configureClubPlatform() {
      return withLock_(() => {
        const state = loadPlatformState_();
        if (state.schemaVersion !== 1) fail_("MIGRATION_REQUIRED", "Initialize or migrate the workbook first.");
        const email = normalizeEmail_(Session.getEffectiveUser().getEmail());
        const actor = state.snapshot.members.find((entry) => entry.email === email && entry.active && entry.roles.includes("admin"));
        if (!actor) fail_("FORBIDDEN", "An active administrator must configure the club.");
        const administrator = JSON.parse(JSON.stringify(actor));
        const definitions = records_("GroupDefinitions").map((entry) => ({
          id: String(entry["Group ID"] || ""), number: Number(entry.Group),
          name: "Group " + entry.Group, distanceLabel: String(entry.Distance || ""),
          paceLabel: String(entry.Pace || ""), capacity: Number(entry.Capacity),
        }));
        validateGroupDefinitions_(definitions);
        if (state.groupDefinitions.some((previous) => !definitions.some((entry) => previous.id === entry.id))) {
          fail_("INVALID_GROUP_DEFINITIONS", "Keep each master group's stable ID unchanged.");
        }
        const settings = {};
        records_("ClubConfiguration").forEach((entry) => {
          const key = String(entry.Setting || "");
          if (Object.prototype.hasOwnProperty.call(settings, key)) fail_("INVALID_CONFIGURATION", "Configuration setting names must be unique.");
          settings[key] = entry.Value;
        });
        const config = {
          location: String(settings.Location || "").trim(), timeZone: String(settings["Time Zone"] || "").trim(),
          startTime: normalizeClubTime_(settings["Start Time"]),
          demoConfiguration: String(settings["Demo Configuration"]).toUpperCase() !== "FALSE",
        };
        config.locations = clubLocationOptions_(Object.assign({}, state.snapshot.config, config));
        validateConfirmedClubConfiguration_(config, definitions);
        const roster = records_("UserSetup").map((entry) => {
          const active = String(entry.Active).toUpperCase();
          if (!["TRUE", "FALSE"].includes(active)) fail_("INVALID_MEMBER", "Each UserSetup row requires a TRUE or FALSE Active flag.");
          const memberEmail = normalizeEmail_(entry.Email);
          const suppliedId = String(entry["User ID"] || "").trim();
          if (!suppliedId && state.snapshot.members.some((member) => member.email === memberEmail)) {
            fail_("IDENTITY_CHANGE", "Keep the existing stable User ID for existing emails.");
          }
          return {
            id: suppliedId || Utilities.getUuid(), email: memberEmail, name: String(entry.Name || "").trim(),
            roles: Array.from(new Set(String(entry.Role || "").split(",").map((role) => role.trim()).filter(Boolean))),
            active: active === "TRUE", version: entry.Version === "" || entry.Version === undefined ? 1 : Number(entry.Version),
          };
        });
        if (!roster.length || roster.some((member) => !/^[a-zA-Z0-9_-]{1,120}$/.test(member.id) ||
            !member.name || member.name.length > 100 ||
            !Number.isInteger(member.version) || member.version < 1)) fail_("INVALID_MEMBER", "Supply a complete UserSetup roster with stable IDs, names and valid versions.");
        if (!roster.some((member) => member.active && member.roles.includes("admin"))) fail_("LAST_ADMIN", "At least one active administrator must remain.");
        const originalMembers = state.snapshot.members.slice();
        originalMembers.forEach((member) => {
          const imported = roster.find((entry) => entry.id === member.id);
          if (!imported) fail_("MEMBER_REMOVAL", "Existing user IDs cannot be dropped. Retain the row and set Active FALSE instead.");
          if (imported.email !== member.email) fail_("IDENTITY_CHANGE", "Existing user email identities cannot be reassigned.");
          expectedVersion_(member, imported.version);
        });
        const prospective = JSON.parse(JSON.stringify(state.snapshot));
        prospective.members = roster;
        validatePlatform_(prospective);
        roster.filter((member) => !originalMembers.some((entry) => entry.id === member.id)).forEach((member) => {
          if (member.version !== 1) fail_("INVALID_MEMBER", "New user versions must start at one.");
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(member.id)) {
            fail_("INVALID_MEMBER", "Use a UUID for a new member or leave User ID blank to generate one. Existing legacy IDs remain unchanged.");
          }
          if (originalMembers.some((entry) => entry.email === member.email)) fail_("IDENTITY_CHANGE", "Keep the existing stable ID for an existing email.");
          state.snapshot.members.push(member);
        });
        const now = new Date();
        originalMembers.forEach((member) => {
          const imported = roster.find((entry) => entry.id === member.id);
          if (member.name === imported.name && member.active === imported.active &&
              member.roles.slice().sort().join(",") === imported.roles.slice().sort().join(",")) return;
          mutatePlatform_(state.snapshot, {
            operation: "updateMember", requestId: Utilities.getUuid(), email,
            memberId: member.id, memberVersion: member.version,
            name: imported.name, roles: imported.roles, active: imported.active,
          }, administrator, now, state.groupDefinitions);
        });
        state.snapshot.config = config;
        state.groupDefinitions = definitions;
        validatePlatform_(state.snapshot);
        const spreadsheet = platformSpreadsheet_();
        const backup = spreadsheet.copy(spreadsheet.getName() + " — pre-roster configuration backup " + now.toISOString());
        if (!backup || !backup.getId()) fail_("BACKUP_FAILED", "A verified backup copy is required.");
        state.configuration = { backupId: backup.getId(), at: now.toISOString(), actorId: administrator.id };
        state.snapshot.audit.push({
          id: Utilities.getUuid(), runId: "", actorId: administrator.id,
          action: "configureClubPlatform", at: now.toISOString(), requestId: Utilities.getUuid(),
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
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > 20 ||
      new Set(definitions.map((entry) => entry.id)).size !== definitions.length ||
      new Set(definitions.map((entry) => entry.number)).size !== definitions.length ||
      definitions.some((entry) => !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) ||
        !Number.isFinite(entry.number) || entry.number <= 0 || entry.number > 20 ||
        !Number.isInteger(entry.capacity) || entry.capacity < 1 || entry.capacity > 20 || typeof entry.distanceLabel !== "string" || !entry.distanceLabel.trim() ||
        typeof entry.paceLabel !== "string" || !entry.paceLabel.trim())) {
    fail_("INVALID_GROUP_DEFINITIONS", "Supply 1–20 groups with unique positive numbers up to 20, stable IDs, confirmed distance/pace labels, and capacity 1–20.");
  }
}

function validateConfirmedClubConfiguration_(config, definitions) {
  if (!config.location || /\bDEMO\b/i.test(config.location)) {
    fail_("UNCONFIRMED_CONFIGURATION", "Set a real club meeting Location.");
  }
  try {
    if (!config.timeZone) throw new Error("Missing time zone.");
    Utilities.formatDate(new Date(), config.timeZone, "yyyy-MM-dd");
  } catch (_) {
    fail_("UNCONFIRMED_CONFIGURATION", "Set Time Zone to a valid IANA timezone, such as Europe/London.");
  }
  const cutoffMinutes = Number(PLATFORM_BOOKING_CUTOFF.slice(0, 2)) * 60 + Number(PLATFORM_BOOKING_CUTOFF.slice(3));
  if (typeof config.startTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.startTime) ||
      Number(config.startTime.slice(0, 2)) * 60 + Number(config.startTime.slice(3)) <= cutoffMinutes) {
    fail_("UNCONFIRMED_CONFIGURATION", "Set Start Time as HH:mm and later than the 18:30 booking cutoff.");
  }
  if (config.demoConfiguration !== false) {
    fail_("UNCONFIRMED_CONFIGURATION", "Set Demo Configuration to FALSE.");
  }
  if (definitions.some((entry) => /\bDEMO\b/i.test(entry.distanceLabel + " " + entry.paceLabel))) {
    fail_("UNCONFIRMED_CONFIGURATION", "Replace DEMO text in every configured group distance and pace.");
  }
}

function normalizeClubTime_(value) {
  if (value && typeof value.getTime === "function" && Number.isFinite(value.getTime())) {
    const spreadsheet = platformSpreadsheet_();
    const timeZone = typeof spreadsheet.getSpreadsheetTimeZone === "function"
      ? spreadsheet.getSpreadsheetTimeZone()
      : "Etc/UTC";
    return Utilities.formatDate(value, timeZone, "HH:mm");
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
  }
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function emptySnapshot_() {
  return { weeks: [], groups: [], bookings: [], members: [], attendance: [], audit: [], config: Object.assign({}, PLATFORM_CONFIG, { locations: DEFAULT_CLUB_LOCATIONS.slice(), locationMaps: Object.assign({}, DEFAULT_CLUB_LOCATION_MAPS) }), demo: false };
}
function clubLocationOptions_(config) {
  const candidates = Array.isArray(config.locations) ? config.locations : [];
  if (config.location && !/\bDEMO\b/i.test(config.location)) candidates.push(config.location);
  const seen = new Set();
  return candidates.map((location) => String(location || "").trim()).filter((location) => {
    const key = location.toLowerCase();
    if (!location || key === "willett rec" || location.length > 120 || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 30);
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
  snapshot.groups = legacyGroups.map((entry) => {
    const week = snapshot.weeks.find((candidate) => candidate.id === String(entry.runId));
    const historical = week && (["archived", "cancelled"].includes(week.status) || new Date(week.startsAt) <= new Date());
    return {
      id: String(entry.groupId), runId: String(entry.runId), number: Number(entry.groupNumber),
      paceLabel: String(entry.paceLabel || "DEMO — pace to be confirmed"),
      distanceLabel: String(entry.distanceLabel || "DEMO — distance to be confirmed"),
      name: String(entry.name || "Group " + entry.groupNumber),
      capacity: Number(entry.capacity || 19), version: Number(entry.version || 1),
      ...(entry.leaderId ? { leaderId: String(entry.leaderId) } : {}),
      ...(entry.sweeperId ? { sweeperId: String(entry.sweeperId) } : {}),
      routeDescription: String(entry.routeDescription || ""), routeNeedsReview: !!entry.routeDescription,
    };
  });
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
  if (snapshot.config.locations !== undefined) {
    if (!Array.isArray(snapshot.config.locations) || snapshot.config.locations.length > 30 ||
        snapshot.config.locations.some((location) => typeof location !== "string" || !location.trim() || location.length > 120) ||
        new Set(snapshot.config.locations.map((location) => location.trim().toLowerCase())).size !== snapshot.config.locations.length ||
        (!/\bDEMO\b/i.test(snapshot.config.location) && snapshot.config.locations.length && !snapshot.config.locations.includes(snapshot.config.location))) fail_("INVALID_CONFIGURATION", "Configured locations must be unique and include the selected location.");
  }
  if (snapshot.config.locationMaps !== undefined) {
    if (!snapshot.config.locationMaps || typeof snapshot.config.locationMaps !== "object" || Array.isArray(snapshot.config.locationMaps) ||
        Object.keys(snapshot.config.locationMaps).some((location) => !snapshot.config.locations?.includes(location) || !validMapsUrl_(snapshot.config.locationMaps[location]))) {
      fail_("INVALID_CONFIGURATION", "Each saved Google Maps link must be valid and belong to a saved venue.");
    }
  }
  snapshot.weeks.forEach((week) => {
    if (!["draft", "published", "cancelled", "archived"].includes(week.status) ||
        ![week.startsAt, week.bookingOpensAt, week.bookingClosesAt].every((value) => Number.isFinite(new Date(value).getTime())) ||
        !Number.isInteger(week.version) || week.version < 1) fail_("INVALID_DATA", "Invalid week details.");
    const weekGroups = snapshot.groups.filter((group) => group.runId === week.id);
    if (!["archived", "cancelled"].includes(week.status) &&
      (!weekGroups.length || weekGroups.length > 20 || new Set(weekGroups.map((group) => group.number)).size !== weekGroups.length)) fail_("INVALID_GROUPS", "Every live week must have 1–20 groups with unique numbers.");
  });
  if (snapshot.weeks.filter((week) => week.status === "published" && new Date(week.startsAt) > new Date()).length > 1) {
    fail_("PUBLISHED_RUN_EXISTS", "Only one future run can be published.");
  }
  const assignments = new Set();
  snapshot.groups.forEach((group) => {
    const week = snapshot.weeks.find((entry) => entry.id === group.runId);
    const live = week && !["archived", "cancelled"].includes(week.status) && new Date(week.startsAt) > new Date();
    if (!weeks.has(group.runId) || !Number.isInteger(group.capacity) || group.capacity < 1 || group.capacity > 20 ||
      !Number.isFinite(group.number) || group.number <= 0 || group.number > 20 ||
        typeof group.paceLabel !== "string" || !group.paceLabel.trim() ||
        !Number.isInteger(group.version) || group.version < 1) fail_("INVALID_GROUPS", "Invalid group capacity or version.");
    if (live && occupantCount_(snapshot, group) > group.capacity) fail_("GROUP_FULL", "Existing occupants exceed group capacity; reconcile legacy data before migration.");
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
    const sheet = platformSpreadsheet_().getSheetByName(PLATFORM_STATE_SHEET);
    if (sheet && sheet.getRange(1, 2).getValue() === "projected:" + state.revision) return true;
    projectPlatform_(state);
    // B1 is only a disposable recovery checkpoint, never an auth/schema source.
    // It is written AFTER all projection writes have been flushed. A stale or
    // missing checkpoint causes complete regeneration from the committed A1.
    sheet.getRange(1, 2).setValue("projected:" + state.revision);
    SpreadsheetApp.flush();
    return true;
  } catch (_) {
    // Canonical state is already committed. Never report a failed mutation or
    // roll it back because a disposable projection could not be regenerated.
    return false;
  }
}
function projectPlatform_(state) {
  const spreadsheet = platformSpreadsheet_();
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
  writeProjection_("UserSetup", ["Email", "Name", "Role", "User ID", "Active", "Version"],
    snapshot.members.map((entry) => [entry.email, entry.name, entry.roles.join(","), entry.id, entry.active, entry.version]));
  writeProjection_("Weeks", ["Week ID", "Date", "Starts At", "Booking Opens At", "Booking Closes At", "Status", "Version", "Cancellation Reason", "Sheet", "Location", "Google Maps URL"],
    snapshot.weeks.map((entry) => [entry.id, clubLocalDate_(new Date(entry.startsAt), snapshot.config.timeZone), entry.startsAt, entry.bookingOpensAt, entry.bookingClosesAt, entry.status, entry.version, entry.cancellationReason || "", weeklySheetName_(entry.id), entry.location || snapshot.config.location, entry.mapsUrl || ""]));
  writeProjection_("Groups", ["Group", "Distance", "Pace", "Capacity", "Group ID"],
    state.groupDefinitions.map((entry) => [entry.number, entry.distanceLabel, entry.paceLabel, entry.capacity, entry.id]));
  writeProjection_("GroupDefinitions", ["Group", "Distance", "Pace", "Capacity", "Group ID"],
    state.groupDefinitions.map((entry) => [entry.number, entry.distanceLabel, entry.paceLabel, entry.capacity, entry.id]));
  writeProjection_("ClubConfiguration", ["Setting", "Value"], [
    ["Location", snapshot.config.location], ["Time Zone", snapshot.config.timeZone],
    ["Start Time", snapshot.config.startTime], ["Demo Configuration", snapshot.config.demoConfiguration],
    ["Available Locations", JSON.stringify(clubLocationOptions_(snapshot.config))],
    ["Location Maps", JSON.stringify(snapshot.config.locationMaps || {})],
  ]);
  snapshot.weeks.forEach((week) => {
    const bookings = snapshot.bookings.filter((entry) => entry.runId === week.id).map((entry) => {
      const member = snapshot.members.find((candidate) => candidate.id === entry.memberId);
      const group = snapshot.groups.find((candidate) => candidate.id === entry.groupId);
      return [group ? group.name || "Group " + group.number : "", member ? member.name : "", entry.status, entry.bookedAt,
        entry.id, entry.runId, entry.groupId, entry.memberId, entry.source, entry.version];
    });
    const groups = snapshot.groups.filter((entry) => entry.runId === week.id).sort((a, b) => a.number - b.number)
      .map((entry) => {
        const leader = snapshot.members.find((candidate) => candidate.id === entry.leaderId);
        const sweeper = snapshot.members.find((candidate) => candidate.id === entry.sweeperId);
        return [entry.name || "Group " + entry.number, leader ? leader.name : "", sweeper ? sweeper.name : "",
          entry.routeDescription || "", entry.distanceLabel || "", entry.paceLabel, entry.capacity,
          entry.id, entry.runId, entry.leaderId || "", entry.sweeperId || "", !!entry.routeNeedsReview, entry.version,
          week.status === "cancelled" ? 0 : occupantCount_(snapshot, entry),
          week.status === "cancelled" ? 0 : snapshot.bookings.filter((booking) => booking.groupId === entry.id && booking.status === "waitlisted").length];
      });
    const sheet = writeProjection_(weeklySheetName_(week.id),
      ["Group", "Runner", "Status", "Booking Time", "Booking ID", "Week ID", "Group ID", "User ID", "Source", "Version"], bookings);
    setProjectionValues_(sheet, 1, 12, [["Group", "Leader", "Sweeper", "Route Description", "Distance", "Pace", "Capacity", "Group ID", "Week ID", "Leader ID", "Sweeper ID", "Route Needs Review", "Version", "Confirmed", "Waitlisted"]].concat(groups));
  });
  writeProjection_("Attendance", ["Attendance ID", "Week ID", "Group ID", "User ID", "Outcome", "Recorded At"],
    snapshot.attendance.map((entry) => [entry.id, entry.runId, entry.groupId, entry.memberId, entry.outcome, entry.recordedAt]));
  writeProjection_("Audit", ["Audit ID", "Week ID", "Group ID", "User ID", "Actor ID", "Action", "At", "Request ID", "Queue Size"],
    snapshot.audit.map((entry) => [entry.id, entry.runId, entry.groupId || "", entry.memberId || "", entry.actorId, entry.action, entry.at, entry.requestId, entry.queueSize === undefined ? "" : entry.queueSize]));
  SpreadsheetApp.flush();
}
function writeProjection_(name, headers, rows) {
  const spreadsheet = platformSpreadsheet_();
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
  const sheet = platformSpreadsheet_().getSheetByName(sheetName);
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
  const bookingClosesAt = clubInstant_(date, PLATFORM_BOOKING_CUTOFF, config.timeZone);
  if (new Date(date + "T12:00:00Z").getUTCDay() !== 2 || new Date(bookingClosesAt) <= now || new Date(startsAt) <= new Date(bookingClosesAt)) fail_("INVALID_DATE", "Choose a future Tuesday with a start after the 18:30 club-local cutoff.");
  return { startsAt, bookingOpensAt: now.toISOString(), bookingClosesAt };
}
