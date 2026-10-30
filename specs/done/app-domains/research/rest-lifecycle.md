# REST lifecycle evidence

The management contract is implemented by
[`registerAppDomainRoutes`](../../../../apps/api/src/routes/app-domains.ts).
The [controlled HTTP trace](../../../../apps/api/src/routes/app-domains-lifecycle.test.ts)
uses the real Hono routes and Convex HTTP client with a transport into production
Convex handlers, their schema and the registered ActionRetrier component. Vercel
HTTP is controlled at the provider transport. Authentication is supplied as an
already-admitted identity here and tested separately on a real local deployment.

The trace reserves a normalized hostname, replays the same reservation, refuses a
cross-app collision, displays ownership and routing records, continues through
source pages, activates after a recheck, and removes the final assignment. It
asserts the returned identities and exact DNS values. Deliberately discarding the
source cursor returned the first app twice and failed the second-page assertion;
restoring continuation passed.

The [real-deployment cases](../../../../apps/api/src/app-domains.test.ts) cover
inspection without provider credentials, malformed requests, idempotent absent
removal, viewer inspection/write refusal, missing configuration, unchanged
visibility, ordinary apps scope, cursor refusal, and internal callback admission.
Standalone app projection uses an injected backend observation to test its own
consumer rule; default launch still targets Duet. The gateway URL consumer shares
the same selector and advertises no private URL.

The selected integrated REST and gateway files passed 12 cases and 58 assertions.
Broader app tests exposed composed workspace cleanup's multiple-page-queries
failure; the focused real API reproduction failed before the independent first
page and passed afterward. The backend's workspace deletion case verifies
immediate host refusal and eventual provider absence.

These checks do not prove Vercel alias selection, customer DNS, TLS, or deployed
browser admission. Those remain owned by the focused staging journey.
