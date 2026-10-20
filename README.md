# Tuesday Club Runs

The Next.js App Router / TypeScript application is backed by Google Sheets and a locked, server-only Apps Script gateway. Clerk manages invitation-only username/email-and-password login. Only active Google Sheets membership grants club access and roles; a Clerk account alone does not.

## Local development and isolated preview

```sh
npm ci
cp .env.example .env.local
npm run dev
```

For a populated preview set `CLUB_DEMO_MODE=true`. Demo personas, names, bookings and attendance are synthetic, use reserved `example.com` emails, and never authenticate against or mutate the live workbook. The demo role selector includes a signed-out public view that shows run information without runner rosters. Demo state is intentionally process-local and resets on restart; it is not production persistence. Use a separate preview deployment, **never enable this flag on the live member application**. Live configuration or authentication errors do not fall back to demo data.

The preview has 13 groups with varied occupancy and waitlists plus roughly 12 historical weeks. Its current week is relative to the upcoming Tuesday, not a fixed expired date. Runner view opens the current bookable week first, tucks past runs into a disclosure and selector, and labels public status Bookings open, Bookings closed or Cancelled. Own bookings are prominent; a waitlist place is explicitly not confirmed.

Available checks: `npm test`, `npm run lint`, `npm run build`. External services are mocked in automated tests; passing them does not verify Clerk email delivery, Apps Script permissions or a real workbook.

## Owner confirmation required before publication

The scaffold's Riverside Pavilion, Meadow Lane and Tuesday 18:30 are **editable DEMO assumptions**, not confirmed club facts. Europe/London is an explicit UK-oriented demo timezone, not a silent US timezone default. Confirm the location, IANA timezone, Tuesday start and cutoff, every configured group's name/distance/pace, and eligible leadership roles before using live data. Scheduling uses club-local dates and accounts for daylight saving; do not hard-code a UTC offset.

Configure 1–20 groups with unique positive numbers up to 20 in the workbook; decimal labels such as `1.5` are supported. Each group can hold 1–20 confirmed people, including its leader and optional sweeper; a person filling both roles consumes one place. Membership can have overlapping comma-separated roles: `runner`, `leader`, `sweeper`, `admin`. Display names are never identity keys.

## Authentication setup (Clerk)

1. Use the selected Clerk application, `app_3KxEHInwVYZ3iSq5DoNr41ctENE`. CLI access requires `npx -y clerk@latest auth login` in your own terminal. The project is already initialised; do not create a replacement application.
2. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and the server-only `CLERK_SECRET_KEY` from the same Clerk instance in local/hosting configuration. Set `APP_URL` to the canonical application origin, e.g. `https://runs.example.org` or `http://localhost:3000`. Sign-in and account setup use `/sign-in` and `/sign-up`.
3. In Clerk's **User & authentication**, require username, password and a verified email. Allow username or email as the password-login identifier, disable Google/social sign-in and email-link/code sign-in, and keep email-code verification and password recovery. Device trust may also request an email verification code on a new device; this is not magic-link login.
4. Use **Restricted / invitation-only** sign-up. In Admin > Club members > Add member, **Send account invitation** is selected by default for active members. Membership is saved first, then Clerk emails an invitation linking to the site's `/sign-up` page using the exact saved roster email. Existing accounts and valid pending invitations are skipped. Uncheck the option to save without emailing; inactive members are never invited. Invitations create login accounts, not club membership.
5. Clerk delivers authentication emails, including invitations, verification and password recovery. The app no longer uses Google OAuth, NextAuth or SMTP for login; old `NEXTAUTH_*`, `GOOGLE_CLIENT_*` and `EMAIL_*` login variables can be retired from deployment configuration. Keep Google Sheets service-account and gateway configuration.
6. Before production, create/configure the Clerk production instance, verify your domain and required DNS records, apply the same invitation/password settings, set production keys, and test with a staging workbook. Development and production users/settings are separate; this change does not configure or deploy production.

