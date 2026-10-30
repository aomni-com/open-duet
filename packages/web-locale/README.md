# @repo/web-locale

This package owns the small browser-state contract that must agree between the
public lander and the product app. Locale preference and anonymous analytics
identity cross the sibling Duet hosts; application initialization, user identity,
events, rendering, and navigation remain with each app.

The boundary is deliberately framework-free. It may describe cookie and
persistence policy, but it must not import React, Next.js, PostHog, or app-specific
origins.
