# Setup and deployment

This guide covers local development and the services required for a live
deployment. Keep a staging workbook and Clerk instance separate from production
while setting up or testing.

## Local development

```sh
npm ci
cp .env.example .env.local
npm run dev
```

The app runs at `http://localhost:3000`. To explore without configuring external
services, set `CLUB_DEMO_MODE=true` in `.env.local`.

Demo data—including members, bookings and attendance—is synthetic, process-local
and resets when the server restarts. Demo mode never authenticates against or
changes the live workbook. Use it only on a separate local or preview
deployment, never on the live member app. Live configuration and authentication
errors do not fall back to demo data.

Run the available checks with `npm test`, `npm run lint` and `npm run build`.
Tests mock external services; passing tests does not verify Clerk email
delivery, Apps Script permissions or access to a real workbook.

## Environment

Set these values in `.env.local` for local work and in the hosting provider for
deployment. Keep server secrets out of client code and never prefix them with
`NEXT_PUBLIC_`.

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Canonical app URL, used for sign-in and invitation redirects |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |
| `CLERK_SECRET_KEY` | Server-only Clerk key |
| `GOOGLE_SHEET_ID` | Club workbook ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Server-side service-account credentials |
| `APPS_SCRIPT_GATEWAY_URL` | HTTPS URL of the deployed Apps Script `/exec` endpoint |
| `APPS_SCRIPT_GATEWAY_SECRET` | Shared secret for authenticating gateway requests |
| `CLUB_DEMO_MODE` | `true` only for isolated synthetic previews; otherwise `false` |

Use Clerk keys from the same instance. Use test/development keys for local work
and previews, and production keys only on the production HTTPS deployment.

## Clerk authentication

Use the already configured Clerk application rather than creating a
replacement. Configure it for restricted, invitation-only account creation,
username/password sign-in, and verified email. Disable Google/social and
passwordless sign-in while retaining email verification and password recovery.

Set the application's sign-in and sign-up URLs to `/sign-in` and `/sign-up`.
In production, verify the domain and required DNS records, apply the same
authentication settings, and use the production keys.

Only active club membership in the workbook grants access and roles. Adding a
member to the roster is distinct from sending an account invitation. Invitations
are sent from Admin when adding an active member; failed invitations can be
retried, and existing members can be invited from Clerk's dashboard. Existing
NextAuth sessions and magic links are not accepted. Members must set up Clerk
credentials.

The app uses Clerk's same-origin Frontend API proxy at `/__clerk`. Configure
that proxy path for the production domain in Clerk's production Frontend API
settings. No separate browser proxy variable or hosting rewrite is needed.
Authentication routes disable request logging and use no-referrer/no-store
headers where appropriate. Configure hosting, reverse proxies and observability
tools to redact authentication parameters as well.

If a signed-in user sees “Club membership required,” check the user's verified
primary email, active roster entry and stable Clerk-to-member binding. Do not
assign roles in Clerk metadata; the workbook is authoritative. Run
`npx -y clerk@latest doctor` for Clerk integration checks.

## Google Sheets and Apps Script

The Next.js server reads the workbook with a service account. Share the workbook
with that service account using read access only; app writes go through Apps
Script, not the browser or service account.

1. Create a bound Apps Script project in the workbook and use the V8 runtime.
2. Copy `apps-script/Code.gs`, `apps-script/Storage.gs` and
   `apps-script/Auth.gs` into the project.
3. In Script Properties, set `SPREADSHEET_ID` to the same workbook ID as
   `GOOGLE_SHEET_ID`. Set `GATEWAY_SECRET` to a separate random secret and use
   the same value for `APPS_SCRIPT_GATEWAY_SECRET`.
4. Authorize the owner-run setup functions for spreadsheet access, identity
   and workbook backup copying.
5. Deploy a Web App that executes as the workbook owner. Use its HTTPS `/exec`
   URL for `APPS_SCRIPT_GATEWAY_URL`.
6. After script changes, create a new deployment version, update the existing
   deployment to that version, and check the `/exec` URL. Saving source alone
   does not update a deployed Web App.

Unset settings fail closed. Keep the gateway secret server-only. A publicly
reachable gateway must reject requests without the shared secret. Protect the
workbook and authentication sheets from ordinary members; hidden sheets are
not access control. Restrict workbook editors to trusted administrators, and do
not manually edit membership or booking sheets while the service is live.

`Auth.gs` remains for compatibility with workbook storage tooling; the web app
does not use its legacy NextAuth operations. Existing legacy auth data is not
automatically deleted or migrated. Back it up and plan any cleanup separately.

## Confirm before production

The sample Riverside Pavilion and Meadow Lane venues, Tuesday 18:30 start,
Europe/London timezone and group definitions are demo assumptions. Confirm the
real venues, club-local IANA timezone, weekly start and booking cutoff, group
names/distances/paces and eligible leadership roles before using live data.
Scheduling uses club-local dates and handles daylight saving; do not use a
fixed UTC offset as the club timezone.

Use a staging workbook for migration and smoke tests first. Verify sign-in and
invitation delivery, access for active and deactivated members, privacy and
role checks, competing bookings and retries, leader actions, scheduling,
cancellation, attendance and archival. Check the full checklist in
[Weekly operations](weekly-operations.md) and [Bookings, roles and data](bookings-and-data.md).

No production deployment, live workbook migration or trigger installation is
performed by the local test suite. Owner credentials, sender verification,
workbook permissions and live-service checks remain deployment responsibilities.
Review dependency advisories with `npm audit`; tests are not a security scan.