The development Clerk instance is configured for invitation-only username/password login with Google and passwordless sign-in disabled. Account creation requires a verified email matching active club membership. On the first successful member lookup the server binds Clerk's `externalId` to the existing stable club member ID. Subsequent requests require that same ID and the current verified primary email; changing an email cannot switch club identities. A conflicting binding requires organiser intervention, never automatic reassignment.

If sending fails, the new member remains saved and the form offers **Retry invitation**. Retry checks Clerk again, so an invitation accepted by Clerk before a network timeout is not sent twice. Retries require a current active administrator and active target membership; no roles or email destinations are trusted from the browser. Demo mode simulates the result without contacting Clerk. Live-key invitations are blocked in local development and Vercel previews; use matching test keys there and matching live keys on the HTTPS production site. `APP_URL` must be configured for invitation redirects. No bulk invitation or automatic emails on member edits are included. To invite existing members (or recover after leaving the retry screen), use Clerk's Invitations dashboard.

Clerk's built-in Frontend API proxy is enabled at `/__clerk`, including its static asset paths. The root layout explicitly sets `ClerkProvider proxyUrl="/__clerk"` so browser scripts and requests use the current app's origin instead of an unavailable `clerk.*` subdomain. No browser proxy environment variable or separate Vercel rewrite is needed. Remove any stale `NEXT_PUBLIC_CLERK_PROXY_URL` override to keep server configuration consistent with this same-origin path. Deploy, then configure `https://your-production-domain/__clerk` in Clerk Production > Domains > Frontend API > Set proxy configuration. Use matching development keys locally and production keys on the production deployment. Explicit demo mode continues to bypass Clerk.

Existing member IDs, bookings, attendance and roles remain in Sheets unchanged. There are no existing password hashes to import. Previous NextAuth sessions and magic links are not accepted; every member must set up Clerk credentials. Legacy `/auth/signin` and `/auth/check-inbox` links redirect to Clerk sign-in; the old NextAuth API endpoints have been removed.

Only trusted active membership supplies roles. Protected pages/data and mutations recheck membership, including after an account is deactivated. Roster APIs expose display names, not other members' email addresses; personal attendance/history is limited to its owner except assigned leaders' rosters and administrators' operational access. Clerk credentials, sessions, tokens and the gateway secret are never returned in club snapshots. The public runs page remains available without login; explicit demo mode bypasses Clerk and never touches the live workbook.

## Server configuration and Apps Script deployment

Keep all credentials server-only; never use `NEXT_PUBLIC_` for secrets. Set `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `APPS_SCRIPT_GATEWAY_URL` and `APPS_SCRIPT_GATEWAY_SECRET`. Share only the club workbook with the service-account email using read access; the web application performs writes through Apps Script, not the browser or service account.

Create a **bound** Apps Script project in the workbook, use the V8 runtime, and copy `apps-script/Code.gs`, `apps-script/Storage.gs` and `apps-script/Auth.gs`. In Project Settings → Script Properties set:

- `GATEWAY_SECRET`: a separately generated random secret; use the same value in `APPS_SCRIPT_GATEWAY_SECRET`.
- `SPREADSHEET_ID`: the workbook ID; it must equal the application's `GOOGLE_SHEET_ID`. Web Apps open it explicitly with `SpreadsheetApp.openById()`—there is no active spreadsheet context in a deployed Web App.

Unset settings fail closed. Authorize the owner-run setup functions for spreadsheet access, identity and workbook backup copying. Deploy a Web App executing as the workbook owner. The Next.js server must be able to reach its HTTPS `/exec` URL; plaintext gateway URLs are rejected. If your Workspace can provide authenticated access, restrict it accordingly; a public gateway must still reject every request lacking the shared secret. Never expose that secret in client code.

After changing scripts, create a **new deployment version**, update the existing deployment to that version and verify the configured `/exec` URL. A source save alone does not update a deployed Web App. Protect the workbook and auth sheets from ordinary members; hidden tabs alone are not access control. Membership and booking sheets are not intended for concurrent manual editing while the service is live.

### Authentication troubleshooting and legacy data

Run `npx -y clerk@latest doctor` for integration checks. If a signed-in user sees **Club membership required**, verify their primary Clerk email, active roster entry and stable `externalId` binding. Do not grant roles in editable Clerk user metadata; Sheets remains the authority. Provider or workbook failures show an explicit service error, never demo data.

Keep the existing Apps Script deployment and legacy auth tabs protected. `Auth.gs` is retained for compatibility with the workbook's storage tooling, but the web app no longer invokes its NextAuth operations. No legacy auth records are deleted or migrated automatically. Back up and plan any later cleanup separately. **Do not grant ordinary members workbook read access**; hiding/protecting tabs is not reader access control.

Incoming request logging stays disabled and authentication pages use `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. Configure hosting/reverse-proxy and observability tools to redact auth parameters too.

