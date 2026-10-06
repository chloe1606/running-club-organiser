/**
 * Server-only gateway. Deploy as the spreadsheet owner's web app; never expose
 * GATEWAY_SECRET or this endpoint to browsers. Auth operations share this lock.
 */
let platformWorkbook_ = null;

function doPost(event) {
  try {
    platformWorkbook_ = null;
    const request = JSON.parse(event.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty("GATEWAY_SECRET");
    if (!secret || typeof request.secret !== "string" || request.secret !== secret) {
      return response_(false, "UNAUTHORIZED", "Invalid gateway credentials.");
    }
    const spreadsheet = platformSpreadsheet_();
    if (!spreadsheet || typeof request.spreadsheetId !== "string" || request.spreadsheetId !== spreadsheet.getId()) {
      return response_(false, "WORKBOOK_MISMATCH", "The gateway workbook does not match the configured workbook.");
    }
    return withLock_(() => dispatch_(request));
  } catch (error) {
    // Do not log request bodies, tokens, credentials, or upstream exceptions.
    return response_(false, error.platformCode || "INTERNAL_ERROR",
      error.platformCode ? error.message : "The gateway could not complete this request.");
  }
}

function dispatch_(request) {
  if (typeof request.operation !== "string") fail_("INVALID_REQUEST", "Operation is required.");
  if (/^auth/.test(request.operation)) {
    if (typeof authDispatch_ !== "function") fail_("NOT_CONFIGURED", "Authentication is not configured.");
    return authDispatch_(request);
  }
  let state = loadPlatformState_();
  if (request.operation === "snapshot") {
    if (state.schemaVersion) repairProjections_(state);
    return response_(true, null, null, snapshotFor_(state.snapshot, request.email));
  }
  if (!state.schemaVersion) fail_("MIGRATION_REQUIRED", "An administrator must back up and migrate the legacy workbook before writes.");
  repairProjections_(state);
  const email = normalizeEmail_(request.email);
  const actor = state.snapshot.members.find((member) => member.email === email && member.active);
  if (!actor) fail_("FORBIDDEN", "An active club membership is required.");
  if (typeof request.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestId)) {
    fail_("INVALID_REQUEST", "A stable UUID requestId is required.");
  }
  const fingerprint = requestFingerprint_(request);
  const receipt = state.receipts.find((entry) => entry.requestId === request.requestId);
  if (receipt) {
    if (receipt.actorId !== actor.id || receipt.fingerprint !== fingerprint) {
      fail_("REQUEST_ID_REUSED", "This requestId was already used for a different request.");
    }
    return response_(true, null, null, receipt.result);
  }
  // Mutate a detached candidate. Rejections cannot remove an existing booking.
  state = JSON.parse(JSON.stringify(state));
  const result = mutatePlatform_(state.snapshot, request, actor, new Date(), state.groupDefinitions);
  validatePlatform_(state.snapshot);
  state.receipts.push({ requestId: request.requestId, actorId: actor.id, fingerprint, result });
  commitPlatformState_(state);
  const projected = repairProjections_(state);
  return response_(true, null, null, Object.assign({}, result, { projectionPending: !projected }));
}

