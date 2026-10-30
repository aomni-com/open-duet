'use client'

import { memo, useEffect, useRef } from 'react'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from 'three'

import { useHydratedReducedMotion } from '@/components/landing/atoms'

/**
 * The "train your agent" WebGL centrepiece. This is NOT a background — it is the
 * value prop performed: a diffuse grey particle cloud (raw, generic model that
 * belongs to no one) is fed six streams of your context (files, tone, tools,
 * data, memory, workflows) that fire from the surrounding chips and pull the
 * chaos into a crisp,
 * organised sphere-mind, which finally ignites brand-blue with one heartbeat.
 * Chaos → order == generic → trained, and the incoming streams are the cause.
 *
 * The single `progress` timeline (0 → 1) drives everything: the shader reads it
 * as a uniform, and the parent section reads it back via `onProgress` to light
 * the corner chips and flip the reply from generic to knowing-your-world, so the
 * 3D and the DOM tell one synchronised story. Runs its own rAF (one loop), mounts
 * lazily, and renders a single settled frame under reduced motion.
 */

/** Brand blue — the base "trained" hue the formation resolves to. */
const BLUE = new Color('#3a86e0')

/** One hue per source (files, tone, tools, data, memory, workflows), matching
 * the DOM chip + facet-card accents. The mind picks up whichever source is
 * live, so the sphere cycles through real colour instead of reading blue end to
 * end. */
const SOURCE_HEX = ['#3a86e0', '#a274ec', '#2bc0ad', '#f5a524', '#ec6a9c', '#59b872'] as const

