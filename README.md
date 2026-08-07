# Tuesday Club Runs

A Next.js booking system for weekly club runs. Members book into one of 13 pace groups; leaders manage their roster and route; administrators manage runs, locations, rotas, and cancellations.

## Local development

1. Copy `.env.example` to `.env.local` and add Google OAuth credentials.
2. Install dependencies with `npm install`.
3. Run `npm run dev`.

The landing page intentionally uses demonstration data until a Sheets workbook and the mutation gateway are configured.

## Workbook schema

Create sheets with a first-row header matching these identifiers:

| Sheet | Required columns |
| --- | --- |
| `Members` | `memberId`, `email`, `displayName`, `roles`, `active`, `version` |
| `Runs` | `runId`, `startsAt`, `bookingOpensAt`, `bookingClosesAt`, `status`, `cancellationReason`, `version` |
| `Groups` | `groupId`, `runId`, `groupNumber`, `paceLabel`, `capacity`, `version` |
| `Bookings` | `bookingId`, `runId`, `groupId`, `memberId`, `status`, `bookingSource`, `bookedAt`, `updatedAt`, `version` |
| `Archives` | `archiveKey`, `runId`, `groupId`, `groupNumber`, `confirmedCount`, `waitlistedCount`, `archivedAt` |

Create the remaining administrative sheets (`Locations`, `Assignments`, and `Routes`) using the schema described in the implementation plan.

## Mutation gateway

1. Create a bound Apps Script project in the workbook and copy `apps-script/Code.gs`.
2. Set `GATEWAY_SECRET` in Script Properties to a long random value.
3. Deploy it as a Web App, restricting access to the application service account where your Google Workspace policy supports it.
4. Put its URL and the same secret in `APPS_SCRIPT_GATEWAY_URL` and `APPS_SCRIPT_GATEWAY_SECRET`.

Every booking mutation passes through Apps Script's `LockService`, then validates optimistic versions while holding the lock. This prevents concurrent overbooking and rejects stale browser submissions. The gateway also supports administrator run cancellation and idempotent archival.

Only one future run may be published. Leaders and sweepers must be represented as confirmed `assignment` bookings, so they count within each 20-runner group capacity.