function mutatePlatform_(snapshot, request, actor, now, groupDefinitions) {
  const operation = request.operation;
  const admin = actor.roles.includes("admin");
  const adminOperations = ["createWeek", "updateWeekLocation", "publishRun", "cancelRun", "archiveRun", "assignLeader", "updateMember", "moveRunner", "updateLocations"];
  if (adminOperations.includes(operation) && !admin) fail_("FORBIDDEN", "Only administrators can perform this operation.");
  let run;
  let group;
  let result = {};
  const touched = new Set();
  const auditContext = { actorId: actor.id, requestId: request.requestId, at: now.toISOString() };
  if (operation === "createWeek") {
    const schedule = platformSchedule_(request.date, snapshot.config, now);
    if (snapshot.weeks.some((week) => clubLocalDate_(new Date(week.startsAt), snapshot.config.timeZone) === request.date)) {
      fail_("WEEK_EXISTS", "A run already exists for this club-local date.");
    }
    const locations = Array.isArray(snapshot.config.locations) ? snapshot.config.locations : [snapshot.config.location].filter((location) => location && !/\bDEMO\b/i.test(location));
    const configuredLocation = snapshot.config.location;
    const location = String(request.location || (locations.includes(configuredLocation) ? configuredLocation : locations[0]) ||
      (snapshot.config.demoConfiguration ? configuredLocation : "")).trim();
    if (!location || (!locations.includes(location) && !(snapshot.config.demoConfiguration && !locations.length))) fail_("INVALID_CONFIGURATION", "Choose a saved venue for this week.");
    const locationMaps = snapshot.config.locationMaps || {};
    run = Object.assign({ id: "run-" + request.date, status: "draft", version: 1, location,
      ...(locationMaps[location] ? { mapsUrl: locationMaps[location] } : {}) }, schedule);
    let sourceGroups = [];
    if (request.copyFromRunId) {
      if (!snapshot.weeks.some((week) => week.id === request.copyFromRunId)) fail_("NOT_FOUND", "The source week does not exist.");
      sourceGroups = snapshot.groups.filter((entry) => entry.runId === request.copyFromRunId);
    }
    snapshot.weeks.push(run);
    groupDefinitions.slice().sort((left, right) => left.number - right.number).forEach((definition) => {
      const source = sourceGroups.find((entry) => entry.id === request.copyFromRunId + "-" + definition.id) ||
        sourceGroups.find((entry) => entry.number === definition.number);
      snapshot.groups.push({
        id: run.id + "-" + definition.id, runId: run.id, number: definition.number, version: 1,
        name: definition.name || "Group " + definition.number,
        distanceLabel: definition.distanceLabel,
        paceLabel: definition.paceLabel,
        capacity: definition.capacity,
        routeDescription: source && source.routeDescription || "",
        routeNeedsReview: false,
      });
    });
    result = { runId: run.id, status: "draft" };
  } else if (operation === "updateLocations") {
    if (!Array.isArray(request.locations) || request.locations.length < 1 || request.locations.length > 30 ||
        request.locations.some((location) => typeof location !== "string" || !location.trim() || location.trim().length > 120) ||
        new Set(request.locations.map((location) => location.trim().toLowerCase())).size !== request.locations.length) {
      fail_("INVALID_CONFIGURATION", "Supply 1–30 unique location names, each no longer than 120 characters.");
    }
    const locations = request.locations.map((location) => location.trim());
    if (typeof request.location !== "string" || !locations.includes(request.location.trim())) {
      fail_("INVALID_CONFIGURATION", "Select a location from the saved venue list.");
    }
    const removed = (snapshot.config.locations || []).filter((location) => !locations.some((candidate) => candidate.toLowerCase() === location.toLowerCase()));
    if (snapshot.weeks.some((week) => removed.includes(week.location) && ["draft", "published"].includes(week.status) && new Date(week.startsAt) > new Date())) {
      fail_("LOCATION_IN_USE", "A future week uses this venue. Change that week's location before removing it.");
    }
    snapshot.config.locations = clubLocationOptions_(Object.assign({}, snapshot.config, { locations }));
    snapshot.config.location = request.location.trim();
    const locationMaps = Object.assign({}, DEFAULT_CLUB_LOCATION_MAPS, request.locationMaps || snapshot.config.locationMaps || {});
    Object.keys(locationMaps).forEach((venue) => { if (!snapshot.config.locations.includes(venue)) delete locationMaps[venue]; });
    if (!locationMaps || typeof locationMaps !== "object" || Array.isArray(locationMaps) ||
        Object.keys(locationMaps).some((venue) => !locations.includes(venue) || !validMapsUrl_(locationMaps[venue]))) {
      fail_("INVALID_CONFIGURATION", "Supply valid Google Maps HTTPS links for saved venues.");
    }
    snapshot.config.locationMaps = locationMaps;
    result = { location: snapshot.config.location };
  } else if (operation === "updateMember") {
    const member = snapshot.members.find((entry) => entry.id === request.memberId);
    if (!member) fail_("NOT_FOUND", "The member does not exist.");
    expectedVersion_(member, request.memberVersion);
    if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 100 ||
        !Array.isArray(request.roles) || !request.roles.length || request.roles.some((role) => !["runner", "leader", "sweeper", "admin"].includes(role)) ||
        typeof request.active !== "boolean") fail_("INVALID_MEMBER", "Supply a name, valid roles and active flag.");
    const roles = Array.from(new Set(request.roles));
    if (member.roles.includes("admin") && (!request.active || !roles.includes("admin")) &&
        !snapshot.members.some((entry) => entry.id !== member.id && entry.active && entry.roles.includes("admin"))) {
      fail_("LAST_ADMIN", "The last active administrator cannot be removed.");
    }
    if (snapshot.groups.some((entry) => {
      const week = snapshot.weeks.find((candidate) => candidate.id === entry.runId);
      return week && !["cancelled", "archived"].includes(week.status) && new Date(week.startsAt) > now &&
        ((entry.leaderId === member.id && (!request.active || !roles.includes("leader"))) ||
         (entry.sweeperId === member.id && (!request.active || !roles.includes("sweeper"))));
    })) {
      fail_("ASSIGNMENT_EXISTS", "Remove the member's assignments before changing eligibility.");
    }
    member.name = request.name.trim();
    member.roles = roles;
    member.active = request.active;
    member.version++;
    if (!member.active || !roles.includes("runner")) {
      snapshot.bookings.filter((booking) => booking.memberId === member.id && booking.status !== "cancelled")
        .forEach((booking) => {
          const bookingRun = snapshot.weeks.find((entry) => entry.id === booking.runId);
          if (!bookingRun || ["archived", "cancelled"].includes(bookingRun.status) || new Date(bookingRun.startsAt) <= now) return;
          if (booking.source === "assignment") return;
          cancelBooking_(snapshot, booking, auditContext);
          const bookingGroup = snapshot.groups.find((entry) => entry.id === booking.groupId);
          promoteQueue_(snapshot, bookingGroup, now, auditContext);
          bookingGroup.version++;
          touched.add(bookingRun.id);
        });
      touched.forEach((id) => snapshot.weeks.find((entry) => entry.id === id).version++);
    }
    result = { memberId: member.id, version: member.version };
  } else {
    run = snapshot.weeks.find((entry) => entry.id === request.runId);
    if (!run) fail_("NOT_FOUND", "The run does not exist.");
    expectedVersion_(run, request.runVersion);
    if (["archived", "cancelled"].includes(run.status)) fail_("RUN_CLOSED", "This run is read-only; cancelled runs retain their cancellation status.");
    const runOperations = ["updateWeekLocation", "publishRun", "cancelRun", "archiveRun"];
    if (!runOperations.includes(operation)) {
      const ownBooking = operation === "leave" && !request.groupId &&
        snapshot.bookings.find((entry) => entry.runId === run.id && entry.memberId === actor.id && entry.status !== "cancelled");
      const groupId = request.groupId || (ownBooking && ownBooking.groupId);
      group = snapshot.groups.find((entry) => entry.id === groupId && entry.runId === run.id);
      if (!group) fail_("NOT_FOUND", "The selected group does not belong to this run.");
      if (operation !== "leave" || request.groupId || request.groupVersion !== undefined) expectedVersion_(group, request.groupVersion);
      if (group.cancelled && operation !== "cancelGroup") fail_("GROUP_CANCELLED", "This group is not running.");
      touched.add(group.id);
    }
    switch (operation) {
      case "cancelGroup": {
        if (!group || !["draft", "published"].includes(run.status) || new Date(run.startsAt) <= now) fail_("RUN_CLOSED", "Only a future draft or published group can be marked not running.");
        if (group.cancelled) fail_("GROUP_CANCELLED", "This group is already marked not running.");
        if (request.reason === "low-interest") {
          assertGroupManager_(actor, group);
        } else if (request.reason === "no-leader") {
          if (!admin) fail_("FORBIDDEN", "Only an administrator can mark a group not running because no leader is available.");
          if (group.leaderId) fail_("INVALID_GROUP_STATUS", "Remove the assigned leader before marking this group not running.");
        } else fail_("INVALID_GROUP_STATUS", "Choose a supported reason for not running this group.");
        group.cancelled = true;
        group.cancellationReason = request.reason;
        snapshot.bookings.filter((booking) => booking.groupId === group.id && booking.runId === run.id && booking.status !== "cancelled")
          .forEach((booking) => cancelBooking_(snapshot, booking, auditContext));
        result = { status: "cancelled", reason: request.reason };
        break;
      }
      case "updateWeekLocation": {
        if (!admin) fail_("FORBIDDEN", "Only administrators can change a week location.");
        if (!["draft", "published"].includes(run.status) || new Date(run.startsAt) <= now) fail_("RUN_CLOSED", "Only a future draft or published week can change location.");
        const location = String(request.location || "").trim();
        const locations = Array.isArray(snapshot.config.locations) ? snapshot.config.locations : [];
        if (!locations.includes(location)) fail_("INVALID_CONFIGURATION", "Choose a saved venue for this week.");
        run.location = location;
        const mapsUrl = (snapshot.config.locationMaps || {})[location];
        if (mapsUrl) run.mapsUrl = mapsUrl;
        else delete run.mapsUrl;
        result = { location, mapsUrl: mapsUrl || null };
        break;
      }
      case "publishRun":
        if (run.status !== "draft" || new Date(run.startsAt) <= now || new Date(run.bookingClosesAt) <= now) fail_("INVALID_PUBLISH", "Only future draft runs with an open booking window can be published.");
        if (snapshot.weeks.some((entry) => entry.id !== run.id && entry.status === "published" && new Date(entry.startsAt) > now)) fail_("PUBLISHED_RUN_EXISTS", "Another future run is already published.");
        run.status = "published";
        result = { status: run.status };
        break;
      case "cancelRun":
        if (new Date(run.startsAt) <= now || typeof request.cancellationReason !== "string" || !request.cancellationReason.trim() || request.cancellationReason.length > 1000) fail_("INVALID_CANCELLATION", "Only future runs with a cancellation reason can be cancelled.");
        run.status = "cancelled";
        run.cancellationReason = request.cancellationReason.trim();
        snapshot.bookings.filter((entry) => entry.runId === run.id && entry.status !== "cancelled").forEach((entry) => cancelBooking_(snapshot, entry, auditContext));
        snapshot.groups.filter((entry) => entry.runId === run.id).forEach((entry) => entry.version++);
        result = { status: run.status };
        break;
      case "archiveRun":
        if (new Date(run.startsAt) > now) fail_("INVALID_ARCHIVE", "Only completed runs can be archived.");
        run.status = "archived";
        result = { status: run.status };
        break;
      case "book":
      case "leave":
      case "switchGroup":
      case "moveRunner": {
        if (operation !== "moveRunner" && !actor.roles.includes("runner")) fail_("FORBIDDEN", "Only runners can manage bookings.");
        assertBookingOpen_(run, now);
        const memberId = operation === "moveRunner" ? request.memberId : actor.id;
        const member = snapshot.members.find((entry) => entry.id === memberId && entry.active && entry.roles.includes("runner"));
        if (!member) fail_("FORBIDDEN", "The runner is not an active eligible member.");
        const original = snapshot.bookings.find((entry) => entry.runId === run.id && entry.memberId === memberId && entry.status !== "cancelled");
        if (operation === "book" && original) fail_("DUPLICATE_BOOKING", "You already have a booking for this run.");
        if (operation !== "book" && !original) fail_("NOT_FOUND", "There is no active booking to change.");
        const isLeader = snapshot.groups.some((entry) => entry.runId === run.id && entry.leaderId === memberId);
        const sweeperGroup = snapshot.groups.find((entry) => entry.runId === run.id && entry.sweeperId === memberId);
        const ownsSweeperVolunteerRole = Boolean(original && original.source === "member" && sweeperGroup?.id === original.groupId);
        if ((original && original.source === "assignment") || isLeader || (sweeperGroup && !ownsSweeperVolunteerRole)) {
          fail_("ASSIGNMENT_EXISTS", "An administrator must remove the assignment before this runner can change groups.");
        }
        if (request.sweeper === true && !member.roles.includes("sweeper")) fail_("FORBIDDEN", "An active sweeper role is required to volunteer.");
        if (operation === "leave") {
          if (original.groupId !== group.id) fail_("WRONG_GROUP", "The booking is not in this group.");
          if (group.sweeperId === memberId && original.source === "member") delete group.sweeperId;
          cancelBooking_(snapshot, original, auditContext);
          promoteQueue_(snapshot, group, now, auditContext);
          result = { status: "cancelled" };
        } else {
          if (original && original.groupId === group.id) fail_("SAME_GROUP", "Choose another group.");
          // A full destination produces a waitlist booking atomically; it does
          // not retain the original place. Any rejected request retains it.
          if (original) {
            const source = snapshot.groups.find((entry) => entry.id === original.groupId);
            if (request.sourceGroupVersion !== undefined) expectedVersion_(source, request.sourceGroupVersion);
            if (source.sweeperId === memberId && original.source === "member") delete source.sweeperId;
            cancelBooking_(snapshot, original, auditContext);
            promoteQueue_(snapshot, source, now, auditContext);
            touched.add(source.id);
          }
          if (request.sweeper === true && group.sweeperId && group.sweeperId !== memberId) {
            fail_("ASSIGNMENT_EXISTS", "This group already has a sweeper.");
          }
          const status = occupantCount_(snapshot, group) < bookingCapacity_(group) ? "confirmed" : "waitlisted";
          if (request.sweeper === true && status !== "confirmed") fail_("GROUP_FULL", "A sweeper volunteer needs a confirmed place in the group.");
          if (request.sweeper === true) group.sweeperId = memberId;
          const booking = {
            id: Utilities.getUuid(), runId: run.id, groupId: group.id, memberId,
            status,
            source: "member", bookedAt: now.toISOString(), version: 1,
          };
          snapshot.bookings.push(booking);
          if (booking.status === "waitlisted") queueAudit_(snapshot, booking, "waitlistJoined", auditContext);
          result = { bookingId: booking.id, status: booking.status };
        }
        break;
      }
      case "updateRoute":
        assertGroupManager_(actor, group);
        assertFutureRun_(run, now);
        if (typeof request.routeDescription !== "string" || request.routeDescription.length > 5000) fail_("INVALID_ROUTE", "Route text must be at most 5,000 characters.");
        group.routeDescription = request.routeDescription.trim();
        group.routeNeedsReview = false;
        result = { groupId: group.id };
        break;
      case "assignLeader":
      case "assignSweeper":
        if (operation === "assignSweeper") assertGroupManager_(actor, group);
        assertFutureRun_(run, now);
        assignOccupant_(snapshot, run, group, request, now, auditContext);
        result = { groupId: group.id };
        break;
      case "recordAttendance": {
        assertGroupManager_(actor, group);
        if (new Date(run.startsAt) > now) fail_("ATTENDANCE_NOT_STARTED", "Attendance can be recorded once the run starts.");
        if (!["present", "absent"].includes(request.outcome)) fail_("INVALID_ATTENDANCE", "Attendance must be present or absent.");
        if (!snapshot.bookings.some((entry) => entry.runId === run.id && entry.groupId === group.id && entry.memberId === request.memberId && entry.status === "confirmed") &&
            ![group.leaderId, group.sweeperId].includes(request.memberId)) fail_("NOT_CONFIRMED", "Attendance is only available for confirmed group occupants.");
        let attendance = snapshot.attendance.find((entry) => entry.runId === run.id && entry.memberId === request.memberId);
        if (!attendance) {
          attendance = { id: Utilities.getUuid(), runId: run.id, groupId: group.id, memberId: request.memberId };
          snapshot.attendance.push(attendance);
        }
        attendance.outcome = request.outcome;
        attendance.recordedAt = now.toISOString();
        result = { attendanceId: attendance.id };
        break;
      }
      default:
        fail_("UNKNOWN_OPERATION", "Unsupported operation.");
    }
    touched.forEach((id) => snapshot.groups.find((entry) => entry.id === id).version++);
    run.version++;
    result.runVersion = run.version;
    if (group) result.groupVersion = group.version;
  }
  snapshot.audit.push({
    id: Utilities.getUuid(), runId: run ? run.id : "", groupId: group ? group.id : undefined,
    memberId: request.memberId || actor.id, actorId: actor.id, action: operation,
    at: now.toISOString(), requestId: request.requestId,
  });
  return result;
}