## Optional weekly automation

Automation is **off until an administrator enables it** in Admin > Weekly settings. The default publication schedule is **Sunday 18:00, Europe/London**; the time is configurable in Admin and the timezone comes from the existing club configuration. Daylight-saving changes use club-local dates, not a fixed UTC offset. The compact Next Tuesday summary shows the actual selected week's venue, time, status and eligible leaders X/Y, with missing group numbers and nearby import, location/time and cancellation controls. Clicking an upcoming draft selects that week. Settings, manual actions, member management and analytics remain collapsed.

When enabled, the lifecycle prepares the next eligible Tuesday draft from canonical group defaults. No bookings, leader/sweeper assignments, routes or group cancellations are copied. Enabling it prepares the draft immediately in the same locked transaction; the independent timer also prepares drafts throughout the week, not only on Sunday. Existing weeks on that date, including cancelled weeks, are never recreated. After Tuesday's standard 18:30 cutoff the next Tuesday becomes eligible.

At or after Sunday publication time, the timer publishes the upcoming draft only when every noncancelled group has an active eligible leader and no other future week is published. Routes are optional. Admin lists missing leaders and conflicting published weeks under Upcoming drafts, with **Publication blocked** once due. Resolve assignments or cancel groups that will not run; the next timer tick retries. Manual publication remains an explicit admin override using the existing lifecycle checks.

Completed published weeks archive at their following Sunday boundary, independently of whether the next draft can publish. Delayed ticks catch up on older eligible weeks. Cancelled weeks stay cancelled; drafts are not archived. Archival retains bookings, audit and recorded attendance unchanged. Attendance is optional and unrecorded outcomes stay **unknown**, never inferred present or absent. This feature sends no reminders or email.

### Owner timer setup

1. Back up and verify a staging workbook first. Copy the updated three Apps Script files into the bound project, save, and update the Web App to a new deployment version. Deploy the matching Next.js changes.
2. As the workbook owner who is also an active club administrator, run **installWeeklyAutomationTrigger()** in the Apps Script editor and authorize trigger/spreadsheet access. This installs a time-driven **runWeeklyAutomation** trigger every 15 minutes, independent of the website or anyone opening Admin. Rerunning is repeat-safe for that installing account. Install from only one owner account: Apps Script does not list other users' triggers. Check the project's Triggers page for duplicates and execution errors.
3. Sign in as an administrator and enable Weekly automation in Admin. Keep the default Sunday 18:00 or save the agreed time. The checkbox persists canonical config with a version check, UUID receipt and audit; runner/leader and anonymous requests cannot enable it. The timer setup itself does not enable it.
4. Review the automatically prepared draft, set its location/time, and import or assign weekly leaders before Sunday. Cancellation remains available. Confirm a staging Sunday execution publishes a ready draft, leaves a blocked draft untouched and archives only eligible completed published weeks.

The trigger polls eligibility, so publication normally occurs on the first successful execution at or after the configured time, not precisely to the minute. Google trigger delays, quotas and failures still apply. Disabling automation stops lifecycle changes but leaves the installed timer checking the flag and recording health. Snapshot reads do not run or persist lifecycle automation. The Admin screen cannot install or verify the owner's trigger remotely; monitor Apps Script executions. No trigger has been installed and no live workbook has been changed by this implementation.

