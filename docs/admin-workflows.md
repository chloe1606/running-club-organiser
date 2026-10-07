# Admin Workflow Integration

Admin now integrates member onboarding, preview-first weekly leader imports,
selected-week readiness and scheduler health. No spreadsheet deployment, trigger
installation or live data changes are included.

## Dashboard Components

The dashboard mounts these in collapsed Club members > Add member and the selected
Tuesday administration area respectively:

```tsx
import { MemberOnboarding } from "./member-onboarding";
import { WeeklyLeaderImport } from "./weekly-leader-import";

<MemberOnboarding snapshot={snapshot} mutate={mutate} pending={pending} />
<WeeklyLeaderImport snapshot={snapshot} mutate={mutate} pending={pending} />
```

Both accept `{ snapshot: PlatformSnapshot; mutate: Mutate; pending: boolean }`.
`Mutate` is the existing dashboard callback:
`(operation: string, payload: Record<string, unknown>) => Promise<void>`.
The callback owns request UUIDs, authoritative snapshot replacement, error messages
and uncertain-request retries. It catches errors internally, so controls do not
assume that callback resolution means a successful save or clear user input.
Replace `snapshot` after a response rather than mutating it in place; the leader
control invalidates its preview when the snapshot reference changes.

Both controls require an active admin in the snapshot. Onboarding works in explicit
demo mode; worksheet import is hidden there because demo has no Google workbook.
They use existing `admin-disclosure`, `member-editor`, and `table-wrap` classes.

## Add Member

Send through the existing same-origin `POST /api/platform`:

```json
{
  "operation": "addMember",
  "requestId": "013eb46c-22e2-45db-9c1d-f3bc86a7988d",
  "memberEmail": "runner@example.org",
  "name": "Taylor Example",
  "roles": ["runner"],
  "active": true
}
```

`memberEmail` is separate from the gateway's trusted actor `email`. Names are
trimmed, emails are trimmed/lowercased and must be unique even among inactive
members. Roles must be a nonempty subset of runner, leader, sweeper and admin;
active must be boolean. The UI defaults to runner and active. The server/gateway
and demo enforce admin access; new stable UUIDs and version 1 are generated on the
backend, not accepted from the browser. Successful request IDs are replay-safe.
This creates membership only, not an authentication account. Existing sign-in
still requires an active roster entry and never onboards arbitrary visitors.

## Leader Preview And Apply

`POST /api/admin/leaders/preview` takes no body or caller identity. It requires a
same-origin request, a live server session and active admin membership. It calls
the gateway's `previewWeeklyLeaders` under the existing script lock and returns
`{ data: WeeklyLeaderImportPreview }` with `Cache-Control: private, no-store`:

```ts
interface WeeklyLeaderImportPreview {
  fingerprint: string;
  changes: {
    row: number;
    date: string;
    groupNumber: number;
    previousLeaderName: string | null;
    leaderName: string;
  }[];
  errors: { row: number; code: string; message: string }[];
  unchanged: number;
}
```

The exported `weeklyLeaderImportPreviewSchema` validates the response. Proposed
assignments use full names only, never emails, member IDs or gateway secrets.
Errors retain physical worksheet row numbers, including gaps between rows.
An invalid/missing header is reported at row 1. All nonblank rows are checked;
failed row mutations are discarded before checking the next row. Valid proposals
remain visible even when other rows have errors, but no partial import is allowed.
Name matching ignores case and repeated whitespace and rejects ambiguous names.
Future-run eligibility, assignments, bookings and capacity use the same detached
mutation validator as apply. Unlisted groups remain untouched.

Preview never repairs projections, creates backups, changes protection, commits
canonical state, persists receipts or persists audit events. Its SHA-256 fingerprint
covers the loaded canonical state and complete worksheet values. Apply rereads and
validates under lock, then compares the supplied fingerprint before any backup or
canonical write:

