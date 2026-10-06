# Tuesday Club Runs

The existing Next.js App Router / TypeScript application, backed by Google Sheets and a locked, server-only Apps Script gateway. Google sign-in and email magic links identify the **same active club member**; neither creates club membership or grants roles.

## Local development and isolated preview

```sh
npm ci
cp .env.example .env.local
npm run dev
```

For a populated preview set `CLUB_DEMO_MODE=true`. Demo personas, names, bookings and attendance are synthetic, use reserved `example.com` emails, and never authenticate against or mutate the live workbook. Demo state is intentionally process-local and resets on restart; it is not production persistence. Use a separate preview deployment, **never enable this flag on the live member application**. Live configuration or authentication errors do not fall back to demo data.

The preview has 13 groups with varied occupancy and waitlists plus roughly 12 historical weeks. Its current week is relative to the upcoming Tuesday, not a fixed expired date.

Available checks: `npm test`, `npm run lint`, `npm run build`. External services are mocked in automated tests; passing them does not verify Google OAuth, SMTP delivery, Apps Script permissions or a real workbook.

## Owner confirmation required before publication

The scaffold's Riverside Pavilion, Meadow Lane and Tuesday 18:30 are **editable DEMO assumptions**, not confirmed club facts. Europe/London is an explicit UK-oriented demo timezone, not a silent US timezone default. Confirm the location, IANA timezone, Tuesday start and cutoff, every configured group's name/distance/pace, and eligible leadership roles before using live data. Scheduling uses club-local dates and accounts for daylight saving; do not hard-code a UTC offset.

Configure 1–20 groups with unique positive numbers up to 20 in the workbook; decimal labels such as `1.5` are supported. Each group can hold 1–20 confirmed people, including its leader and optional sweeper; a person filling both roles consumes one place. Membership can have overlapping comma-separated roles: `runner`, `leader`, `sweeper`, `admin`. Display names are never identity keys.

## Authentication setup (NextAuth v4)

1. Generate `NEXTAUTH_SECRET` with `openssl rand -base64 32`; keep it stable and identical across instances. This application requires that explicit setting; do not rely on the old scaffold's `AUTH_SECRET` alias.
2. Set `NEXTAUTH_URL` to the application's canonical origin, e.g. `https://runs.example.org`; use `http://localhost:3000` locally. Callback redirects are restricted to that origin.
3. Create a Google OAuth web client. Register `/api/auth/callback/google` on each explicitly allowed application origin as an authorized redirect URI. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. A non-Gmail Google account is supported, but Google's `email_verified` must be true.
4. Configure SMTP with `EMAIL_SERVER_HOST`, `EMAIL_SERVER_PORT`, `EMAIL_SERVER_USER`, `EMAIL_SERVER_PASSWORD`, and `EMAIL_FROM` (your verified sender). For Brevo, use `smtp-relay.brevo.com` on port `587`, with the SMTP login and SMTP key. Configure the sender's SPF/DKIM/DMARC with your mail provider; test spam filtering and delivery. Leaving SMTP unset disables only the email option, not otherwise configured Google sign-in.
5. Set up the persistent protected auth storage and deploy **all three** Apps Script files as described below. Email links cannot work without persistent adapter storage, even with JWT sessions.
6. Add trusted club users before testing live login. Normalize email with trim/lowercase; duplicate normalized emails or stable IDs are rejected. Do not use demo accounts for live membership.

Sign-in, check-inbox/resend and error screens live under `/auth`. Email requests use a generic response, including nonmembers and cooldown requests. Tokens expire after 15 minutes. NextAuth generates cryptographically random tokens and hashes them before persistence; the gateway consumes tokens under the shared lock, so replay or simultaneous redemption cannot reuse them. Google and email must resolve to the same trusted stable member ID. OAuth account linking is not globally enabled for untrusted emails.

Only trusted active membership supplies roles. Protected pages/data and mutations recheck membership, including after an account is deactivated. Roster APIs expose display names, not other members' email addresses; personal attendance/history is limited to its owner except assigned leaders' rosters and administrators' operational access. Auth records, SMTP credentials, tokens and the gateway secret are never returned in club snapshots.

## Server configuration and Apps Script deployment

