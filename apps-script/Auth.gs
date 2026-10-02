/**
 * Auth-only protected sheets; never store credentials in Members.
 * authDispatch_ must be invoked inside the same script lock as club mutations.
 * A journal entry is one JSON cell, committed and flushed before returning.
 * Consume marks the entry irreversibly before returning it, even after a crash.
 */
function authDispatch_(request) {
  try {
    let result = null;
    switch (request.operation) {
      case "authGetUser":
        result = authUser_(request.id);
        break;
      case "authGetUserByEmail": {
        const member = authMember_(request.email);
        result = member ? authUser_(member.memberId) : null;
        break;
      }
      case "authGetUserByAccount": {
        const account = authRead_("AuthAccounts", authAccountKey_(request.account));
        result = account ? authUser_(account.data.userId) : null;
        break;
      }
      case "authCreateUser": {
        const member = authMember_(request.user.email);
        if (!member) throw new Error("Membership denied.");
        const key = "user:" + String(member.memberId);
        const existing = authRead_("AuthUsers", key);
        result = Object.assign({}, existing ? existing.data : {}, {
          id: String(member.memberId),
          email: authEmail_(member.email),
          name: String(member.displayName),
          image: existing ? existing.data.image : (request.user.image || null),
          emailVerified: existing && existing.data.emailVerified || request.user.emailVerified || null,
        });
        authWrite_("AuthUsers", key, result);
        break;
      }
      case "authUpdateUser": {
        result = authUser_(request.user.id);
        if (!result) throw new Error("Membership denied.");
        if (request.user.email && authEmail_(request.user.email) !== result.email) throw new Error("Identity changes denied.");
        ["name", "image", "emailVerified"].forEach((field) => {
          if (Object.prototype.hasOwnProperty.call(request.user, field)) result[field] = request.user[field];
        });
        authWrite_("AuthUsers", "user:" + result.id, result);
        break;
      }
      case "authDeleteUser":
        authWrite_("AuthUsers", "user:" + request.id, null);
        authRows_("AuthAccounts").filter((row) => row.data && row.data.userId === request.id)
          .forEach((row) => authWrite_("AuthAccounts", row.key, null));
        authRows_("AuthSessions").filter((row) => row.data && row.data.userId === request.id)
          .forEach((row) => authWrite_("AuthSessions", row.key, null));
        break;
      case "authLinkAccount": {
        const account = request.account;
        if (account.provider !== "google" || account.type !== "oauth" || !authUser_(account.userId)) throw new Error("Account denied.");
        const key = authAccountKey_(account);
        const existing = authRead_("AuthAccounts", key);
        if (existing && existing.data.userId !== account.userId) throw new Error("Account conflict.");
        authWrite_("AuthAccounts", key, account);
        break;
      }
      case "authUnlinkAccount":
        authWrite_("AuthAccounts", authAccountKey_(request.account), null);
        break;
      case "authCreateSession":
        if (!authUser_(request.session.userId)) throw new Error("Membership denied.");
        if (!authValidDate_(request.session.expires)) throw new Error("Invalid expiry.");
        authWrite_("AuthSessions", "session:" + request.session.sessionToken, request.session);
        result = request.session;
        break;
      case "authGetSessionAndUser": {
        const row = authRead_("AuthSessions", "session:" + request.sessionToken);
        const user = row ? authUser_(row.data.userId) : null;
        if (user && authValidDate_(row.data.expires) && new Date(row.data.expires).getTime() > Date.now()) {
          result = { session: row.data, user: user };
        }
        break;
      }
      case "authUpdateSession": {
        const key = "session:" + request.session.sessionToken;
        const row = authRead_("AuthSessions", key);
        if (row && authUser_(row.data.userId)) {
          if (request.session.userId && request.session.userId !== row.data.userId) throw new Error("Identity changes denied.");
          result = Object.assign({}, row.data, request.session);
          if (!authValidDate_(result.expires)) throw new Error("Invalid expiry.");
          authWrite_("AuthSessions", key, result);
        }
        break;
      }
      case "authDeleteSession":
        authWrite_("AuthSessions", "session:" + request.sessionToken, null);
        break;
      case "authPrepareEmail":
        result = authPrepareEmail_(request);
        break;
      case "authConsumeToken":
        result = authConsumeToken_(request);
        break;
      default:
        return response_(false, "UNKNOWN_OPERATION", "Unsupported authentication operation.");
    }
    return response_(true, null, null, result);
  } catch {
    // Metadata must not expose email addresses, SMTP credentials or bearer links.
    return response_(false, "AUTH_UNAVAILABLE", "Authentication is unavailable.");
  }
}

function authEmail_(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@,"<>]+@[^\s@,"<>]+\.[^\s@,"<>]+$/.test(email)) throw new Error("Invalid email.");
  return email;
}