function assignOccupant_(snapshot, run, group, request, now, auditContext) {
  const role = request.operation === "assignLeader" ? "leader" : "sweeper";
  const field = role + "Id";
  const previousId = group[field];
  const memberId = request.memberId;
  if (memberId) {
    const member = snapshot.members.find((entry) => entry.id === memberId && entry.active && entry.roles.includes(role));
    if (!member) fail_("INVALID_ASSIGNMENT", "Choose an active member with the appropriate role.");
    if (snapshot.groups.some((entry) => entry.runId === run.id && entry.id !== group.id && (entry.leaderId === memberId || entry.sweeperId === memberId)) ||
        snapshot.bookings.some((entry) => entry.runId === run.id && entry.groupId !== group.id && entry.memberId === memberId && entry.status !== "cancelled")) {
      fail_("DUPLICATE_BOOKING", "The member already occupies or waitlists another group.");
    }
  }
  delete group[field];
  if (previousId && previousId !== memberId && ![group.leaderId, group.sweeperId].includes(previousId)) {
    snapshot.bookings.filter((entry) => entry.runId === run.id && entry.groupId === group.id && entry.memberId === previousId && entry.source === "assignment" && entry.status !== "cancelled").forEach((entry) => cancelBooking_(snapshot, entry, auditContext));
  }
  if (memberId) {
    group[field] = memberId;
    const booking = snapshot.bookings.find((entry) => entry.runId === run.id && entry.memberId === memberId && entry.status !== "cancelled");
    if (occupantCount_(snapshot, group) > bookingCapacity_(group)) {
      fail_("GROUP_FULL", "The assignment would exceed group capacity.");
    }
    if (booking) {
      if (booking.status !== "confirmed") {
        assertBookingOpen_(run, now);
        booking.status = "confirmed";
        booking.version++;
        queueAudit_(snapshot, booking, "promoted", auditContext);
      }
    } else {
      snapshot.bookings.push({ id: Utilities.getUuid(), runId: run.id, groupId: group.id, memberId, status: "confirmed", source: "assignment", bookedAt: now.toISOString(), version: 1 });
    }
  }
  promoteQueue_(snapshot, group, now, auditContext);
}

