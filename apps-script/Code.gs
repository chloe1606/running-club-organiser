/**
 * Deploy this project as a Web App that only the Next.js server can call.
 * Store GATEWAY_SECRET in Apps Script Properties, not in this source file.
 */
function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    if (request.secret !== PropertiesService.getScriptProperties().getProperty("GATEWAY_SECRET")) {
      return response_(false, "UNAUTHORIZED", "Invalid gateway credentials.");
    }
    return withLock_(() => dispatch_(request));
  } catch (error) {
    console.error(error);
    return response_(false, "INTERNAL_ERROR", error.message || "Unexpected gateway error.");
  }
}

function dispatch_(request) {
  switch (request.operation) {
    case "book":
      return book_(request);
    case "publishRun":
      return publishRun_(request);
    case "cancelRun":
      return cancelRun_(request);
    case "archiveRun":
      return archiveRun_(request);
    default:
      return response_(false, "UNKNOWN_OPERATION", "Unsupported operation.");
  }
}

function withLock_(operation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return response_(false, "LOCK_TIMEOUT", "Another update is in progress. Please try again.");
  }
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

function book_(request) {
  const member = findOne_("Members", "email", request.email);
  if (!member || member.active !== "TRUE" || !hasRole_(member.roles, "runner")) {
    return response_(false, "FORBIDDEN", "Only active members can make bookings.");
  }

  const run = findOne_("Runs", "runId", request.runId);
  const group = findOne_("Groups", "groupId", request.groupId);
  if (!run || !group || group.runId !== run.runId) {
    return response_(false, "NOT_FOUND", "The selected run or group no longer exists.");
  }
  if (!versionsMatch_(run, request.runVersion) || !versionsMatch_(group, request.groupVersion)) {
    return response_(false, "STALE_VERSION", "This run changed. Refresh and choose again.");
  }

  const now = new Date();
  if (run.status !== "published" || now < new Date(run.bookingOpensAt) || now >= new Date(run.bookingClosesAt)) {
    return response_(false, "BOOKING_CLOSED", "Booking is not currently open.");
  }
  const bookings = records_("Bookings");
  if (bookings.some((b) => b.runId === run.runId && b.memberId === member.memberId && b.status !== "cancelled")) {
    return response_(false, "DUPLICATE_BOOKING", "You already have a booking for this run.");
  }

  const confirmed = bookings.filter((b) => b.groupId === group.groupId && b.status === "confirmed").length;
  append_("Bookings", {
    bookingId: Utilities.getUuid(),
    runId: run.runId,
    groupId: group.groupId,
    memberId: member.memberId,
    status: confirmed < Number(group.capacity) ? "confirmed" : "waitlisted",
    bookingSource: "member",
    bookedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 1,
  });
  incrementVersion_(group);
  incrementVersion_(run);
  return response_(true, null, null, { status: confirmed < Number(group.capacity) ? "confirmed" : "waitlisted" });
}

function publishRun_(request) {
  const admin = findOne_("Members", "email", request.email);
  if (!admin || admin.active !== "TRUE" || !hasRole_(admin.roles, "admin")) {
    return response_(false, "FORBIDDEN", "Only administrators can publish a run.");
  }
  const run = findOne_("Runs", "runId", request.runId);
  if (!run || !versionsMatch_(run, request.runVersion)) {
    return response_(false, "STALE_VERSION", "This run changed. Refresh and try again.");
  }
  if (run.status !== "draft" || new Date(run.startsAt) <= new Date()) {
    return response_(false, "INVALID_PUBLISH", "Only future draft runs can be published.");
  }
  const anotherPublishedRun = records_("Runs").some((candidate) =>
    candidate.runId !== run.runId &&
    candidate.status === "published" &&
    new Date(candidate.startsAt) > new Date());
  if (anotherPublishedRun) {
    return response_(false, "PUBLISHED_RUN_EXISTS", "Another future run is already published.");
  }
  update_(run, { status: "published", version: Number(run.version) + 1 });
  return response_(true, null, null, { status: "published" });
}

function cancelRun_(request) {
  const admin = findOne_("Members", "email", request.email);
  if (!admin || admin.active !== "TRUE" || !hasRole_(admin.roles, "admin")) {
    return response_(false, "FORBIDDEN", "Only administrators can cancel a run.");
  }
  const run = findOne_("Runs", "runId", request.runId);
  if (!run || !versionsMatch_(run, request.runVersion)) {
    return response_(false, "STALE_VERSION", "This run changed. Refresh and try again.");
  }
  if (new Date(run.startsAt) <= new Date() || !["draft", "published"].includes(run.status) || !request.cancellationReason) {
    return response_(false, "INVALID_CANCELLATION", "Only future draft or published runs with a reason can be cancelled.");
  }
  update_(run, { status: "cancelled", cancellationReason: request.cancellationReason, version: Number(run.version) + 1 });
  records_("Bookings")
    .filter((booking) => booking.runId === run.runId && booking.status !== "cancelled")
    .forEach((booking) => update_(booking, { status: "cancelled", updatedAt: new Date().toISOString(), version: Number(booking.version) + 1 }));
  return response_(true, null, null, { status: "cancelled" });
}

function archiveRun_(request) {
  const run = findOne_("Runs", "runId", request.runId);
  if (!run || run.status === "archived" || new Date(run.startsAt) > new Date()) {
    return response_(false, "INVALID_ARCHIVE", "This run cannot be archived yet.");
  }
  const archiveKey = `run:${run.runId}`;
  if (!findOne_("Archives", "archiveKey", archiveKey)) {
    const groups = records_("Groups").filter((group) => group.runId === run.runId);
    const bookings = records_("Bookings");
    groups.forEach((group) => {
      append_("Archives", {
        archiveKey,
        runId: run.runId,
        groupId: group.groupId,
        groupNumber: group.groupNumber,
        confirmedCount: bookings.filter((booking) => booking.groupId === group.groupId && booking.status === "confirmed").length,
        waitlistedCount: bookings.filter((booking) => booking.groupId === group.groupId && booking.status === "waitlisted").length,
        archivedAt: new Date().toISOString(),
      });
    });
  }
  update_(run, { status: "archived", version: Number(run.version) + 1 });
  return response_(true, null, null, { status: "archived" });
}

function records_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values.filter((row) => row.some(String)).map((row, index) => {
    const record = { _sheet: sheet, _row: index + 2 };
    headers.forEach((header, column) => record[header] = row[column]);
    return record;
  });
}

function findOne_(sheet, field, value) {
  return records_(sheet).find((record) => String(record[field]) === String(value));
}

function append_(sheetName, values) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(headers.map((header) => values[header] || ""));
}

function update_(record, changes) {
  const headers = record._sheet.getRange(1, 1, 1, record._sheet.getLastColumn()).getValues()[0];
  headers.forEach((header, index) => {
    if (Object.prototype.hasOwnProperty.call(changes, header)) {
      record._sheet.getRange(record._row, index + 1).setValue(changes[header]);
    }
  });
}

function incrementVersion_(record) {
  update_(record, { version: Number(record.version) + 1 });
}

function versionsMatch_(record, expected) {
  return Number(record.version) === Number(expected);
}

function hasRole_(roles, role) {
  return String(roles).split(",").map((entry) => entry.trim()).includes(role);
}

function response_(ok, code, message, data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok, code, message, data }))
    .setMimeType(ContentService.MimeType.JSON);
}
