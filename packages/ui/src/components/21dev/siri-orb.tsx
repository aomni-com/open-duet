'use client'

import React, { useMemo } from 'react'

// Safe cn fallback
const cn = (...classes: (string | undefined | null | boolean)[]) =>
  classes.filter(Boolean).join(' ')

// --- SiriOrb (smoother + long non-repeating) ---
interface SiriOrbProps {
  size?: string
  className?: string
  colors?: {
    bg?: string
    c1?: string // first color (will be auto-dampened)
    c2?: string
    c3?: string
  }
  animationDuration?: number // base seconds
}

const SiriOrbComponent: React.FC<SiriOrbProps> = ({
  size = '192px',
  className,
  colors,
  animationDuration = 20,
}) => {
  // Default palette (first color is set with an alpha to reduce dominance)
  const defaultColors = {
    bg: 'transparent',
    c1: 'oklch(75% 0.15 350 / 0.7)', // ↓ alpha so it doesn't dominate
    c2: 'oklch(80% 0.12 200)',
    c3: 'oklch(78% 0.14 280)',
  }
  const finalColors = { ...defaultColors, ...colors }

  const sizeValue = parseInt(size.replace('px', ''), 10)
  const blurAmount = Math.max(sizeValue * 0.08, 8)
  const contrastAmount = Math.max(sizeValue * 0.003, 1.8)

  // Randomized phase offsets so it feels less predictable without re-render jitter.
  const seeds = useMemo(
    () =>
      Array.from({ length: 5 }, () => ({
        rot: Math.random(),
        drift: Math.random(),
        wobble: Math.random(),
      })) as [
        { rot: number; drift: number; wobble: number },
        { rot: number; drift: number; wobble: number },
        { rot: number; drift: number; wobble: number },
        { rot: number; drift: number; wobble: number },
        { rot: number; drift: number; wobble: number },
      ],
    [],
  )

  // Prime-ish multipliers → very long combined repeat period without slowing speed.
  // Using distinct, co-primeish ratios keeps motion fast but non-repeating for a long time.
  const t1 = animationDuration * 1.0 // ≈ base
  const t2 = animationDuration * 1.31 // ~prime-ish ratio
  const t3 = animationDuration * 1.61 // golden-ish
  const t4 = animationDuration * 1.97 // ~2 but not quite
  const t5 = animationDuration * 2.41 //

  const d1 = animationDuration * 3.73 // center drift periods (longer)
  const d2 = animationDuration * 4.19
  const d3 = animationDuration * 5.29
  const d4 = animationDuration * 6.07
  const d5 = animationDuration * 7.31

  return (
    <div
      className={cn('siri-orb-smooth', className)}
      style={
        {
          width: size,
          height: size,
          ...({
            // colors
            '--bg': finalColors.bg,
            '--c1': finalColors.c1,
            '--c2': finalColors.c2,
            '--c3': finalColors.c3,
            // filters
            '--blur-amount': `${blurAmount}px`,
            '--contrast-amount': `${contrastAmount}`,
            // rotation durations
            '--t1': `${t1}s`,
            '--t2': `${t2}s`,
            '--t3': `${t3}s`,
            '--t4': `${t4}s`,
            '--t5': `${t5}s`,
            // drift durations
            '--d1': `${d1}s`,
            '--d2': `${d2}s`,
            '--d3': `${d3}s`,
            '--d4': `${d4}s`,
            '--d5': `${d5}s`,
            // randomized negative delays so each instance starts uniquely
            '--delay1': `${-seeds[0].rot * t1}s`,
            '--delay2': `${-seeds[1].rot * t2}s`,
            '--delay3': `${-seeds[2].rot * t3}s`,
            '--delay4': `${-seeds[3].rot * t4}s`,
            '--delay5': `${-seeds[4].rot * t5}s`,
            '--dd1': `${-seeds[0].drift * d1}s`,
            '--dd2': `${-seeds[1].drift * d2}s`,
            '--dd3': `${-seeds[2].drift * d3}s`,
            '--dd4': `${-seeds[3].drift * d4}s`,
            '--dd5': `${-seeds[4].drift * d5}s`,
          } as Record<string, string>),
        } as React.CSSProperties
      }
    >
      {/* Five animated conic gradient layers */}
      <div className="gradient-layer gradient-layer-1">
        <div className="gradient-content" />
      </div>
      <div className="gradient-layer gradient-layer-2">
        <div className="gradient-content" />
      </div>
      <div className="gradient-layer gradient-layer-3">
        <div className="gradient-content" />
      </div>
      <div className="gradient-layer gradient-layer-4">
        <div className="gradient-content" />
      </div>
      <div className="gradient-layer gradient-layer-5">
        <div className="gradient-content" />
      </div>

      {/* Static radial glow */}
      <div className="radial-gradient-layer" />
      {/* Soft sheen */}
      <div className="overlay-layer" />

      <style jsx>{`
        /* Register animatable custom properties so interpolation is smooth */
        @property --rot1 {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        @property --rot2 {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        @property --rot3 {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        @property --rot4 {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        @property --rot5 {
          syntax: '<angle>';
          inherits: false;
          initial-value: 0deg;
        }
        @property --cx1 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cy1 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cx2 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cy2 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cx3 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cy3 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cx4 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cy4 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cx5 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }
        @property --cy5 {
          syntax: '<percentage>';
          inherits: false;
          initial-value: 50%;
        }

        .siri-orb-smooth {
          position: relative;
          overflow: hidden;
          border-radius: 50%;
          background: radial-gradient(
            circle,
            rgba(0, 0, 0, 0.08) 0%,
            rgba(0, 0, 0, 0.03) 30%,
            transparent 70%
          );
        }
        .dark .siri-orb-smooth {
          background: radial-gradient(
            circle,
            rgba(255, 255, 255, 0.08) 0%,
            rgba(255, 255, 255, 0.02) 30%,
            transparent 70%
          );
        }

        .gradient-layer {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          overflow: hidden;
        }
        .gradient-content {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          filter: blur(var(--blur-amount)) contrast(var(--contrast-amount)) saturate(1.15);
          transform-origin: center;
          will-change: transform;
        }

        /* Layer recipes: reduce c1 arc coverage + add alpha so it dominates less */
        .gradient-layer-1 .gradient-content {
          background: conic-gradient(
            from var(--rot1) at var(--cx1) var(--cy1),
            var(--c3) 0deg 36deg,
            transparent 36deg 324deg,
            var(--c3) 324deg 360deg
          );
          animation:
            spin1 var(--t1) linear var(--delay1) infinite,
            drift1 var(--d1) ease-in-out var(--dd1) infinite alternate;
        }
        .gradient-layer-2 .gradient-content {
          background: conic-gradient(
            from var(--rot2) at var(--cx2) var(--cy2),
            var(--c2) 0deg 50deg,
            transparent 50deg 310deg,
            var(--c2) 310deg 360deg
          );
          animation:
            spin2 var(--t2) linear var(--delay2) infinite reverse,
            drift2 var(--d2) ease-in-out var(--dd2) infinite alternate;
        }
        .gradient-layer-3 .gradient-content {
          background: conic-gradient(
            from var(--rot3) at var(--cx3) var(--cy3),
            /* c1 reduced arc and alpha already */ var(--c1) 0deg 28deg,
            transparent 28deg 332deg,
            var(--c1) 332deg 360deg
          );
          animation:
            spin3 var(--t3) linear var(--delay3) infinite,
            drift3 var(--d3) ease-in-out var(--dd3) infinite alternate;
        }
        .gradient-layer-4 .gradient-content {
          background: conic-gradient(
            from var(--rot4) at var(--cx4) var(--cy4),
            var(--c2) 0deg 30deg,
            transparent 30deg 330deg,
            var(--c2) 330deg 360deg
          );
          animation:
            spin4 var(--t4) linear var(--delay4) infinite reverse,
            drift4 var(--d4) ease-in-out var(--dd4) infinite alternate;
        }
        .gradient-layer-5 .gradient-content {
          background: conic-gradient(
            from var(--rot5) at var(--cx5) var(--cy5),
            /* c1 again but even smaller wedge */ var(--c1) 0deg 22deg,
            transparent 22deg 338deg,
            var(--c1) 338deg 360deg
          );
          animation:
            spin5 var(--t5) linear var(--delay5) infinite,
            drift5 var(--d5) ease-in-out var(--dd5) infinite alternate;
        }

        .radial-gradient-layer {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: radial-gradient(ellipse 120% 80% at 40% 60%, var(--c3) 0%, transparent 50%);
          filter: blur(var(--blur-amount)) contrast(var(--contrast-amount)) saturate(1.1);
        }
        .overlay-layer {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: radial-gradient(
            circle at 45% 55%,
            rgba(255, 255, 255, 0.1) 0%,
            rgba(255, 255, 255, 0.05) 30%,
            transparent 60%
          );
          mix-blend-mode: overlay;
        }

        @keyframes spin1 {
          from {
            --rot1: 0deg;
          }
          to {
            --rot1: 360deg;
          }
        }
        @keyframes spin2 {
          from {
            --rot2: 0deg;
          }
          to {
            --rot2: 360deg;
          }
        }
        @keyframes spin3 {
          from {
            --rot3: 0deg;
          }
          to {
            --rot3: 360deg;
          }
        }
        @keyframes spin4 {
          from {
            --rot4: 0deg;
          }
          to {
            --rot4: 360deg;
          }
        }
        @keyframes spin5 {
          from {
            --rot5: 0deg;
          }
          to {
            --rot5: 360deg;
          }
        }

        /* Center drift uses a gentle Lissajous-like path per layer */
        @keyframes drift1 {
          0% {
            --cx1: 30%;
            --cy1: 65%;
          }
          25% {
            --cx1: 42%;
            --cy1: 78%;
          }
          50% {
            --cx1: 58%;
            --cy1: 62%;
          }
          75% {
            --cx1: 36%;
            --cy1: 40%;
          }
          100% {
            --cx1: 30%;
            --cy1: 65%;
          }
        }
        @keyframes drift2 {
          0% {
            --cx2: 70%;
            --cy2: 35%;
          }
          40% {
            --cx2: 55%;
            --cy2: 30%;
          }
          60% {
            --cx2: 75%;
            --cy2: 50%;
          }
          100% {
            --cx2: 70%;
            --cy2: 35%;
          }
        }
        @keyframes drift3 {
          0% {
            --cx3: 65%;
            --cy3: 75%;
          }
          30% {
            --cx3: 75%;
            --cy3: 55%;
          }
          70% {
            --cx3: 45%;
            --cy3: 80%;
          }
          100% {
            --cx3: 65%;
            --cy3: 75%;
          }
        }
        @keyframes drift4 {
          0% {
            --cx4: 25%;
            --cy4: 25%;
          }
          50% {
            --cx4: 40%;
            --cy4: 35%;
          }
          100% {
            --cx4: 25%;
            --cy4: 25%;
          }
        }
        @keyframes drift5 {
          0% {
            --cx5: 80%;
            --cy5: 80%;
          }
          33% {
            --cx5: 70%;
            --cy5: 60%;
          }
          66% {
            --cx5: 85%;
            --cy5: 50%;
          }
          100% {
            --cx5: 80%;
            --cy5: 80%;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .gradient-layer .gradient-content {
            animation: none;
          }
        }
      `}</style>
    </div>
  )
}

const SiriOrb = React.memo(SiriOrbComponent)

export { SiriOrb }
