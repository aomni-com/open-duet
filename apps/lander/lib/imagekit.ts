/**
 * ImageKit helpers — scoped to the marketing surface (landing page,
 * pricing, blog hero art). The rest of the app uses local assets and
 * different CDNs.
 *
 * For `<Image>` and `<Video>` use the SDK components from
 * `@imagekit/next` directly — they read `urlEndpoint` from
 * `ImageKitProvider` (wired in `LandingChrome`) so call sites can just
 * pass `src` + `transformation`.
 *
 * The helpers in this file are for the *responsive hero video* — we
 * render that with a raw HTML `<video>` element so we can ship a
 * smaller mobile cut via `<source media>`. The SDK's `<Video>` would
 * be ideal here but it doesn't allow `<source>` children — it renders
 * a single `<video src>` and ignores nested elements. We use the
 * SDK's `buildSrc` so URL construction stays consistent with the rest
 * of the SDK's transformations.
 *
 * Docs:
 *   - Video transformations: https://imagekit.io/docs/video-transformation
 *   - Video optimization:    https://imagekit.io/docs/video-optimization
 *   - Video thumbnails:      https://imagekit.io/docs/create-video-thumbnails
 */

import { buildSrc, type Transformation } from '@imagekit/next'

export const IK_URL_ENDPOINT = 'https://ik.imagekit.io/duet'

/**
 * Build an ImageKit URL for an asset at `src` (path relative to the
 * endpoint, with or without a leading slash) with the given
 * transformations. Thin wrapper around the SDK's `buildSrc` so call
 * sites don't repeat `urlEndpoint` everywhere.
 */
export function ikUrl(src: string, transformation: Transformation[] = []): string {
  return buildSrc({
    urlEndpoint: IK_URL_ENDPOINT,
    src,
    transformation,
  })
}

/**
 * Build an ImageKit video poster URL. ImageKit's `/ik-thumbnail.jpg`
 * suffix on a video path asks the CDN to render a still JPG frame;
 * pass `startOffset` (seconds) and standard image transforms.
 */
export function ikVideoPoster(
  videoSrc: string,
  {
    startOffset = 0,
    width,
    height,
    quality = 70,
  }: { startOffset?: number; width?: number; height?: number; quality?: number } = {},
): string {
  const normalized = videoSrc.startsWith('/') ? videoSrc : `/${videoSrc}`
  return buildSrc({
    urlEndpoint: IK_URL_ENDPOINT,
    src: `${normalized}/ik-thumbnail.jpg`,
    transformation: [{ startOffset, width, height, quality }],
  })
}