Admin automation health shows the last successful scheduler check, next club-local Sunday publication (or an overdue publication) and blocking reasons. Each successful timer tick, including a no-op or disabled tick, commits `schedulerHealth.lastSuccessfulCheckAt` separately from settings versions and audit. Failed checks/commits do not advance it. Projection failures still use the existing recovery path; the timestamp describes the canonical check, not verified display projections. Missing health is **unverified**, and health older than 45 minutes is shown as overdue. Neither a recent timestamp nor the enabled flag proves the timer remains installed. Health is from the last fetched snapshot, not a live execution feed. Check the owner's trigger and execution log, then refresh Admin. Demo health is synthetic and labelled demo-only.

Per-week time edits require the current week version and a future draft/published week. Draft edits retain the existing cutoff-to-start lead time. Published edits retain the cutoff or move it earlier to allow at least 30 minutes before the new start, but **never later**, so closed bookings cannot reopen or silently gain a later deadline. Moving a published start back and forth does not cumulatively shorten the cutoff. Booking-open time and existing bookings are preserved; invalid windows and past starts are rejected. The selected week's actual time is displayed rather than the club default.

Demo mode uses the same rules with synthetic data and process-local commits. Enabling it prepares drafts immediately; **runDemoWeeklyAutomation()** is an explicit synthetic tick used in tests, not a persistent live scheduler. Demo snapshot reads never perform lifecycle writes. Restarting the demo resets settings and weeks.

## Weekly leaders from Google Sheets

`UserSetup` and `WeeklyLeaders` are editable input tabs: the script does not apply owner-only protection to them. After deploying the updated scripts, run `unlockClubInputSheets()` once as the workbook owner who is an active club administrator to remove existing script-created protections. Unrelated owner-created protections remain unchanged. Google Sheets workbook editing permission is still required; app roles do not grant spreadsheet access. Restrict workbook editors to trusted administrators.

Both imports validate their inputs before committing. `UserSetup` requires the exact headers `Email, Name, Role, User ID, Active, Version` and uses `configureClubPlatform()`; `WeeklyLeaders` uses the import below. Invalid data leaves stored club data unchanged. Projection recovery seeds `UserSetup` only when absent; an existing tab, including an empty one, is preserved without rewriting or appending. It is manual staging, not a synchronized copy of the protected Users projection. Before configuration import, deliberately reconcile it with canonical Users, retaining every existing ID/email, current versions and an active admin. Stale or incomplete staging must fail rather than overwrite newer membership.

Administrators can add membership in **Admin > Club members > Add member** with full name, unique normalized email, roles (runner by default) and active status. UUID and initial version are backend-generated. This creates roster membership only, not an authentication account or arbitrary sign-up; sign-in still requires active membership. Existing users can be edited in Club members. See [Admin workflows](docs/admin-workflows.md) for preview, staging preservation and health details.

The workbook supports a manually maintained **WeeklyLeaders** staging tab. It assigns existing eligible leaders to weekly groups; it does not create members or grant roles. Unlike the generated `Week_<runId>` tabs, this input tab is not overwritten by snapshot refreshes.

1. Copy the updated Apps Script files into the bound project and save, then update the Web App to a new deployment version. Deploy the updated Next.js app too. The Admin screen invokes the import through the authenticated server gateway.
2. Enable weekly automation to prepare the upcoming draft, or create an additional draft manually. Only future draft or published weeks and groups that are running can be assigned.
3. Create a tab named `WeeklyLeaders` with exactly these three columns, in this order:

	| Run Date | Group | Leader Name |
	| --- | --- | --- |
	| 2026-10-13 | 1 | Alex Smith |
	| 2026-10-13 | 2 | Priya Shah |

4. Use `YYYY-MM-DD` text or a Google Sheets date cell for Run Date. Date cells are interpreted in the configured club timezone; set the spreadsheet timezone to match. Group is the displayed group number, including decimal labels such as `1.5`. Leader Name must match an existing active member's full name with the `leader` role. Matching ignores letter case and repeated whitespace; duplicate member names reject the import rather than guessing. Rename the old `Leader Email` header to `Leader Name` and replace emails with full names.
5. Sign in as an administrator and open **Import weekly leaders** near the selected Tuesday summary. Click **Preview import** to review proposed current-to-new leader assignments and row errors. Preview is read-only and performs no backup, projection repair or canonical writes. Resolve every error before clicking **Apply leader changes**; the batch spans all staged weeks, not only the selected week. Apply validates under lock and requires the preview's fingerprint. Changed worksheet/canonical state (including a scheduler health tick) produces a stale-import response: preview again. The app refreshes its data after a successful import. Import is hidden in demo mode. The manual Apps Script `importWeeklyLeaders` function remains available for an active club administrator with workbook editing access.