Keep all credentials server-only; never use `NEXT_PUBLIC_` for secrets. Set `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `APPS_SCRIPT_GATEWAY_URL` and `APPS_SCRIPT_GATEWAY_SECRET`. Share only the club workbook with the service-account email using read access; the web application performs writes through Apps Script, not the browser or service account.

Create a **bound** Apps Script project in the workbook, use the V8 runtime, and copy `apps-script/Code.gs`, `apps-script/Storage.gs` and `apps-script/Auth.gs`. In Project Settings → Script Properties set:

- `GATEWAY_SECRET`: a separately generated random secret; use the same value in `APPS_SCRIPT_GATEWAY_SECRET`.
- `SPREADSHEET_ID`: the workbook ID; it must equal the application's `GOOGLE_SHEET_ID`. Web Apps open it explicitly with `SpreadsheetApp.openById()`—there is no active spreadsheet context in a deployed Web App.

Unset settings fail closed. Authorize the owner-run setup functions for spreadsheet access, identity and workbook backup copying. Deploy a Web App executing as the workbook owner. The Next.js server must be able to reach its HTTPS `/exec` URL; plaintext gateway URLs are rejected. If your Workspace can provide authenticated access, restrict it accordingly; a public gateway must still reject every request lacking the shared secret. Never expose that secret in client code.

After changing scripts, create a **new deployment version**, update the existing deployment to that version and verify the configured `/exec` URL. A source save alone does not update a deployed Web App. Protect the workbook and auth sheets from ordinary members; hidden tabs alone are not access control. Membership and booking sheets are not intended for concurrent manual editing while the service is live.

### OAuth callback troubleshooting

`adapter_error_getUserByAccount` followed by `OAUTH_CALLBACK_HANDLER_ERROR` means the persistent account lookup failed; a missing account normally returns `null` and is not an error. In development, the adapter log includes only allowlisted gateway codes or an invalid-record label, never upstream messages or identity details. Production logs remain generic.

- `NON_JSON_RESPONSE`: the gateway returned HTML or another non-JSON body, even if its HTTP status was 200. Verify the current Web App `/exec` URL, execute-as-owner setting, deployment version and access policy. The server sends a shared secret, not a signed-in Google browser session; a browser successfully opening the URL does not prove server access. If Workspace policy forbids server-reachable access, use an authenticated gateway integration rather than weakening the policy.
- `UNAUTHORIZED`: match the server's `APPS_SCRIPT_GATEWAY_SECRET` to the script's `GATEWAY_SECRET`.
- `WORKBOOK_MISMATCH`: match `GOOGLE_SHEET_ID` to the script's `SPREADSHEET_ID`.
- `NOT_CONFIGURED` or `UNKNOWN_OPERATION`: deploy `Code.gs`, `Storage.gs` and `Auth.gs` together as a new version, and verify the script properties.
- `AUTH_UNAVAILABLE`: check owner authorization, spreadsheet access, hidden auth-sheet headers and protections in Apps Script. Do not delete existing auth records to work around a setup error.
- `INVALID_RESPONSE` or `invalid auth record`: check the deployed response format or stored record schema without copying private records into logs.

### Persistent auth storage

The adapter lazily creates `AuthUsers`, `AuthAccounts`, `AuthSessions` and `AuthEmailRequests`, each with `key`, `record` columns. The second column is an auth-only JSON record. They are hidden and write-protected for the executing owner. **Do not grant members workbook read access**: sheet protection does not restrict readers. These records are never part of a platform snapshot or roster API. `AuthSessions` supports the adapter interface; this application uses NextAuth's JWT sessions.

Email request records contain only the hashed verification token, normalized identifier, expiry, issuance timestamp, eligibility and consumed marker. The persistent limit is five requests per address per hour with a 60-second resend cooldown, including denied and nonmember requests. Both provider sending and adapter persistence coordinate on the same token record under the lock. Consumption commits before returning the token; a failure afterward errs toward consuming a link rather than making replay possible. A request can therefore require a new link after an uncertain redemption failure.

Keep SMTP and OAuth tokens out of logs, monitor gateway quotas and auth-record growth, and restrict backup access just as strictly as the live workbook. Membership remains separate: after canonical migration, authentication reads committed membership rather than the legacy `Members` table or lagging `Users` display projection.

Next.js incoming-request logging is disabled because email callback URLs carry bearer tokens; auth responses use `Referrer-Policy: no-referrer` and are not cacheable. Also configure your hosting/reverse proxy, mail provider and observability tools to omit/redact auth query strings and request bodies. Application settings cannot sanitize a separately managed proxy's access logs.

## Booking and management rules

- One active booking per person per week, whether confirmed or waitlisted. Full destinations automatically waitlist.
- Leaving a confirmed place promotes the earliest eligible waitlisted runner only while booking is open. Ties use stable booking IDs. Once the cutoff passes, withdrawal and promotion are closed; leaders record actual attendance separately.
- Switching and administrator moves are one coordinated operation. A full destination puts the mover on its waitlist; a rejected destination, stale version or invalid assignment leaves the original booking intact. Leadership cannot be moved as an ordinary runner or silently displaced.
- Leadership assignments must be eligible, maintain the one-booking invariant and cannot overbook; leader/sweeper occupancy is deduplicated.
- Only assigned weekly leaders (or admins) can edit that group's route, sweeper and attendance. Admins manage users, leaders, lifecycle and moves. Server authorization is independent of navigation visibility.
- Draft creation copies the 13 definitions. Optional copied routes are marked for review before publication. Repeated creation must not duplicate weekly tabs. Only one future published week is allowed.
- Clients send a stable UUID request ID for each logical mutation and reuse it for uncertain retries. Versions detect stale submissions; refresh before a new operation. The response refreshes authoritative counts and queue position. The lock is the capacity authority, not a cached browser count.
- Cancelled weeks retain history but are excluded from participation analytics. Archive completed weeks without deleting booking or attendance records.

## Analytics and privacy

Bookings are intent; attendance is an explicitly recorded outcome, not inferred from a booking. Missing attendance is **unknown**, not zero. Booking utilisation uses confirmed places / available group capacity; attendance utilisation is separate. Cancelled weeks are excluded and dashboards disclose the range and denominator. Waitlist joins and promotions come from audit events, so a cleared final queue does not erase demand. Favourite group derives from actual attended runs, with deterministic ties, and remains unknown without attendance.

## Production smoke checklist — owner must run

- Back up a staging workbook; perform migration there first and compare IDs, roles, historical totals and unknown attendance.
- Confirm real club configuration and 13 definitions before publication; validate UK DST transitions and cutoff locally.
- Check Google sign-in (verified Gmail and non-Gmail accounts), email-only sign-in, cross-provider identity, sign-out, expired/replayed links and resend cooldown.
- Confirm generic nonmember/deactivated responses and direct provider-endpoint throttling; deactivate a signed-in member and verify mutations fail.
- Simulate competing last-place requests from two browsers, retries, FIFO promotion, rejected switch and full-destination move.
- Verify leader/runner cannot call admin operations directly, and leaders cannot edit unassigned groups.
- Confirm member-only rosters, no email/token/secret leakage, own-history privacy, mobile keyboard/focus and visible queue refresh.
- Verify draft retry/tab uniqueness, copied-route review, publication policy, cancellation, attendance and archival.
- Test SMTP delivery and gateway recovery/error handling. Monitor Apps Script quotas and workbook growth.

No production deployment or destructive real-workbook migration is part of this change. Credentials, sender verification, workbook permissions, club configuration and the real-service smoke checks remain owner setup responsibilities.

## Verification limits

Mock-backed tests and HTTP preview checks do not prove delivery or access to a live service. This session could not perform interactive browser verification because the browser tool required unavailable authorization. Automated review tooling was also unavailable, and CodeQL analysis failed; its zero-alert output is **not** a clean security scan. A supplemental read-only code review was performed. Run browser and security validation in an appropriately configured environment before production use.

NextAuth remains on v4. The Next.js patch update addresses existing runtime advisories; this is not a framework migration. Nodemailer is explicitly installed for SMTP, with a package override keeping NextAuth on the same transport version. Remaining existing transitive/development advisories should be reviewed with `npm audit` rather than assuming every dependency is vulnerability-free.
