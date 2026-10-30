# Agents rail evidence

These captures verify the reference-style rail around Duet, the static default
AI identity. Session and app rows come from the existing frontend queries;
Train is a real route nested beneath that identity.

- [`agents-desktop.png`](agents-desktop.png) verifies the desktop rail and
  session canvas relationship.
- [`apps-desktop.png`](apps-desktop.png) verifies that Apps reuses the same rail
  instead of mounting a second navigation owner.
- [`agents-mobile.png`](agents-mobile.png) verifies the modal mobile rail.

The unprimed critique identified truncated session titles and an isolated Train
footer. The final candidate allows two-line titles with timestamps below and
moves Train into the Duet card. A transient black compositing artifact in an
immediate Apps capture disappeared after the route transition settled; the
stored candidate is the settled frame.

The Docker visual gate remains unavailable because the local Docker daemon did
not respond. These local Chromium captures are review evidence, not approved
Docker baselines.