function resolveCssVariableColor(host: HTMLElement, property: string, fallback: string): string {
  const raw = getComputedStyle(host).getPropertyValue(property).trim()
  if (!raw) return fallback

  // Tailwind theme variables store HSL channels (`210 20% 12%`) rather than
  // a complete color. Let the browser resolve either that form or an already
  // complete CSS color, then give Three.js the resulting rgb() value it can
  // parse consistently.
  const expression = /^(?:#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\()/i.test(raw)
    ? raw
    : `hsl(${raw})`
  const probe = document.createElement('span')
  probe.style.color = expression
  if (!probe.style.color) return fallback
  probe.hidden = true
  host.appendChild(probe)
  const resolved = getComputedStyle(probe).color
  probe.remove()
  return resolved || fallback
}

/** The six sources, in world space, matching the DOM chip parking spots:
 * 0 top-left, 1 top-right, 2 mid-left, 3 mid-right, 4 bottom-left,
 * 5 bottom-right — a ring around the mind. */
const CORNERS = [
  [-1.95, 1.35, 0.5],
  [1.95, 1.35, 0.5],
  [-2.2, 0.0, 0.5],
  [2.2, 0.0, 0.5],
  [-1.95, -1.35, 0.5],
  [1.95, -1.35, 0.5],
] as const

/** Where each chip docks onto the mind and then orbits with it — four points
 * spread around the sphere (staggered longitudes + latitudes) so, once trained,
 * the labels circle the formation in 3D as literal parts of it. Indexed to the
 * corner/channel order. */
const ANCHOR_RADIUS = 1.34
const ANCHOR_BASE = [0, 1, 2, 3, 4, 5].map(i => {
  const lon = (i / 6) * Math.PI * 2 + Math.PI / 4
  const lat = (i % 2 === 0 ? 1 : -1) * 0.55
  const cl = Math.cos(lat)
  return new Vector3(Math.cos(lon) * cl, Math.sin(lat), Math.sin(lon) * cl).multiplyScalar(
    ANCHOR_RADIUS,
  )
})

/** A single chip anchor projected to host-normalised 0..1 space for the DOM. */
export type ChipAnchor = {
  /** 0..1 across the host (left). */ x: number
  /** 0..1 down the host (top). */ y: number
  /** perspective scale, smaller when the orbit carries it to the back. */
  scale: number
  /** fades toward the back of the orbit. */ opacity: number
  /** true while on the near hemisphere (used for stacking). */ front: boolean
  /** 0..1 dock progress: 0 parked at the corner, 1 fully in the orbit. */
  docked: number
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/** Same stagger the shader uses per channel, so a chip docks exactly as its
 * stream of particles lands. */
const chipDockProgress = (channel: number, progress: number) => {
  const t0 = 0.1 + channel * 0.1
  return smoothstep(t0, t0 + 0.3, progress)
}

const VERT = /* glsl */ `
  uniform float uProgress;
  uniform float uTime;
  uniform float uSpin;
  uniform float uSize;
  uniform float uDpr;
  uniform float uActive;
  uniform vec3 uCorners[6];
  attribute vec3 aTarget;
  attribute float aChannel;
  attribute float aSeed;
  varying float vMix;
  varying float vGlow;
  varying float vFace;
  varying float vActive;

  #define TAU 6.28318530718

  // Quintic smootherstep — zero velocity AND acceleration at both ends, so the
  // formation eases in and settles with no visible kink at start or finish
  // (plain smoothstep still leaves a faint corner in the motion).
  float smoother(float a, float b, float x){
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }

  // Channel-level arrival — drives colour + highlight in lockstep with the DOM
  // chip that docks for this stream.
  float channelProgress(float ch){
    float t0 = 0.1 + ch * 0.1;
    return smoother(t0, t0 + 0.3, uProgress);
  }

  // Per-particle arrival — same stream window, feathered by seed so the points
  // in one feed don't snap home in unison; they flow in over a soft, staggered
  // band. This is what kills the "everything pulls at once" jank.
  float particleProgress(float ch, float seed){
    float t0 = 0.06 + ch * 0.09 + seed * 0.12;
    return smoother(t0, t0 + 0.28, uProgress);
  }

  void main(){
    float lp = particleProgress(aChannel, aSeed);
    float cl = channelProgress(aChannel);
    vec3 start = position;
    vec3 corner = uCorners[int(aChannel + 0.5)];

    // The stream no longer funnels through one hard point (that pinch-then-spray
    // was the ugly part). Spread the bezier control into a broad ribbon per
    // particle — biased from the source corner toward its final slot, plus a
    // seeded offset — so the six feeds read as flowing arcs curving into place.
    vec3 ctrl = mix(corner, aTarget, 0.35) + 0.55 * vec3(
      sin(aSeed * TAU),
      cos(aSeed * TAU * 1.7),
      sin(aSeed * TAU * 0.6)
    );

    // Curved path: chaos -> ribbon -> formation slot.
    float t = lp;
    float mt = 1.0 - t;
    vec3 pos = mt*mt*start + 2.0*mt*t*ctrl + t*t*aTarget;

    // Spiral settle: unwind an extra turn about Y as the point lands, so it
    // swirls elegantly onto the shell instead of sliding in on a straight line.
    float swirl = (1.0 - lp) * (1.15 + 0.5 * (aSeed - 0.5));
    float wc = cos(swirl), ws = sin(swirl);
    pos.xz = mat2(wc, -ws, ws, wc) * pos.xz;

    // Aimless drift while still raw chaos; smooth, early handoff as it forms.
    float chaos = 1.0 - smoother(0.0, 0.8, lp);
    pos += chaos * 0.09 * vec3(
      sin(uTime*0.6 + aSeed*TAU),
      cos(uTime*0.5 + aSeed*10.0),
      sin(uTime*0.4 + aSeed*3.0)
    );

    // Slow shared rotation once formed (quiet alive-at-rest). uSpin is a
    // shared, JS-accumulated angle so the DOM chips orbit the exact same way;
    // ramped in per particle (lp) so nothing pops into spin mid-flight.
    float rot = uSpin * lp;
    float c = cos(rot), s = sin(rot);
    pos.xz = mat2(c, -s, s, c) * pos.xz;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // One ignite heartbeat as training completes.
    float pulse = smoother(0.78, 0.9, uProgress) * (1.0 - smoother(0.9, 1.0, uProgress));
    vGlow = clamp(lp + pulse * 0.9, 0.0, 1.6);
    vMix = smoother(0.15, 1.0, lp);

    // Front-of-sphere particles read brighter than the back ones, so as the
    // formation spins you SEE points travel toward the light and fade away —
    // a solid, legible rotation cue (and it matches the chips' depth fade).
    vFace = mix(1.0, smoothstep(-1.5, 1.4, pos.z), lp);

    // Highlight: when a source is active (hovered / clicked / auto-toured), its
    // quarter of the particles read brighter + a touch larger, so the source
    // the right panel is talking about is the one lighting up the mind. Only
    // once that channel has actually docked (lp) — no highlight on raw chaos.
    // Channel-timed (cl), so it tracks the docking chip rather than the
    // feathered per-particle arrival.
    float act = (1.0 - step(0.5, abs(aChannel - uActive))) * cl;
    // Soft breath so the active cluster shimmers instead of sitting flat.
    vActive = act * (0.82 + 0.18 * sin(uTime * 2.2 + aSeed * 6.283));

    // Size eases smoothly from a fine speck to full as it forms — a trailing
    // sparkle that resolves, instead of the old mid-flight bump.
    float pop = 0.32 + 0.68 * smoother(0.0, 1.0, lp);
    gl_PointSize = uSize * uDpr * pop * (1.0 + vGlow * 0.3) * (1.0 + vActive * 0.7) * (3.2 / -mv.z);
  }
`

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uGrey;
  uniform vec3 uBlue;
  uniform vec3 uActiveColor;
  uniform float uAlpha;
  varying float vMix;
  varying float vGlow;
  varying float vFace;
  varying float vActive;

  void main(){
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float alpha = smoothstep(0.5, 0.08, d);
    if (alpha <= 0.001) discard;
    // Formation eases neutral grey -> brand blue as it trains; then the whole
    // mind takes on a wash of the LIVE source's hue, and that source's own
    // quarter of particles goes fully to it + brightens — so the cloud carries
    // real colour and you can see which source is lighting it up.
    vec3 base = mix(uGrey, uBlue, vMix);
    base = mix(base, uActiveColor, vMix * 0.5);
    vec3 col = mix(base, uActiveColor, clamp(vActive * 0.75, 0.0, 1.0));
    col *= (0.55 + vGlow * 0.5) * (0.4 + 0.6 * vFace) * (1.0 + vActive * 0.6);
    gl_FragColor = vec4(col, alpha * (0.24 + 0.32 * vGlow) * (0.55 + 0.45 * vFace) * (1.0 + vActive * 0.5) * uAlpha);
  }
`

/** Fibonacci-sphere target: crisp, organised formation with a denser core. */
function buildAttributes(count: number) {
  const start = new Float32Array(count * 3)
  const target = new Float32Array(count * 3)
  const channel = new Float32Array(count)
  const seed = new Float32Array(count)
  const golden = Math.PI * (3 - Math.sqrt(5))

  for (let i = 0; i < count; i++) {
    // Organised slot: 70% on the shell, 30% in a denser core.
    const onShell = i % 10 >= 3
    const y = 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    const radius = onShell ? 1.12 + Math.random() * 0.14 : Math.random() * 0.7
    target[i * 3] = Math.cos(theta) * r * radius
    target[i * 3 + 1] = y * radius
    target[i * 3 + 2] = Math.sin(theta) * r * radius

    // Raw chaos: a wide, formless gaussian-ish cloud.
    const gx = (Math.random() + Math.random() + Math.random() - 1.5) * 1.6
    const gy = (Math.random() + Math.random() + Math.random() - 1.5) * 1.3
    const gz = (Math.random() + Math.random() + Math.random() - 1.5) * 1.2
    start[i * 3] = gx
    start[i * 3 + 1] = gy
    start[i * 3 + 2] = gz - 0.2

    channel[i] = i % 6
    seed[i] = Math.random()
  }
  return { start, target, channel, seed }
}

function TrainBloomImpl({
  onProgress,
  onAnchors,
  activeRef,
  className,
}: {
  onProgress?: (p: number) => void
  /** Per-frame projected positions for the four DOM chips so they can ride the
   * 3D orbit (imperative — do not route this through React state). */
  onAnchors?: (anchors: ChipAnchor[]) => void
  /** Index of the currently highlighted source (clicked / auto-toured) or null.
   * That channel's quarter of the particles takes the source's hue and the
   * whole mind washes toward it — the globe keeps its own free rotation, so
   * switching sources only recolours, it never resets the spin. */
  activeRef?: { current: number | null }
  className?: string
}) {
  const reduce = useHydratedReducedMotion()
  const hostRef = useRef<HTMLDivElement>(null)
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress
  const onAnchorsRef = useRef(onAnchors)
  onAnchorsRef.current = onAnchors
  const activeRefRef = useRef(activeRef)
  activeRefRef.current = activeRef

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // Fewer particles + smaller on narrow screens; clamp DPR for fill-rate.
    const narrow = host.clientWidth < 480
    const count = narrow ? 1700 : 2800
    // Cap DPR at 1.5: a soft additive particle cloud shows no benefit from a 2x
    // buffer, but every extra fragment is real fill-rate cost on retina
    // (2x -> 1.5x is ~44% fewer fragments). Points stay the same CSS size
    // because gl_PointSize multiplies by uDpr.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)

    const scene = new Scene()
    const camera = new PerspectiveCamera(45, 1, 0.1, 100)
    camera.position.set(0, 0, 4.3)

    // antialias off: points are alpha-shaped in the fragment shader (their
    // square edges are already fully transparent), so MSAA buys nothing here
    // but costs memory bandwidth. low-power nudges laptops off the dGPU.
    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
      })
    } catch {
      // No context, despite the section's capability check — a GPU process can
      // die between the probe and the mount. Three.js reports that by throwing,
      // and an unhandled throw here would unmount the entire page, so bail with
      // the timeline reported finished: the DOM half of the story then reads as
      // trained rather than frozen in raw chaos.
      onProgressRef.current?.(1)
      return
    }
    renderer.setClearColor(0x000000, 0)
    renderer.setPixelRatio(dpr)
    host.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'

    const { start, target, channel, seed } = buildAttributes(count)
    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(start, 3))
    geo.setAttribute('aTarget', new BufferAttribute(target, 3))
    geo.setAttribute('aChannel', new BufferAttribute(channel, 1))
    geo.setAttribute('aSeed', new BufferAttribute(seed, 1))

    // Grey resolves from the current theme's foreground for light/dark parity.
    const greyCss = resolveCssVariableColor(host, '--foreground', '#8a93a6')
    const grey = new Color(greyCss)
    // Dark themes have a light --foreground; use that to lift contrast so the
    // cloud reads bright + saturated on black instead of washing out.
    const fg = new Color(greyCss)
    const isDark = fg.r + fg.g + fg.b > 1.5
    // Nudge grey toward mid so raw chaos reads as neutral, not full-contrast.
    grey.lerp(new Color('#8a93a6'), 0.55)
    if (isDark) grey.lerp(new Color('#c3ccdb'), 0.3)

    const blue = BLUE.clone()
    if (isDark) blue.multiplyScalar(1.22)

    // One Color per source; dark themes lift them so they read saturated on
    // black. The live active colour eases between these each frame.
    const channelColors = SOURCE_HEX.map(h => {
      const c = new Color(h)
      if (isDark) c.multiplyScalar(1.16)
      return c
    })
    // Mutated in place every frame (uniform holds this same reference).
    const activeColor = channelColors[0]!.clone()

    const uniforms = {
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uSpin: { value: 0 },
      uAlpha: { value: isDark ? 1.45 : 1.0 },
      uSize: { value: narrow ? 2.2 : 2.8 },
      uActive: { value: -1 },
      uDpr: { value: dpr },
      uGrey: { value: grey },
      uBlue: { value: blue },
      uActiveColor: { value: activeColor },
      uCorners: {
        value: CORNERS.map(c => new Vector3(c[0], c[1], c[2])),
      },
    }
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
    })

    const points = new Points(geo, material)
    scene.add(points)

    const resize = () => {
      const w = host.clientWidth || 1
      const h = host.clientHeight || 1
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    let raf = 0
    let inView = false
    let elapsed = 0 // accumulated animation seconds (freezes while paused)
    const DURATION = 4.2 // seconds of the training performance
    let lastReported = -1

    const report = (p: number) => {
      // Only surface meaningful steps so the parent doesn't re-render per frame.
      const q = Math.round(p * 100) / 100
      if (q !== lastReported) {
        lastReported = q
        onProgressRef.current?.(p)
      }
    }

    // Reused each frame so the orbit projection allocates nothing.
    const scratch = new Vector3()

    const emitAnchors = (progress: number, spin: number) => {
      const cb = onAnchorsRef.current
      if (!cb) return
      const anchors: ChipAnchor[] = []
      for (let i = 0; i < 6; i++) {
        const dock = chipDockProgress(i, progress)
        const base = ANCHOR_BASE[i]!
        // Orbit about Y using the SAME shared angle + SAME matrix as the shader
        // (mat2(c,-s,s,c) => x' = c*x + s*z, z' = -s*x + c*z) so the chips and
        // the point cloud turn in lockstep, in the same direction.
        const rot = spin * dock
        const cr = Math.cos(rot)
        const sr = Math.sin(rot)
        const ax = base.x * cr + base.z * sr
        const az = -base.x * sr + base.z * cr
        const corner = CORNERS[i]!
        scratch.set(
          lerp(corner[0], ax, dock),
          lerp(corner[1], base.y, dock),
          lerp(corner[2], az, dock),
        )
        const worldZ = scratch.z
        scratch.project(camera)
        const depth = smoothstep(-ANCHOR_RADIUS, ANCHOR_RADIUS, worldZ)
        anchors.push({
          x: scratch.x * 0.5 + 0.5,
          y: 1 - (scratch.y * 0.5 + 0.5),
          scale: lerp(0.8, 1.12, lerp(1, depth, dock)),
          opacity: lerp(0.55, 1, lerp(1, depth, dock)),
          front: worldZ >= 0,
          docked: dock,
        })
      }
      cb(anchors)
    }

    const renderFrame = (progress: number, time: number, spin: number) => {
      uniforms.uProgress.value = progress
      uniforms.uTime.value = time
      uniforms.uSpin.value = spin
      renderer.render(scene, camera)
      emitAnchors(progress, spin)
    }

    // Shared, JS-accumulated orbit angle (radians). The cloud spins freely and
    // continuously — switching the active source never touches it, so the dots
    // keep going while only the colour + the DOM badges react.
    const SPIN_SPEED = 0.13
    // Reused scratch so the per-frame colour ease allocates nothing.
    const targetColor = new Color()
    let spin = 0
    let lastNow = 0

    if (reduce) {
      // Settled poster: fully trained, gently posed, no animation loop.
      renderFrame(1, 0, 0.6)
      onProgressRef.current?.(1)
    }

    const loop = (now: number) => {
      // lastNow === 0 marks a (re)start, so the first frame after a pause takes
      // a ~0 dt instead of a huge jump — elapsed + spin resume seamlessly.
      if (!lastNow) lastNow = now
      const dt = Math.min((now - lastNow) / 1000, 0.05)
      lastNow = now
      elapsed += dt
      const p = Math.min(elapsed / DURATION, 1)
      // easeInOutQuart on the reveal: gentler ramp in and a softer settle than
      // cubic, so the formation glides to rest with no fast-then-crawl tail.
      const eased = p < 0.5 ? 8 * p * p * p * p : 1 - Math.pow(-2 * p + 2, 4) / 2
      // Free, uninterrupted rotation — no whip-to-front on source switches.
      spin += dt * SPIN_SPEED
      const act = activeRefRef.current?.current ?? -1
      uniforms.uActive.value = act
      // Ease the live hue toward the active source's colour so the sphere melts
      // between colours instead of hard-cutting when the source changes.
      targetColor.copy(act >= 0 ? channelColors[act]! : blue)
      activeColor.lerp(targetColor, Math.min(1, dt * 3.2))
      report(eased)
      renderFrame(eased, elapsed, spin)
      raf = requestAnimationFrame(loop)
    }

    // Animate only while the section is on screen AND the tab is visible.
    // lastNow=0 resets the dt baseline so resuming never jumps the timeline.
    const play = () => {
      if (reduce || raf || !inView || document.hidden) return
      lastNow = 0
      raf = requestAnimationFrame(loop)
    }
    const pause = () => {
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    // Start when scrolled into view; STOP when it scrolls back out. The page
    // below is long, so there's no reason to keep the globe rendering at 60fps
    // once it's offscreen — elapsed + spin freeze and resume where they left.
    const io = new IntersectionObserver(
      entries => {
        inView = entries[0]?.isIntersecting ?? false
        if (inView) play()
        else pause()
      },
      { threshold: 0.25 },
    )
    io.observe(host)

    const onVisibility = () => {
      if (document.hidden) pause()
      else play()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (raf) cancelAnimationFrame(raf)
      geo.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === host) {
        host.removeChild(renderer.domElement)
      }
    }
  }, [reduce])

  return <div ref={hostRef} className={className} aria-hidden="true" />
}

/** Memoised: the parent re-renders on every tour/hover/click state change, but
 * all of the bloom's props are stable (refs + useCallback handlers + a constant
 * className), so this never re-renders — the WebGL loop, spin, and particle
 * positions are never reset when the DOM story switches sources. */
export const TrainBloom = memo(TrainBloomImpl)