function promoteQueue_(snapshot, group, now, auditContext) {
  const run = snapshot.weeks.find((entry) => entry.id === group.runId);
  if (!run || group.cancelled || !bookingOpen_(run, now)) return;
  const queue = snapshot.bookings.filter((entry) => entry.groupId === group.id && entry.status === "waitlisted")
    .sort((a, b) => new Date(a.bookedAt).getTime() - new Date(b.bookedAt).getTime() || a.id.localeCompare(b.id));
  for (const booking of queue) {
    const member = snapshot.members.find((entry) => entry.id === booking.memberId && entry.active && entry.roles.includes("runner"));
    if (!member) { cancelBooking_(snapshot, booking, auditContext); continue; }
    if (occupantCount_(snapshot, group) >= bookingCapacity_(group)) break;
    booking.status = "confirmed";
    booking.version++;
    queueAudit_(snapshot, booking, "promoted", auditContext);
  }
}

function occupantCount_(snapshot, group) {
  const ids = new Set(snapshot.bookings.filter((entry) => entry.groupId === group.id && entry.status === "confirmed").map((entry) => entry.memberId));
  if (group.leaderId) ids.add(group.leaderId);
  if (group.sweeperId) ids.add(group.sweeperId);
  return ids.size;
}

function bookingCapacity_(group) {
  return Math.max(0, Math.min(group.capacity, 20) - (group.leaderId ? 0 : 1));
}