Every nonempty row is checked. Duplicate date/group rows, ineligible leaders, cancelled or started weeks, capacity overflow, and existing bookings or volunteer assignments in another group reject the **entire batch**. Errors identify the worksheet row. No partial assignments are saved. Valid changes use the existing assignment rules, reserve confirmed leader places, update versions and audit records, and commit under the shared lock after a verified workbook backup. Repeating an unchanged import does not duplicate bookings or create another backup. A projection failure after commit is reported as `projectionPending`; the next snapshot refresh repairs the display tabs.

Unlisted groups retain their existing assignments. A blank name is rejected, not treated as removal; remove leaders through the Admin screen. Before importing a leader swap between groups, resolve the old assignments and any conflicting bookings in the app. Remove rows for completed or cancelled weeks before the next import. Keep workbook editing access restricted to trusted administrators; import authorization is checked again on every run. UI retries reuse the request receipt so an uncertain save cannot duplicate assignments or backups. Demo mode does not read the live workbook.

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

Admin **Group popularity** measures booking demand across all available completed published/archived weeks, not marked attendance. Cancelled runs/groups, drafts and future weeks are excluded. Average confirmed bookings include assigned volunteers and divide by every completed week that group ran, including zero-booking weeks. Average waitlist uses the final retained queue; booking fill is total confirmed bookings divided by total capacity, not an average of weekly percentages. Selected-week demand shows current noncancelled groups separately from historical averages. Attendance remains optional and is still recorded separately in leader rosters and personal history.

Bookings are intent; attendance is an explicitly recorded outcome, not inferred from a booking. Missing attendance is **unknown**, not zero. Booking utilisation uses confirmed places / available group capacity; attendance utilisation is separate. Cancelled weeks are excluded and dashboards disclose the range and denominator. Waitlist joins and promotions come from audit events, so a cleared final queue does not erase demand. Favourite group derives from actual attended runs, with deterministic ties, and remains unknown without attendance.

## Production smoke checklist — owner must run

- Back up a staging workbook; perform migration there first and compare IDs, roles, historical totals and unknown attendance.
- Confirm real club configuration and 13 definitions before publication; validate UK DST transitions and cutoff locally.
- Check invitation acceptance, username/email-and-password login, verified primary email, password recovery, sign-out and expired invitations. Confirm Google/magic-link sign-in is absent and old NextAuth sessions are not accepted.
- Confirm nonmember/deactivated accounts cannot obtain private data or mutate bookings; deactivate a signed-in member and verify mutations fail. Verify changing a Clerk email cannot switch member IDs.
- Simulate competing last-place requests from two browsers, retries, FIFO promotion, rejected switch and full-destination move.
- Verify leader/runner cannot call admin operations directly, and leaders cannot edit unassigned groups.
- Confirm member-only rosters, no email/token/secret leakage, own-history privacy, mobile keyboard/focus and visible queue refresh.
- Verify draft retry/tab uniqueness, copied-route review, publication policy, cancellation, attendance and archival.
- Test Clerk invitation, verification and password-reset delivery plus gateway recovery/error handling. Monitor Apps Script quotas and workbook growth.

No production deployment or destructive real-workbook migration is part of this change. Credentials, sender verification, workbook permissions, club configuration and the real-service smoke checks remain owner setup responsibilities.

## Verification limits

Mock-backed tests and read-only local browser checks do not prove delivery or access to a live service. They do not install or verify Google triggers, exercise production writes, or constitute a security scan. Run the owner staging smoke checklist and appropriate security validation before production use.

Clerk replaces NextAuth and Nodemailer for authentication. Review remaining dependency advisories with `npm audit` rather than assuming every dependency is vulnerability-free. Automated tests do not prove end-to-end Clerk email delivery or production configuration.
