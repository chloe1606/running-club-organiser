# Weekly operations

This guide covers how organisers prepare a week's run, assign leaders, publish
the schedule and monitor optional automation. Test changes with a staging
workbook before applying them to a live club.

## Configure the club

Set the real club's location, IANA timezone, Tuesday start and booking cutoff
before publishing. Confirm each group's name, distance, pace and eligible
leadership roles. Configure 1–20 groups, using unique positive group numbers up
to 20; decimal labels such as `1.5` are supported.

Each group supports 1–20 confirmed places, including its leader and optional
sweeper. A person assigned both roles occupies one place. Membership roles can
overlap: `runner`, `leader`, `sweeper` and `admin`.

## Assign weekly leaders with Google Sheets

The `WeeklyLeaders` tab is a manually maintained staging input; it is not
overwritten by snapshot refreshes. It assigns existing eligible leaders to
groups, but does not create members or grant roles. The `UserSetup` tab is also
editable staging and is not an automatically synchronized copy of the `Users`
projection.

Both imports validate before committing. `UserSetup` requires exactly these
headers: `Email, Name, Role, User ID, Active, Version`. Reconcile it deliberately
against the canonical `Users` data before importing: retain existing IDs and
emails, current versions, and at least one active admin. Stale or incomplete
staging is rejected rather than overwriting newer membership. Projection
recovery seeds `UserSetup` only if the tab does not exist; an existing tab,
including an empty one, is preserved.

To import weekly leaders:

1. Deploy the current Apps Script files and Next.js app. Enable weekly
   automation to prepare an upcoming draft, or create one manually.
2. Add a `WeeklyLeaders` tab with exactly these columns, in order:

   | Run Date | Group | Leader Name |
   | --- | --- | --- |
   | 2026-10-13 | 1 | Alex Smith |
   | 2026-10-13 | 2 | Priya Shah |

3. Enter Run Date as `YYYY-MM-DD` text or a Google Sheets date cell. Date cells
   use the configured club timezone, so set the spreadsheet timezone to match.
   Group uses its displayed number. Leader Name must match the full name of an
   active member with the `leader` role. Matching ignores case and repeated
   whitespace; ambiguous duplicate names are rejected.
4. As an administrator, use **Import weekly leaders** in the selected Tuesday
   administration area. Preview first, fix every row error, then apply the
   changes. The preview is read-only. If the workbook or canonical data changes
   after preview, preview again.

Every nonempty row is validated. Duplicate date/group rows, ineligible leaders,
cancelled or started weeks, capacity overflow, and conflicting bookings or
volunteer assignments reject the whole batch; there are no partial imports.
Unlisted groups keep their assignments. A blank name is not a removal—remove
leaders through Admin. Remove rows for completed or cancelled weeks before the
next import. The manual `importWeeklyLeaders` Apps Script function is also
available to an active club administrator with workbook-editing access.

`WeeklyLeaders` is an editable input tab, so workbook editing permissions remain
important. After deploying updated scripts, the workbook owner who is an active
administrator can run `unlockClubInputSheets()` once to remove script-created
protections from the input tabs. Owner-created protections are not changed.
Restrict workbook editors to trusted administrators.

## Optional weekly automation

Automation is off until an administrator enables it in **Admin > Weekly
settings**. The default publication time is Sunday at 18:00 in the configured
club timezone; administrators can change the time.

When enabled, automation prepares the next eligible Tuesday draft from the
canonical group defaults. It does not copy bookings, leaders, routes or group
cancellations. Enabling automation prepares a draft immediately, and the timer
continues checking for eligible drafts throughout the week. Existing weeks on
the same date, including cancelled weeks, are not recreated. After the Tuesday
18:30 standard cutoff, the next Tuesday becomes eligible.

At or after the configured Sunday time, automation can publish the upcoming
draft if bookings remain open and there is no other future published week.
Groups without active eligible leaders are marked **Not running / no leader**;
their volunteer assignments are cleared and their confirmed and waitlisted
bookings are cancelled. Groups with eligible leaders remain available. Admin
shows affected groups before publication. Assign leaders before publication or
restore a group later and assign its leader again. Routes are optional.

Completed published weeks are archived at the following Sunday boundary.
Delayed timer runs catch up on eligible weeks. Cancelled weeks remain cancelled,
drafts are not archived, and archived records retain bookings, audit and
attendance. Attendance is optional, unrecorded outcomes remain unknown, and the
weekly automation does not send run reminders or notifications.

### Install and monitor the timer

1. Back up and verify a staging workbook. Deploy the current Apps Script files
   as a new Web App deployment version and deploy the matching Next.js app.
2. As the workbook owner and an active club administrator, run
   `installWeeklyAutomationTrigger()` in the Apps Script editor and authorize
   access. This installs a `runWeeklyAutomation` time-driven trigger every 15
   minutes. Install it from only one owner account and check the Triggers page
   for duplicates.
3. Enable Weekly automation in Admin; installing the timer does not enable the
   setting. Review the prepared draft, venue and time, and assign/import leaders
   before the scheduled publication.
4. Verify a staging run publishes a ready draft, leaves a blocked draft
   untouched and archives only eligible completed published weeks. Monitor
   Apps Script Triggers and Executions for errors.

Publication happens on the first successful timer execution at or after the
configured time, not necessarily at that exact minute. Google trigger delays,
quotas and failures apply. Disabling automation stops lifecycle changes but
does not uninstall the timer.

Admin's scheduler health is based on the last fetched snapshot, not a live
execution feed. Missing health is unverified; a successful check older than 45
minutes is overdue. A recent timestamp or enabled setting does not prove that
the timer is still installed. Check the owner's trigger and execution log, then
refresh Admin. The timer's health timestamp reports a successful canonical
check, not verification that every display projection succeeded.

Per-week time edits apply to future draft or published weeks and use the current
week version. Draft edits retain the existing cutoff-to-start lead time.
Published edits preserve the existing cutoff or move it earlier to leave at
least 30 minutes before the new start; the cutoff never moves later. Booking
open time and existing bookings are preserved, and invalid windows or past
starts are rejected.

Demo mode uses synthetic process-local commits, and its state resets on restart.
`runDemoWeeklyAutomation()` is a test helper, not a persistent scheduler. Demo
snapshot reads do not perform lifecycle writes.

## Before production

- Back up and migrate a staging workbook first; compare IDs, roles, history and
  unknown attendance.
- Confirm club details, group definitions, cutoff and daylight-saving behavior.
- Test invitations, verified-email sign-in, password recovery, deactivation,
  retries, simultaneous last-place bookings and waitlist promotion.
- Verify that members and leaders cannot access data or actions beyond their
  roles, and that rosters expose no other members' email addresses.
- Test draft retry, unique weekly tabs, publication, cancellation, attendance
  and archival.
- Verify Clerk email delivery, gateway failure handling, trigger executions,
  quotas and workbook growth.

No trigger has been installed and no live workbook changed as part of this app's
automated tests. Those checks must be performed by the workbook owner.