```ts
await mutate("importWeeklyLeaders", {
  expectedImportFingerprint: preview.fingerprint,
});
```

The mutation schema requires a 64-character hexadecimal fingerprint. A changed
worksheet or canonical state produces `STALE_IMPORT` (HTTP 409); preview again.
Any validation error rejects the entire import. A valid import takes a verified
backup and commits its assignments/audits atomically, retaining the existing
request-receipt behavior. Replaying a successful request ID returns its receipt
without rereading the worksheet, including after a lost response.

The trusted manual `importWeeklyLeaders()` remains available to spreadsheet owners;
it validates and applies within one lock without a separate HTTP preview token.

## UserSetup Staging

Projection recovery seeds UserSetup only when the tab is absent. An existing tab,
including an empty tab, is never cleared, rewritten or appended to by projections.
The protected Users projection still reflects the canonical roster. UserSetup is
manual staging, not an automatically synchronized copy of Users.

`configureClubPlatform()` continues to require a complete roster, retaining every
existing ID and email identity, matching current member versions, and retaining an
active admin. New UUIDs may be generated for blank IDs. Configuration import still
validates atomically and requires a verified backup. After application or later app
changes, owners must deliberately reconcile staging against Users, including
versions and newly added members, before the next configuration import. Stale
staging must fail rather than overwrite newer canonical changes.

## Verification And Boundaries

Focused coverage includes preservation through recovery/mutations, complete-row
preview errors, no preview writes, privacy/auth checks, sheet/data staleness,
receipt replay, UUID member creation, schema rejection and demo atomicity.
Component tests cover server rendering and defaults, not browser interactions.
Apps Script is tested with the local workbook harness; production deployment and
verification against Google Sheets remain separate. Browser checks must not save,
import, book, change settings or otherwise mutate a live club workbook.

## Weekly Operations And Health

Admin defaults to the nearest upcoming draft/published Tuesday. Its compact summary
uses the actual selected run's venue, time and status. Leader readiness counts only
noncancelled groups with active eligible leaders; missing group numbers link to
assignments. Upcoming draft buttons change the selected week. Preview-first import,
per-week location/time and cancellation remain nearby. Weekly settings, manual
creation/publication/archive, member management and analytics stay collapsed.
Attendance is optional and no reminders are sent.

The workbook owner must deploy the matching scripts, run
`installWeeklyAutomationTrigger()` as an active administrator, authorize it, and
check the Triggers and Executions pages. Enabling the app setting is not trigger
installation. Every successful `runWeeklyAutomation()` tick persists
`schedulerHealth.lastSuccessfulCheckAt` in the canonical snapshot, including
disabled and no-op ticks. Failed validation/commits do not advance it. Health is
separate from config versions and audit; normal projection recovery still applies.
It records a successful canonical scheduler check, not successful delivery of every
projection or proof that a trigger is still installed. No timestamp means unverified;
more than 45 minutes old is shown as overdue, not proof of a specific failure.
The display is the last fetched snapshot, not a real-time Google execution feed.

Next publication uses the club-local Sunday schedule and distinguishes an overdue
publication from a future one. Missing leaders, another future published week and
closed booking windows remain explicit blockers. A cancelled Tuesday is never
recreated. A schedule alone does not guarantee publication; Google delays and quotas
still apply. Scheduler health commits can invalidate an import fingerprint, so
preview again after a stale-import response rather than bypassing the check.

Demo health advances only through explicit `runDemoWeeklyAutomation()` synthetic
ticks and is labelled demo-only. Reads and enabling settings do not fabricate timer
health. No process-local tick verifies a live timer.

Runner view defaults to the current bookable week before other future/history weeks.
Past runs are inside a labelled disclosure and selector, with a return to upcoming
runs. Public statuses are Bookings open, Bookings closed or Cancelled, never Published.
The runner's own booking links to their group; waitlists explicitly remain unconfirmed.