function authMember_(email) {
  const address = authEmail_(email);
  const members = loadPlatformState_().snapshot.members.map((member) => ({
    memberId: member.id, email: member.email, displayName: member.name, active: member.active,
  }));
  const matches = members.filter((member) => String(member.email).trim().toLowerCase() === address);
  if (matches.length !== 1) return null;
  const member = matches[0];
  if (String(member.active).toUpperCase() !== "TRUE" || !member.memberId || !member.displayName) return null;
  if (members.filter((candidate) => String(candidate.memberId) === String(member.memberId)).length !== 1) return null;
  return member;
}

function authUser_(id) {
  const row = authRead_("AuthUsers", "user:" + String(id));
  if (!row) return null;
  const member = authMember_(row.data.email);
  return member && String(member.memberId) === String(id) ? row.data : null;
}

function authAccountKey_(account) {
  if (!account || account.provider !== "google" || typeof account.providerAccountId !== "string" || !account.providerAccountId) {
    throw new Error("Invalid account.");
  }
  return "account:" + JSON.stringify([account.provider, account.providerAccountId]);
}

function authValidDate_(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function authPrepareEmail_(request) {
  const identifier = authEmail_(request.identifier);
  if (!/^[a-f0-9]{64}$/.test(String(request.token))) throw new Error("Invalid token.");
  const now = Date.now();
  if (!authValidDate_(request.expires) || new Date(request.expires).getTime() <= now ||
      new Date(request.expires).getTime() > now + 15 * 60 * 1000) throw new Error("Invalid expiry.");
  const key = "token:" + request.token;
  const existing = authRead_("AuthEmailRequests", key);
  if (existing) {
    if (existing.data.identifier !== identifier) throw new Error("Token conflict.");
    let member = null;
    try { member = authMember_(identifier); } catch { /* Membership lookup must fail closed. */ }
    return { allowed: existing.data.allowed && !existing.data.consumed &&
      new Date(existing.data.expires).getTime() > now && Boolean(member) };
  }
  const attempts = authRows_("AuthEmailRequests").filter((row) => row.data &&
    row.data.identifier === identifier && row.data.createdAt > now - 60 * 60 * 1000);
  const throttled = attempts.length >= 5 || attempts.some((row) => row.data.createdAt > now - 60 * 1000);
  let member = null;
  try { member = authMember_(identifier); } catch { /* Fail closed with the same request outcome. */ }
  const allowed = !throttled && Boolean(member);
  // Denied and nonmember requests also consume the persistent throttle budget.
  authWrite_("AuthEmailRequests", key, {
    identifier: identifier, token: request.token, expires: request.expires,
    createdAt: now, allowed: allowed, consumed: null,
  });
  return { allowed: allowed };
}

function authConsumeToken_(request) {
  const identifier = authEmail_(request.identifier);
  if (!/^[a-f0-9]{64}$/.test(String(request.token))) return null;
  const key = "token:" + request.token;
  const row = authRead_("AuthEmailRequests", key);
  if (!row || row.data.identifier !== identifier || row.data.consumed) return null;
  const entry = row.data;
  entry.consumed = Date.now();
  // One durable row mutation, under the script lock, before returning anything.
  // A failure after committing consumes the token rather than risking replay.
  authWrite_("AuthEmailRequests", key, entry);
  if (!entry.allowed || new Date(entry.expires).getTime() <= Date.now() || !authMember_(identifier)) return null;
  return { identifier: identifier, token: entry.token, expires: entry.expires };
}

function authSheet_(name) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, 2).setValues([["key", "record"]]);
  }
  // Reapply protection after an interrupted first-time setup as well.
  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const protection = protections[0] || sheet.protect();
  protection.setDescription("Server-only authentication storage").setWarningOnly(false);
  const owner = Session.getEffectiveUser();
  protection.addEditor(owner);
  protection.removeEditors(protection.getEditors().filter((editor) => editor.getEmail() !== owner.getEmail()));
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
  if (!sheet.isSheetHidden()) sheet.hideSheet();
  SpreadsheetApp.flush();
  const headers = sheet.getRange(1, 1, 1, 2).getValues()[0];
  if (headers[0] !== "key" || headers[1] !== "record") throw new Error("Invalid auth storage.");
  return sheet;
}

function authRows_(name) {
  const sheet = authSheet_(name);
  return sheet.getDataRange().getValues().slice(1).map((row, index) => ({
    key: String(row[0]), data: row[1] ? JSON.parse(String(row[1])) : null, row: index + 2,
  }));
}

function authRead_(name, key) {
  const matches = authRows_(name).filter((row) => row.key === key && row.data);
  if (matches.length > 1) throw new Error("Ambiguous auth record.");
  return matches[0] || null;
}

function authWrite_(name, key, data) {
  const sheet = authSheet_(name);
  const rows = authRows_(name).filter((row) => row.key === key);
  if (rows.length > 1) throw new Error("Ambiguous auth record.");
  const row = rows.length ? rows[0].row : sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, 2).setNumberFormat("@").setValues([[key, JSON.stringify(data)]]);
  SpreadsheetApp.flush();
}