function cancelBooking_(snapshot, booking, auditContext) {
  booking.status = "cancelled";
  booking.version++;
  if (auditContext) queueAudit_(snapshot, booking, "withdrawn", auditContext);
}
function queueAudit_(snapshot, booking, action, context) {
  snapshot.audit.push({
    id: Utilities.getUuid(), runId: booking.runId, groupId: booking.groupId,
    memberId: booking.memberId, actorId: context.actorId, action, at: context.at,
    requestId: context.requestId,
    queueSize: snapshot.bookings.filter((entry) => entry.groupId === booking.groupId && entry.status === "waitlisted").length,
  });
}
function expectedVersion_(record, expected) {
  if (!Number.isInteger(expected) || record.version !== expected) fail_("STALE_VERSION", "This record changed. Refresh and try again.");
}
function assertBookingOpen_(run, now) {
  if (!bookingOpen_(run, now)) fail_("BOOKING_CLOSED", "Booking is not currently open.");
}
function bookingOpen_(run, now) {
  return run.status === "published" && now >= new Date(run.bookingOpensAt) && now < new Date(run.bookingClosesAt);
}
function assertFutureRun_(run, now) {
  if (new Date(run.startsAt) <= now) fail_("RUN_STARTED", "This run has already started.");
}
function assertGroupManager_(actor, group) {
  if (!actor.roles.includes("admin") && !(actor.roles.includes("leader") && group.leaderId === actor.id)) fail_("FORBIDDEN", "Only the assigned leader or an administrator can manage this group.");
}
function normalizeEmail_(email) { return typeof email === "string" ? email.trim().toLowerCase() : ""; }
function validMapsUrl_(value) {
  return typeof value === "string" && value.length <= 2000 &&
    (/^https:\/\/(?:[a-z0-9-]+\.)*google\.[a-z.]+\/maps(?:[/?#]|$)/i.test(value) ||
     /^https:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9]+(?:\?.*)?$/i.test(value));
}
function requestFingerprint_(request) {
  const fields = Object.keys(request).filter((key) => key !== "secret" && key !== "spreadsheetId").sort();
  return JSON.stringify(fields.map((key) => [key, request[key]]));
}
function snapshotFor_(snapshot, email) {
  const result = JSON.parse(JSON.stringify(snapshot));
  const member = result.members.find((entry) => entry.active && entry.email === normalizeEmail_(email));
  if (member) result.currentMemberId = member.id;
  return result;
}
function fail_(code, message) {
  const error = new Error(message);
  error.platformCode = code;
  throw error;
}
function withLock_(operation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return response_(false, "LOCK_TIMEOUT", "Another update is in progress. Please try again.");
  try { return operation(); } finally { lock.releaseLock(); }
}
function platformSpreadsheet_() {
  const configured = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (typeof configured !== "string" || !configured.trim()) fail_("NOT_CONFIGURED", "The gateway workbook is not configured.");
  const id = configured.trim();
  if (!platformWorkbook_ || platformWorkbook_.getId() !== id) platformWorkbook_ = SpreadsheetApp.openById(id);
  return platformWorkbook_;
}
function hasRole_(roles, role) {
  return (Array.isArray(roles) ? roles : String(roles).split(",").map((entry) => entry.trim())).includes(role);
}
function response_(ok, code, message, data) {
  const result = { ok };
  if (code) result.code = code;
  if (message) result.message = message;
  if (data !== undefined) result.data = data;
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
