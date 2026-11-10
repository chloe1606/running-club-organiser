# Bookings, roles and data

## Booking rules

- A person can have one active booking per week, confirmed or waitlisted.
- Full groups place new bookings on the waitlist.
- When a confirmed place is vacated while booking is open, the earliest eligible
  waitlisted runner is promoted. Ties use stable booking IDs.
- After the booking cutoff, withdrawals and promotions are closed. Attendance is
  recorded separately; a booking does not imply attendance.
- Switching groups and administrator moves are coordinated operations. A full
  destination puts the person on its waitlist; a rejected move leaves the
  original booking unchanged. Leaders cannot be moved as ordinary runners or
  silently displaced.
- Leader and sweeper assignments must be eligible and cannot overbook a group.
  A person serving both roles occupies one place.
- Drafts copy the club's group definitions. Copied routes are marked for review.
  Repeated draft creation does not duplicate weekly tabs, and only one future
  week can be published at a time.
- Cancelled weeks retain history but are excluded from participation analytics.
  Archiving does not delete bookings or attendance.

Mutations use stable request IDs for safe retries and versions to detect stale
submissions. The server-side lock, not the browser's cached count, is the
capacity authority.

## Roles and access

The workbook's active membership is the authority for access and roles. A Clerk
account by itself does not grant club access. Membership can have overlapping
`runner`, `leader`, `sweeper` and `admin` roles.

Only assigned weekly leaders and admins can edit a group's route, sweeper and
attendance. Admins manage members, leaders, weekly lifecycle and runner moves.
Server-side authorization applies independently of which navigation controls
are visible.

The public runs page is available without signing in. Private rosters require
membership; runners see their own personal history. Assigned leaders can access
their group's roster, and admins have operational access. The app exposes
display names rather than other members' email addresses. Clerk credentials,
sessions, tokens and the gateway secret are not returned in club snapshots.

Membership is rechecked for protected data and mutations, including after a
member is deactivated. The app binds a Clerk identity to a stable club member
ID; a changed email cannot switch that identity. Resolve conflicting identity
bindings through organiser review rather than automatic reassignment.

## Attendance and analytics

Bookings represent intent; attendance is an explicitly recorded outcome.
Missing attendance is unknown, not zero or absent.

Admin's **Group popularity** uses booking demand across completed published or
archived weeks. It excludes cancelled, draft and future weeks. Average confirmed
bookings include assigned volunteers and divide by every completed week in
which the group ran, including weeks with no bookings. Average waitlist uses the
final retained queue. Booking fill is total confirmed bookings divided by total
capacity, not an average of weekly percentages.

Selected-week demand is shown separately from historical averages. Attendance
utilisation is separate from booking utilisation. Waitlist joins and promotions
are retained in audit events even if the final queue is cleared. Favourite
group is based on recorded attendance and remains unknown when attendance is
missing.
